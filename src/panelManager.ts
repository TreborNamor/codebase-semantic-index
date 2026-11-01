import * as vscode from 'vscode';
import { workspaceIndex, IndexStatus } from './workspaceIndex';
import { isEmbeddingModelReady, postWorkerStatus, waitForEmbeddingReady } from './embeddingWorker';
import { candidateExcerpt } from './retrieval';
import { isInsideWorkspaceRoot, workspaceKey } from './utils';
import panelHtml from './webview/panel.html';

let currentView: vscode.WebviewView | undefined;
let pendingAutoBuild = false;

export class CodebaseSemanticIndexViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'codebase-semantic-index.panel';
	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(workspaceIndex.onStatus(status => { void publishStatus(status); }));
	}
	resolveWebviewView(view: vscode.WebviewView): void {
		currentView = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = panelHtml.replace('__CSP_SOURCE__', view.webview.cspSource);
		view.webview.onDidReceiveMessage(msg => { void (async () => {
			await handleMessage(msg);
		})().catch(error => {
			view.webview.postMessage({ type: 'error', message: (error as Error).message });
		}); }, undefined, this.context.subscriptions);
		view.onDidDispose(() => { if (currentView === view) { currentView = undefined; } });
	}
}

async function publishStatus(changed?: IndexStatus): Promise<void> {
	const statuses = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => workspaceIndex.getStatus(folder.uri)));
	const chunkCount = statuses.reduce((n, status) => n + status.chunkCount, 0);
	const fileCount = statuses.reduce((n, status) => n + status.fileCount, 0);
	const lastBuild = Math.max(0, ...statuses.map(status => status.created ?? 0));
	postWorkerStatus({ type: 'indexStats', chunkCount, fileCount, lastFullBuild: lastBuild || null });
	currentView?.webview.postMessage({ type: 'loadIndex', chunkCount,
		message: statuses.map(status => status.message).filter(Boolean).join(' '), busy: statuses.some(status => status.busy) });
	if (changed?.message) { console.warn('[Codebase Semantic Index]', changed.rootUri, changed.message); }
}

export async function openPanel(): Promise<void> { await vscode.commands.executeCommand('codebase-semantic-index.panel.focus'); }
export function setPendingAutoBuild(value: boolean): void { pendingAutoBuild = value; }

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	switch (msg.type) {
		case 'webviewReady': {
			currentView?.webview.postMessage({ type: 'init', hasIndex: true, hasWorkspace: folders.length > 0, autoBuild: false });
			if (folders.length) { await publishStatus(); }
			if (pendingAutoBuild) { pendingAutoBuild = false; await buildAll(); }
			break;
		}
		case 'buildIndex': if (!folders.length) { throw new Error('No workspace folder is open.'); } await buildAll(); break;
		case 'searchQuery': {
			try {
				const response = await workspaceIndex.search(String(msg.query ?? ''), undefined, 5);
				const results = response.results.map(result => {
					const excerpt = candidateExcerpt(result.candidate);
					return { chunk: { file: result.candidate.file, rootUri: result.candidate.rootUri, rootName: result.candidate.rootName,
						range: excerpt.range, symbolName: result.candidate.symbolName, preview: excerpt.text }, score: result.score };
				});
				currentView?.webview.postMessage({ type: 'searchResults', results, message: response.statuses.join(' ') });
			} catch (error) { currentView?.webview.postMessage({ type: 'searchError', message: (error as Error).message }); }
			break;
		}
		case 'openFile': {
			const folder = folders.find(folder => workspaceKey(folder.uri) === msg.rootUri);
			if (!folder || typeof msg.file !== 'string') { throw new Error('Result workspace is no longer open. Search again.'); }
			const uri = vscode.Uri.joinPath(folder.uri, msg.file);
			if (!isInsideWorkspaceRoot(uri, folder.uri)) { throw new Error('Result is outside the workspace.'); }
			const start = Number(msg.start), end = Number(msg.end);
			const startCharacter = Number(msg.startCharacter ?? 0), endCharacter = Number(msg.endCharacter ?? 0);
			if (![start, end, startCharacter, endCharacter].every(n => Number.isInteger(n) && n >= 0) || end < start) { throw new Error('Invalid result range.'); }
			await vscode.commands.executeCommand('vscode.open', uri, {
				preview: true, selection: new vscode.Range(start, startCharacter, end, endCharacter),
			});
			break;
		}
	}
}

export async function buildAll(): Promise<void> {
	try {
		if (!isEmbeddingModelReady()) {
			currentView?.webview.postMessage({ type: 'modelLoading' });
			await waitForEmbeddingReady();
		}
		currentView?.webview.postMessage({ type: 'chunkStart', total: 1 });
		for (const folder of vscode.workspace.workspaceFolders ?? []) { await workspaceIndex.rebuild(folder.uri, true); }
		await publishStatus();
		const statuses = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => workspaceIndex.getStatus(folder.uri)));
		currentView?.webview.postMessage({ type: 'indexSaved', meta: { chunkCount: statuses.reduce((n, status) => n + status.chunkCount, 0) } });
	} catch (error) { currentView?.webview.postMessage({ type: 'error', message: (error as Error).message }); throw error; }
}
