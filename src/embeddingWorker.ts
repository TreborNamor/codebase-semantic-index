import * as vscode from 'vscode';
import { base64ToFloat32 } from './utils';
import { MODEL_NAME, MODEL_REVISION, QUERY_INSTRUCTION, VECTOR_DIM } from './embeddingConfig';
import workerHtml from './webview/worker.html';

let workerView: vscode.WebviewView | undefined;
let isModelReady = false;
let modelFailure: Error | undefined;
let requestSequence = 0;
let lastIndexStats: Record<string, unknown> | null = null;

const QUERY_TIMEOUT_MS = 60_000;
const BATCH_IDLE_TIMEOUT_MS = 120_000;

interface PendingRequest {
	type: 'embedQuery' | 'startEmbedding';
	payload: Record<string, unknown>;
	expectedCount: number;
	resolve: (vectors: Float32Array) => void;
	reject: (error: Error) => void;
	onProgress?: (done: number, total: number, file: string) => void;
	timer?: ReturnType<typeof setTimeout>;
	cancellation?: vscode.Disposable;
	sent: boolean;
	done: number;
}

/** Every reply is tied to its request, including batches from different roots. */
const requests = new Map<string, PendingRequest>();

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function postControlMessage(message: Record<string, unknown>): void {
	try {
		void workerView?.webview.postMessage(message).then(undefined, () => undefined);
	} catch { /* A disposed webview must not prevent settling pending promises. */ }
}

function finish(requestId: string, error?: Error, vectors?: Float32Array): void {
	const request = requests.get(requestId);
	if (!request) { return; }
	requests.delete(requestId);
	clearTimeout(request.timer);
	request.cancellation?.dispose();
	if (error) {
		if (request.sent) {
			postControlMessage({ type: 'cancelEmbedding', requestId });
		}
		request.reject(error);
	} else {
		request.resolve(vectors!);
	}
}

function rejectAll(error: Error): void {
	for (const requestId of [...requests.keys()]) { finish(requestId, error); }
}

function resetWatchdog(requestId: string): void {
	const request = requests.get(requestId);
	if (!request) { return; }
	clearTimeout(request.timer);
	const timeout = request.type === 'embedQuery' ? QUERY_TIMEOUT_MS : BATCH_IDLE_TIMEOUT_MS;
	request.timer = setTimeout(() => finish(requestId, new Error(
		request.type === 'embedQuery'
			? 'Query embedding timed out after 60 seconds. Current-file lexical search is still available.'
			: 'Batch embedding timed out after 120 seconds without progress. The index was not committed.',
	)), timeout);
}

function dispatch(requestId: string): void {
	const request = requests.get(requestId);
	if (!request || request.sent || !workerView || !isModelReady) { return; }
	request.sent = true;
	resetWatchdog(requestId);
	try {
		void workerView.webview.postMessage({ ...request.payload, type: request.type, requestId }).then(
			delivered => { if (!delivered) { finish(requestId, new Error('Embedding worker could not receive the request.')); } },
			error => finish(requestId, asError(error)),
		);
	} catch (error) { finish(requestId, asError(error)); }
}

function decodeAndValidate(encoded: unknown, count: number): Float32Array {
	if (typeof encoded !== 'string') { throw new Error('Embedding worker returned an invalid vector payload.'); }
	const vectors = base64ToFloat32(encoded);
	if (vectors.length !== count * VECTOR_DIM) {
		throw new Error(`Embedding dimension mismatch: expected ${count * VECTOR_DIM} values, received ${vectors.length}.`);
	}
	for (let i = 0; i < count; i++) {
		let norm = 0;
		for (let j = i * VECTOR_DIM; j < (i + 1) * VECTOR_DIM; j++) {
			if (!Number.isFinite(vectors[j])) { throw new Error(`Embedding ${i + 1} contains a non-finite value.`); }
			norm += vectors[j] * vectors[j];
		}
		if (Math.abs(Math.sqrt(norm) - 1) > 0.02) {
			throw new Error(`Embedding ${i + 1} is zero or is not normalized.`);
		}
	}
	return vectors;
}

