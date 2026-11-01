import * as vscode from 'vscode';
import { CodebaseSemanticIndexViewProvider, openPanel, buildAll } from './panelManager';
import { CodebaseSemanticIndexWorkerProvider } from './embeddingWorker';
import { CodebaseSemanticIndexTool } from './searchTool';
import { workspaceIndex } from './workspaceIndex';
import { isInsideWorkspaceRoot } from './utils';
import { PromptRefinementViewProvider, openPromptRefiner } from './promptRefiner';

interface GitRepository { state: { onDidChange(listener: () => void): vscode.Disposable } }
interface GitApi { repositories: GitRepository[]; onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable }

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		workspaceIndex,
		vscode.window.registerWebviewViewProvider(CodebaseSemanticIndexViewProvider.viewType,
			new CodebaseSemanticIndexViewProvider(context), { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider(PromptRefinementViewProvider.viewType,
			new PromptRefinementViewProvider(context), { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider(CodebaseSemanticIndexWorkerProvider.viewType,
			new CodebaseSemanticIndexWorkerProvider(context), { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('codebaseSemanticIndex.openPanel', openPanel),
		vscode.commands.registerCommand('codebaseSemanticIndex.refinePrompt', openPromptRefiner),
		vscode.commands.registerCommand('codebaseSemanticIndex.buildIndex', async () => { await openPanel(); await buildAll(); }),
		vscode.lm.registerTool('codebase_semantic_index_search', new CodebaseSemanticIndexTool()),
	);
	const scheduleAll = () => { for (const folder of vscode.workspace.workspaceFolders ?? []) { workspaceIndex.schedule(folder.uri); } };
	const changed = (uri: vscode.Uri) => {
		// Persisted cache writes must not trigger a perpetual rebuild loop.
		if (/\/(?:\.codebase-semantic-index|\.intellisearch)(?:\/|$)/.test(uri.path)) { return; }
		if (/\/\.git\//.test(uri.path) && !/\/\.git\/(?:HEAD|index|packed-refs|refs\/.*)$/.test(uri.path)) { return; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (isInsideWorkspaceRoot(uri, folder.uri)) { workspaceIndex.schedule(folder.uri); }
		}
	};
	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
		vscode.workspace.onDidChangeWorkspaceFolders(() => workspaceIndex.syncWorkspaceFolders()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (['files.exclude', 'search.exclude', 'codebaseSemanticIndex'].some(key => event.affectsConfiguration(key))) { scheduleAll(); }
		}),
		vscode.workspace.onDidChangeTextDocument(event => workspaceIndex.onDocumentChanged(event.document)),
		vscode.workspace.onDidSaveTextDocument(document => { workspaceIndex.onDocumentChanged(document); }),
		vscode.workspace.onDidCloseTextDocument(document => workspaceIndex.onDocumentClosed(document)),
	);
	// Git state is an optional notification source, not an input corpus or index identity.
	const git = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');
	if (git) {
		void git.activate().then(exports => {
			const api = exports.getAPI(1);
			const watch = (repository: GitRepository) => { context.subscriptions.push(repository.state.onDidChange(scheduleAll)); };
			api.repositories.forEach(watch);
			context.subscriptions.push(api.onDidOpenRepository(repository => { watch(repository); scheduleAll(); }));
		}, error => { console.warn('[Codebase Semantic Index] Git notifications unavailable:', error); });
	}
	workspaceIndex.syncWorkspaceFolders();
}
