import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RpcConnection} from './rpc';

const execFileAsync = promisify(execFile);
type Session = {session_id: string; control_token: string; mcp_token: string; generation: number; roots: unknown[]};
type ProjectStatus = {project_id: string; path: string; name: string; state: string; watch_owner?: string; indexed_files: number; chunks: number};
type EditorStatus = {generation: number; readiness: string; projects: ProjectStatus[]; confirmations: {request_id: string; action: string; project_ids: string[]}[]};

class Companion implements vscode.Disposable {
  private connection?: RpcConnection;
  private session?: Session;
  private connecting?: Promise<void>;
  private updates: Promise<void> = Promise.resolve();
  private disposed = false;
  private retry?: NodeJS.Timeout;
  private python = '';
  private home = '';
  private polling = false;
  private pollTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private watchers = new Map<string, vscode.Disposable>();
  private changes = new Map<string, Set<string> | null>();
  private shownConfirmations = new Set<string>();
  private definitions = new vscode.EventEmitter<void>();
  private output = vscode.window.createOutputChannel('CodeConverge');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.status.command = 'codeconverge.showStatus';
    this.status.text = '$(search) CodeConverge: Starting';
    this.status.show();
    this.disposables.push(this.output, this.status, this.definitions);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleUpdate()));
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleUpdate()));
    this.disposables.push(vscode.commands.registerCommand('codeconverge.refreshWorkspace', async () => {
      try { await this.connect(); await this.callTool('refresh_index'); await this.poll(); }
      catch (error) { this.recordError(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand('codeconverge.rebuildWorkspace', async () => {
      try { await this.connect(); await this.callTool('refresh_index', {full_rebuild: true}); await this.poll(); }
      catch (error) { this.recordError(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand('codeconverge.manageProjects', async () => {
      try {
        await this.connect();
        const result = await this.callTool('manage_index');
        const selected = await vscode.window.showQuickPick(result.projects.map((p: any) => ({
          label: `${p.active ? '$(lock)' : '$(database)'} ${p.name}`,
          description: `${(p.bytes / 1024 ** 2).toFixed(1)} MiB${p.active ? ' · Active' : ''}`,
          detail: p.path, project: p
        })), {title: 'CodeConverge: Cached Projects', placeHolder: 'Select an inactive project to request cache deletion'}) as {project: any} | undefined;
        if (!selected) return;
        if (selected.project.active) {
          void vscode.window.showInformationMessage('Close all windows using this project before deleting its index. Use Rebuild Workspace to refresh an active index.');
          return;
        }
        await this.callTool('manage_index', {action: 'delete', project_id: selected.project.project_id});
        await this.poll();
      } catch (error) { this.recordError(error); }
    }));
    this.disposables.push(vscode.commands.registerCommand('codeconverge.showStatus', async () => {
      try {
        await this.connect();
        this.output.appendLine(JSON.stringify(await this.callTool('index_status'), null, 2));
      } catch (error) { this.recordError(error); }
      this.output.show(true);
    }));
    this.disposables.push(vscode.commands.registerCommand('codeconverge.restoreCopilotToolLoading', async () => {
      const config = vscode.workspace.getConfiguration('chat.agentHost.copilot.toolSearch');
      if (this.context.globalState.get<boolean>('managedToolThreshold') && config.inspect<number>('deferThreshold')?.globalValue === 30) {
        await this.context.globalState.update('keepOriginalToolLoading', true);
        await config.update('deferThreshold', undefined, vscode.ConfigurationTarget.Global);
        this.output.appendLine('Restored the original Copilot tool-loading default; subagent tool schemas may require a compatible host.');
      }
      this.output.show(true);
    }));
    const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
      onDidChangeMcpServerDefinitions: this.definitions.event,
      provideMcpServerDefinitions: async () => {
        // A harness can consume the published launch directly. Publish only
        // after it contains this window's live capability; resolve() is not
        // the only place that must produce an authorized definition.
        await this.connect();
        return [this.definition()];
      },
      resolveMcpServerDefinition: async () => {
        await this.connect();
        return this.definition();
      }
    };
    this.disposables.push(vscode.lm.registerMcpServerDefinitionProvider('codeconverge', provider));
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      this.disposables.push(vscode.commands.registerCommand('codeconverge.test.status', async () => {
        await this.connect(); return this.callTool('index_status');
      }));
      this.disposables.push(vscode.commands.registerCommand('codeconverge.test.mcpDefinition', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        try {
          const definitions = await provider.provideMcpServerDefinitions(cancellation.token);
          return definitions?.[0];
        } finally { cancellation.dispose(); }
      }));
    }
    void this.connect().catch(error => this.recordError(error));
    this.pollTimer = setInterval(() => void this.poll().catch(error => this.recordError(error)), 3000);
  }

  private async configureCopilotToolLoading(): Promise<void> {
    // Copilot 0.72 defers even a three-tool child inventory at its default of
    // one. A threshold of 30 keeps large parent catalogs deferred and makes
    // small named subagent tool sets callable. Respect an explicit user choice.
    if (this.context.globalState.get<boolean>('keepOriginalToolLoading')) return;
    const config = vscode.workspace.getConfiguration('chat.agentHost.copilot.toolSearch');
    const value = config.inspect<number>('deferThreshold');
    if (!value || value.globalValue !== undefined || (value.defaultValue ?? 30) >= 30) return;
    await config.update('deferThreshold', 30, vscode.ConfigurationTarget.Global);
    await this.context.globalState.update('managedToolThreshold', true);
    this.output.appendLine('Set Copilot tool-deferral threshold to 30 once at user level for small subagents. Existing explicit user settings are preserved.');
  }

  private roots(): {path: string; name: string}[] {
    if (!vscode.workspace.isTrusted) return [];
    if (vscode.env.remoteName) throw new Error('This release supports local Windows workspaces; remote folders are not authorized.');
    return (vscode.workspace.workspaceFolders ?? []).map(folder => {
      if (folder.uri.scheme !== 'file') throw new Error('Only local file workspace folders are supported.');
      return {path: folder.uri.fsPath, name: folder.name};
    });
  }

  private async resolveRuntime(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('CodeConverge currently supports Windows only.');
    if (this.python) return;
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('LOCALAPPDATA is unavailable.');
    this.home = path.join(local, 'CodeConverge');
    const configured = vscode.workspace.getConfiguration('codeconverge').inspect<string>('runtimePath')?.globalValue;
    if (configured) this.python = configured;
    else {
      let manifest: string;
      try {
        manifest = await fs.readFile(path.join(this.home, 'installation.json'), 'utf8');
      } catch (error) {
        // Windows can virtualize AppData writes made by a packaged installer.
        // A user-profile pointer preserves the actual installed location across
        // packaged and ordinary VS Code launches, without a project setting.
        const profile = process.env.USERPROFILE;
        if (!profile) throw error;
        manifest = await fs.readFile(path.join(profile, '.codeconverge', 'installation.json'), 'utf8');
      }
      const installation = JSON.parse(manifest.replace(/^\uFEFF/, ''));
      if (installation.product !== 'CodeConverge') throw new Error('Invalid CodeConverge installation manifest.');
      this.python = installation.python;
      if (installation.home) this.home = installation.home;
    }
    if (!path.isAbsolute(this.python)) throw new Error('The installed runtime must be an absolute path.');
    if (!path.isAbsolute(this.home)) throw new Error('The application store must be an absolute installation path.');
  }

  private definition(): vscode.McpStdioServerDefinition {
    if (!this.session || !this.connection) throw new Error('No live editor session for MCP registration.');
    const env: Record<string, string> = {CODECONVERGE_HOME: this.home};
    env.CODECONVERGE_SESSION_ID = this.session.session_id;
    env.CODECONVERGE_SESSION_TOKEN = this.session.mcp_token;
    return new vscode.McpStdioServerDefinition('codeconverge', this.python, ['-I', '-m', 'codeconverge', 'mcp'], env, this.context.extension.packageJSON.version);
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error('CodeConverge companion has closed.');
    if (this.session && this.connection) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.establish().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async establish(): Promise<void> {
    await this.resolveRuntime();
    await this.configureCopilotToolLoading();
    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      const startupDelay = Number(process.env.CODECONVERGE_TEST_STARTUP_DELAY_MS ?? '0');
      if (startupDelay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(startupDelay, 2000)));
    }
    const roots = this.roots();
    const {stdout} = await execFileAsync(this.python, ['-I', '-m', 'codeconverge', 'ensure-engine'], {
      windowsHide: true, timeout: 20000, env: {...process.env, CODECONVERGE_HOME: this.home}
    });
    const info = JSON.parse(stdout.trim());
    this.connection = await RpcConnection.connect(info.pipe, () => {
      this.connection = undefined;
      this.session = undefined;
      if (!this.disposed) {
        this.clearWatchers();
        this.status.text = '$(warning) CodeConverge: Reconnecting';
        this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(error => this.recordError(error)); }, 2000);
      }
    });
    this.session = await this.connection.call('open_session', {roots, trusted: vscode.workspace.isTrusted});
    if (this.disposed) { this.connection.dispose(); return; }
    // A folder change may have occurred while Python started. Reconcile the
    // current API state before exposing the session to any MCP client.
    await this.updateSession();
    this.definitions.fire();
    this.output.appendLine(`Connected CodeConverge ${info.version}; ${this.session!.roots.length} authorized root(s).`);
  }

  private scheduleUpdate(): void {
    this.clearWatchers();
    this.updates = this.updates.then(async () => {
      await this.connect();
      await this.updateSession();
    }).catch(error => this.recordError(error));
  }

  private async updateSession(): Promise<void> {
    if (!this.session || !this.connection) return;
    const result = await this.connection.call('update_session', {
      session_id: this.session.session_id, control_token: this.session.control_token,
      roots: this.roots(), trusted: vscode.workspace.isTrusted
    });
    this.session = {...this.session, ...result};
    await this.poll();
  }

  private control(op: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.session || !this.connection) return Promise.reject(new Error('No editor session'));
    return this.connection.call(op, {session_id: this.session.session_id, control_token: this.session.control_token, ...args});
  }

  private async poll(): Promise<void> {
    if (!this.session || !this.connection || this.polling || this.disposed) return;
    this.polling = true;
    const sessionId = this.session.session_id;
    const generation = this.session.generation;
    try {
      const current = await this.control('editor_status') as EditorStatus;
      if (this.session?.session_id !== sessionId || this.session.generation !== generation || current.generation !== generation || this.disposed) return;
      const labels: Record<string, string> = {ready: 'Ready', indexing: 'Indexing', error: 'Error', untrusted_workspace: 'Workspace untrusted', no_active_workspace: 'No workspace'};
      this.status.text = `${current.readiness === 'indexing' ? '$(sync~spin)' : current.readiness === 'error' ? '$(error)' : '$(search)'} CodeConverge: ${labels[current.readiness] ?? current.readiness}`;
      this.status.tooltip = current.projects.map(p => `${p.name}: ${p.state}, ${p.indexed_files} files, ${p.chunks} chunks`).join('\n') || 'Open a trusted local folder to activate its index.';
      const owned = new Map(current.projects.filter(p => p.watch_owner === sessionId).map(p => [p.project_id, p]));
      for (const [id, watcher] of this.watchers) if (!owned.has(id)) {
        watcher.dispose(); this.watchers.delete(id); this.changes.delete(id);
      }
      for (const [id, project] of owned) if (!this.watchers.has(id)) this.watch(project);
      for (const request of current.confirmations) if (!this.shownConfirmations.has(request.request_id)) {
        this.shownConfirmations.add(request.request_id);
        void this.confirmMaintenance(request, sessionId, generation).catch(error => this.recordError(error));
      }
    } finally { this.polling = false; }
  }

  private watch(project: ProjectStatus): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project.path), '**/*'));
    const changed = (uri: vscode.Uri) => {
      const relative = path.relative(project.path, uri.fsPath).replace(/\\/g, '/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return;
      if (relative.split('/').some(p => ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'coverage'].includes(p))) return;
      if (!this.changes.has(project.project_id)) this.changes.set(project.project_id, new Set());
      const pending = this.changes.get(project.project_id);
      if (pending) {
        pending.add(relative);
        if (pending.size > 1000) this.changes.set(project.project_id, null);
      }
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => void this.flushChanges().catch(error => this.recordError(error)), 500);
    };
    const events = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];
    this.watchers.set(project.project_id, vscode.Disposable.from(watcher, ...events));
    // Reconcile the short gap before a watcher is established or ownership
    // moves between windows. Existing content hashes prevent re-embedding.
    this.changes.set(project.project_id, null);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flushChanges().catch(error => this.recordError(error)), 500);
  }

  private async flushChanges(): Promise<void> {
    this.flushTimer = undefined;
    const pending = [...this.changes];
    this.changes.clear();
    try { for (const [projectId, paths] of pending) if (this.watchers.has(projectId)) {
      try { await this.control('file_events', {project_id: projectId, paths: paths ? [...paths] : null}); }
      catch (error) {
        // A missed pipe event must not strand a saved edit until the periodic
        // scan. Retry a bounded full reconciliation after reconnecting.
        if (this.watchers.has(projectId)) this.changes.set(projectId, null);
        throw error;
      }
    } } finally {
      if (this.changes.size) this.flushTimer = setTimeout(() => void this.flushChanges().catch(error => this.recordError(error)), 2000);
    }
  }

  private async confirmMaintenance(request: {request_id: string; action: string; project_ids: string[]}, sessionId: string, generation: number): Promise<void> {
    const action = request.action === 'rebuild' ? 'Rebuild' : 'Delete cached indexes';
    const inventory = await this.callTool('manage_index');
    const labels = request.project_ids.map(id => {
      const project = inventory.projects.find((p: any) => p.project_id === id);
      return project ? `${project.name}\n${project.path}\n${id}` : id;
    });
    const accepted = await vscode.window.showWarningMessage(`${action} for ${request.project_ids.length} project(s)?`, {
      modal: true, detail: `Projects:\n${labels.join('\n\n')}\n\n${request.action === 'rebuild' ? 'Recreates the current workspace index and reuses cached embeddings.' : 'Deletes only these inactive derived indexes. Source files and the shared model are preserved.'}`
    }, action);
    if (this.session?.session_id !== sessionId || this.session.generation !== generation) return;
    const result = await this.control('confirm_maintenance', {request_id: request.request_id, approved: accepted === action});
    this.output.appendLine(JSON.stringify(result));
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear(); this.changes.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private callTool(tool: string, arguments_: Record<string, unknown> = {}): Promise<any> {
    if (!this.session || !this.connection) return Promise.reject(new Error('No editor session'));
    return this.connection.call('call_tool', {session_id: this.session.session_id, token: this.session.mcp_token, tool, arguments: arguments_});
  }

  private recordError(error: unknown): void {
    this.status.text = '$(error) CodeConverge: Error';
    this.status.tooltip = String(error);
    this.output.appendLine(String(error));
    if (!this.disposed && !this.connection && !this.retry) this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect().catch(problem => this.recordError(problem));
    }, 3000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.clearWatchers();
    this.connection?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new Companion(context));
}