function handleMessage(msg: Record<string, unknown>): void {
	if (msg.type === 'workerWebviewReady') {
		if (lastIndexStats) { postControlMessage(lastIndexStats); }
		return;
	}
	if (msg.type === 'modelReady') {
		isModelReady = true;
		modelFailure = undefined;
		for (const requestId of requests.keys()) { dispatch(requestId); }
		return;
	}
	if (msg.type === 'modelError') {
		isModelReady = false;
		modelFailure = new Error(`Embedding model failed to load: ${String(msg.message)}`);
		rejectAll(modelFailure);
		return;
	}
	const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
	const request = requests.get(requestId);
	if (!request || !request.sent) { return; }
	if (msg.type === 'embedProgress' && request.type === 'startEmbedding') {
		const done = Number(msg.done);
		if (!Number.isInteger(done) || done < request.done || done > request.expectedCount || msg.total !== request.expectedCount) {
			finish(requestId, new Error('Embedding worker returned invalid batch progress.'));
			return;
		}
		request.done = done;
		resetWatchdog(requestId);
		try { request.onProgress?.(done, request.expectedCount, String(msg.file ?? '')); }
		catch (error) { finish(requestId, asError(error)); }
		return;
	}
	if (msg.type === 'embedQueryError' || msg.type === 'embeddingError') {
		finish(requestId, new Error(String(msg.message ?? 'Embedding failed.')));
		return;
	}
	if ((msg.type === 'queryEmbedding' && request.type === 'embedQuery') ||
		(msg.type === 'embeddingsDone' && request.type === 'startEmbedding')) {
		try {
			finish(requestId, undefined, decodeAndValidate(msg.type === 'queryEmbedding' ? msg.vector : msg.vectors, request.expectedCount));
		} catch (error) { finish(requestId, asError(error)); }
	}
}

export class CodebaseSemanticIndexWorkerProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'codebase-semantic-index.worker';
	constructor(private readonly context: vscode.ExtensionContext) {}

	public resolveWebviewView(view: vscode.WebviewView): void {
		if (workerView && workerView !== view) { rejectAll(new Error('Embedding worker was replaced. Please retry.')); }
		workerView = view;
		isModelReady = false;
		modelFailure = undefined;
		const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'web');
		const webview = view.webview;
		webview.options = { enableScripts: true, localResourceRoots: [distUri] };
		webview.onDidReceiveMessage(msg => {
			if (workerView === view) { handleMessage(msg as Record<string, unknown>); }
		}, undefined, this.context.subscriptions);
		view.onDidDispose(() => {
			if (workerView !== view) { return; }
			rejectAll(new Error('Codebase Semantic Index embedding worker was closed.'));
			workerView = undefined;
			isModelReady = false;
			modelFailure = undefined;
		});
		const config = JSON.stringify({ model: MODEL_NAME, revision: MODEL_REVISION, dimension: VECTOR_DIM, queryInstruction: QUERY_INSTRUCTION }).replace(/</g, '\\u003c');
		webview.html = workerHtml
			.replaceAll('__CSP_SOURCE__', webview.cspSource)
			.replace('__TRANSFORMERS_URI__', webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'transformers.min.js')).toString())
			.replaceAll('__WASM_DIR_URI__', webview.asWebviewUri(distUri).toString() + '/')
			.replace('__EMBEDDING_CONFIG__', config);
	}
}

async function ensureWorkerView(): Promise<void> {
	if (!workerView) { await vscode.commands.executeCommand('codebase-semantic-index.worker.focus'); }
}

export function initEmbeddingWorker(): void {
	void ensureWorkerView().catch(error => console.error('[Codebase Semantic Index worker]', error));
}

function requestEmbedding(
	type: PendingRequest['type'], payload: Record<string, unknown>, expectedCount: number,
	onProgress?: PendingRequest['onProgress'], token?: vscode.CancellationToken,
): Promise<Float32Array> {
	if (token?.isCancellationRequested) { return Promise.reject(new vscode.CancellationError()); }
	if (modelFailure && workerView) { return Promise.reject(modelFailure); }
	return new Promise<Float32Array>((resolve, reject) => {
		const requestId = `${Date.now()}-${++requestSequence}`;
		const request: PendingRequest = { type, payload, expectedCount, resolve, reject, onProgress, sent: false, done: 0 };
		requests.set(requestId, request);
		resetWatchdog(requestId);
		request.cancellation = token?.onCancellationRequested(() => finish(requestId, new vscode.CancellationError()));
		if (!requests.has(requestId)) { request.cancellation?.dispose(); return; }
		void ensureWorkerView().then(() => dispatch(requestId), error => finish(requestId, asError(error)));
	});
}

/** Batch replies are all-or-nothing; failures never commit zero-filled vectors. */
export function embedBatch(
	chunks: Array<{ text: string; file: string }>,
	onProgress: (done: number, total: number, file: string) => void,
	token?: vscode.CancellationToken,
): Promise<Float32Array> {
	if (!chunks.length) {
		return token?.isCancellationRequested ? Promise.reject(new vscode.CancellationError()) : Promise.resolve(new Float32Array());
	}
	return requestEmbedding('startEmbedding', { chunks }, chunks.length, onProgress, token);
}

export function embedQuery(query: string, token?: vscode.CancellationToken): Promise<Float32Array> {
	return requestEmbedding('embedQuery', { query }, 1, undefined, token);
}

export function postWorkerStatus(msg: Record<string, unknown>): void {
	lastIndexStats = msg;
	postControlMessage(msg);
}
