import * as vscode from 'vscode';
import { chunkDocument, chunkText, CHUNKER_VERSION, isIndexable, RawChunk } from './chunker';
import { embedBatch, embedQuery, isEmbeddingModelReady, waitForEmbeddingReady } from './embeddingWorker';
import { MODEL_NAME, MODEL_REVISION, PIPELINE_ID, VECTOR_DIM } from './embeddingConfig';
import { hashText } from './fingerprints';
import { INDEX_VERSION, loadIndex, saveIndex } from './indexStore';
import { buildExcludeGlob, buildGitignoreFilter, isInsideWorkspaceRoot, relativeWorkspacePath, workspaceKey } from './utils';
import { Chunk, IndexData, LoadedIndex, SourceRange } from './types';
import { matchesPathPrefix, normalizeMaxResults, normalizePathPrefix, rankCandidates, RankedCandidate, RetrievalCandidate } from './retrieval';
import { ReconcileQueue } from './reconcileQueue';

interface Snapshot { uri: vscode.Uri; file: string; text: string; hash: string; dirty: boolean; version?: number }
interface Overlay { hash: string; chunks: RawChunk[]; vectors?: Float32Array; pending?: Promise<void> }
interface RootState {
	root: vscode.Uri;
	index: LoadedIndex | null;
	loaded: Promise<void>;
	queue: ReconcileQueue;
	status?: string;
	removed: boolean;
	lastBuild?: number;
	cancellation: vscode.CancellationTokenSource;
}
export interface IndexStatus { rootUri: string; chunkCount: number; fileCount: number; busy: boolean; message?: string; created?: number }
export interface SearchResponse { results: RankedCandidate[]; statuses: string[] }
const MAX_FILE_BYTES = 1024 * 1024;

function cancelled(token?: vscode.CancellationToken): void {
	if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
}

/** All persisted offsets are checked against source content before they become evidence. */
export function sourceSlice(text: string, range: SourceRange): string | undefined {
	const lines = text.split(/\r\n|\r|\n/);
	if (range.start < 0 || range.end >= lines.length || range.end < range.start) { return undefined; }
	const start = range.startCharacter ?? 0;
	const end = range.endCharacter ?? lines[range.end].length;
	if (start > lines[range.start].length || end > lines[range.end].length || (range.start === range.end && end < start)) { return undefined; }
	// Offsets retain original line endings instead of normalizing source text.
	const starts = [0];
	const newlines = /\r\n|\r|\n/g;
	let match: RegExpExecArray | null;
	while ((match = newlines.exec(text))) { starts.push(match.index + match[0].length); }
	return text.slice(starts[range.start] + start, starts[range.end] + end);
}

export class WorkspaceIndexService implements vscode.Disposable {
	private readonly roots = new Map<string, RootState>();
	private readonly overlays = new Map<string, Overlay>();
	private readonly listeners = new Set<(status: IndexStatus) => void>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private disposed = false;
	private active(root: vscode.Uri): boolean {
		return !this.disposed && (vscode.workspace.workspaceFolders ?? []).some(folder => workspaceKey(folder.uri) === workspaceKey(root));
	}

	onStatus(listener: (status: IndexStatus) => void): vscode.Disposable {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	private state(root: vscode.Uri): RootState {
		const key = workspaceKey(root);
		let state = this.roots.get(key);
		if (state) { return state; }
		state = { root, index: null, loaded: Promise.resolve(), queue: undefined!, removed: false, cancellation: new vscode.CancellationTokenSource() };
		const created = state;
		created.queue = new ReconcileQueue(force => this.reconcile(created, force));
		created.loaded = loadIndex(root).then(index => { created.index = index; }).catch(error => {
			created.status = (error as Error).message;
		}).then(() => { this.emit(created); });
		this.roots.set(key, created);
		return created;
	}

	private emit(state: RootState): void {
		if (this.disposed || state.removed) { return; }
		const status: IndexStatus = {
			rootUri: workspaceKey(state.root), chunkCount: state.index?.data.chunks.length ?? 0,
			fileCount: Object.keys(state.index?.data.files ?? {}).length, busy: state.queue.busy,
			message: state.status, created: state.index?.data.meta.created,
		};
		for (const listener of this.listeners) { listener(status); }
	}

	async getStatus(root: vscode.Uri): Promise<IndexStatus> {
		const state = this.state(root);
		await state.loaded;
		return { rootUri: workspaceKey(root), chunkCount: state.index?.data.chunks.length ?? 0,
			fileCount: Object.keys(state.index?.data.files ?? {}).length, busy: state.queue.busy,
			message: state.status, created: state.index?.data.meta.created };
	}

	/** Startup, checkout and settings changes reconcile actual files, never historical blobs. */
	syncWorkspaceFolders(reconcile = isEmbeddingModelReady()): void {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const active = new Set(folders.map(folder => workspaceKey(folder.uri)));
		for (const [key, timer] of this.timers) {
			if (!active.has(key)) { clearTimeout(timer); this.timers.delete(key); }
		}
		for (const [key, state] of this.roots) {
			if (!active.has(key)) {
				state.removed = true; state.cancellation.cancel(); state.cancellation.dispose(); state.queue.dispose(); this.roots.delete(key);
				for (const overlayKey of this.overlays.keys()) { if (overlayKey.startsWith(key + '|')) { this.overlays.delete(overlayKey); } }
			}
		}
		if (reconcile) { for (const folder of folders) { this.schedule(folder.uri); } }
	}

	schedule(root: vscode.Uri, delay = 300): void {
		// File events must not initialize the large local model during editor startup.
		if (!this.active(root) || !isEmbeddingModelReady()) { return; }
		const key = workspaceKey(root);
		const previous = this.timers.get(key);
		if (previous) { clearTimeout(previous); }
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			void this.rebuild(root).catch(() => { /* Status carries the failure; pending work is retained. */ });
		}, delay));
	}

	async rebuild(root: vscode.Uri, force = false): Promise<void> {
		if (!this.active(root)) { return; }
		const state = this.state(root);
		try {
			await state.loaded;
			await waitForEmbeddingReady(state.cancellation.token);
			if (!this.active(root) || state.removed) { return; }
			await state.queue.request(force);
		}
		catch (error) { state.status = `Index update failed: ${(error as Error).message}. Current-file lexical search remains available.`; throw error; }
		finally { this.emit(state); }
	}

	onDocumentChanged(document: vscode.TextDocument): void {
		this.onDocumentClosed(document);
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (isInsideWorkspaceRoot(document.uri, folder.uri)) { this.schedule(folder.uri); }
		}
	}

	onDocumentClosed(document: vscode.TextDocument): void {
		for (const key of this.overlays.keys()) { if (key.endsWith('|' + document.uri.toString())) { this.overlays.delete(key); } }
	}

	private async eligible(root: vscode.Uri): Promise<vscode.Uri[]> {
		const [files, ignored] = await Promise.all([
			vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), buildExcludeGlob(root)),
			buildGitignoreFilter(root),
		]);
		return files.filter(uri => isInsideWorkspaceRoot(uri, root) && isIndexable(uri) && !ignored(uri));
	}

	private async read(uri: vscode.Uri, root: vscode.Uri, useDirty: boolean, attempt = 0): Promise<Snapshot | undefined> {
		try {
			if (!isInsideWorkspaceRoot(uri, root)) { return undefined; }
			const stat = await vscode.workspace.fs.stat(uri);
			if (!(stat.type & vscode.FileType.File) || (stat.type & vscode.FileType.SymbolicLink) || stat.size > MAX_FILE_BYTES) { return undefined; }
			// A link in a descendant directory can point at another checkout even when the leaf is a normal file.
			let parent = vscode.Uri.joinPath(uri, '..');
			while (isInsideWorkspaceRoot(parent, root)) {
				if ((await vscode.workspace.fs.stat(parent)).type & vscode.FileType.SymbolicLink) { return undefined; }
				parent = vscode.Uri.joinPath(parent, '..');
			}
			const document = useDirty ? vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && doc.isDirty) : undefined;
			const version = document?.version;
			const text = document ? document.getText() : new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
			if (text.includes('\0') || text.length > MAX_FILE_BYTES) { return undefined; }
			const hash = await hashText(text);
			if (useDirty) {
				const current = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
				if (current !== document || current?.version !== version || document?.isClosed) {
					return attempt < 2 ? this.read(uri, root, useDirty, attempt + 1) : undefined;
				}
			}
			return { uri, file: relativeWorkspacePath(uri, root)!, text, hash, dirty: !!document, version };
		} catch { return undefined; } // Deleted, inaccessible or binary files are never evidence.
	}

	private async chunks(snapshot: Snapshot, root: vscode.Uri): Promise<RawChunk[]> {
		try {
			const doc = await vscode.workspace.openTextDocument(snapshot.uri);
			if (doc.getText() === snapshot.text) {
				const chunks = await chunkDocument(doc, root);
				if (chunks.every(chunk => sourceSlice(snapshot.text, chunk.range) === chunk.text)) { return chunks; }
			}
		} catch { /* Language service unavailable; bounded full-coverage chunks still work. */ }
		return chunkText(snapshot.text, snapshot.file);
	}

	private async reconcile(state: RootState, force: boolean): Promise<void> {
		await state.loaded;
		if (!this.active(state.root) || state.removed) { return; }
		this.emit(state);
		const files = await this.eligible(state.root);
		const old = state.index;
		const manifests: IndexData['files'] = Object.create(null) as IndexData['files'];
		const chunks: Chunk[] = [];
		const vectors: Float32Array[] = [];
		const cache = new Map<string, Float32Array>();
		if (!force && old) {
			for (const chunk of old.data.chunks) {
				cache.set(chunk.embeddingHash, old.vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM));
			}
		}
		const pending: Array<{ raw: RawChunk; contentHash: string; embeddingHash: string; payload: string }> = [];
		let needsAnotherPass = false;
		for (const uri of files) {
			if (!this.active(state.root) || state.removed) { return; }
			const snapshot = await this.read(uri, state.root, false);
			if (!snapshot) { continue; }
			manifests[snapshot.file] = { hash: snapshot.hash };
			if (!force && old?.data.files[snapshot.file]?.hash === snapshot.hash) {
				for (const chunk of old.data.chunks.filter(c => c.file === snapshot.file)) {
					chunks.push({ ...chunk, vectorOffset: vectors.length * VECTOR_DIM });
					vectors.push(old.vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM));
				}
				continue;
			}
			for (const raw of await this.chunks(snapshot, state.root)) {
				const payload = [raw.file, raw.symbolName, raw.context, raw.text].filter(Boolean).join('\n');
				pending.push({ raw, payload, contentHash: await hashText(raw.text), embeddingHash: await hashText(payload) });
			}
		}
		const missing = pending.filter(chunk => !cache.has(chunk.embeddingHash));
		if (!this.active(state.root) || state.removed) { return; }
		if (missing.length) {
			const embedded = await embedBatch(missing.map(chunk => ({ text: chunk.payload, file: chunk.raw.file })), () => { this.emit(state); }, state.cancellation.token);
			for (let i = 0; i < missing.length; i++) {
				cache.set(missing[i].embeddingHash, embedded.slice(i * VECTOR_DIM, (i + 1) * VECTOR_DIM));
			}
		}
		for (const item of pending) {
			chunks.push({ file: item.raw.file, range: item.raw.range, preview: item.raw.preview, symbolName: item.raw.symbolName,
				contentHash: item.contentHash, embeddingHash: item.embeddingHash, vectorOffset: vectors.length * VECTOR_DIM });
			vectors.push(cache.get(item.embeddingHash)!);
		}
		// A checkout/edit may complete during a slow embedding call, even with no delivered watcher event.
		const currentFiles = await this.eligible(state.root);
		const currentSet = new Set<string>();
		for (const uri of currentFiles) {
			const snapshot = await this.read(uri, state.root, false);
			if (snapshot) { currentSet.add(snapshot.file); if (manifests[snapshot.file]?.hash !== snapshot.hash) { needsAnotherPass = true; } }
		}
		if (Object.keys(manifests).some(file => !currentSet.has(file))) { needsAnotherPass = true; }
		if (!this.active(state.root) || state.removed) { return; }
		const changed = force || !old || pending.length > 0 ||
			JSON.stringify(Object.keys(manifests).sort().map(file => [file, manifests[file].hash])) !==
			JSON.stringify(Object.keys(old.data.files).sort().map(file => [file, old.data.files[file].hash]));
		if (changed) {
			const packed = new Float32Array(vectors.length * VECTOR_DIM);
			vectors.forEach((vector, i) => packed.set(vector, i * VECTOR_DIM));
			const data: IndexData = { files: manifests, chunks, meta: {
				version: INDEX_VERSION, model: MODEL_NAME, modelRevision: MODEL_REVISION, pipelineId: PIPELINE_ID,
				chunkerVersion: CHUNKER_VERSION, rootUri: workspaceKey(state.root),
				generation: Date.now().toString(36) + '-' + crypto.randomUUID(), created: Date.now(),
				chunkCount: chunks.length, vectorDim: VECTOR_DIM,
			} };
			await saveIndex(state.root, data, packed);
			state.index = { data, vectors: packed };
		}
		state.status = undefined;
		state.lastBuild = Date.now();
		if (needsAnotherPass) { void state.queue.request().catch(() => {}); }
	}

	private overlay(snapshot: Snapshot, root: vscode.Uri): Overlay {
		const key = workspaceKey(root) + '|' + snapshot.uri.toString();
		const existing = this.overlays.get(key);
		if (existing?.hash === snapshot.hash) { return existing; }
		const overlay: Overlay = { hash: snapshot.hash, chunks: chunkText(snapshot.text, snapshot.file) };
		this.overlays.set(key, overlay);
		if (snapshot.dirty) {
			overlay.pending = embedBatch(overlay.chunks.map(chunk => ({ text: [chunk.file, chunk.text].join('\n'), file: chunk.file })), () => {}, this.state(root).cancellation.token)
				.then(vectors => { if (this.overlays.get(key) === overlay) { overlay.vectors = vectors; } })
				.catch(error => { const state = this.roots.get(workspaceKey(root)); if (state) { state.status = `Unsaved-file embedding failed: ${(error as Error).message}; lexical matches remain available.`; this.emit(state); } });
		}
		return overlay;
	}

	async search(query: string, pathPrefix?: string, maxResults?: number, token?: vscode.CancellationToken): Promise<SearchResponse> {
		const prefix = normalizePathPrefix(pathPrefix);
		const statuses = new Set<string>();
		const candidates: RetrievalCandidate[] = [];
		const staleRoots = new Set<vscode.Uri>();
		const folders = [...(vscode.workspace.workspaceFolders ?? [])];
		cancelled(token);
		for (const folder of folders) {
			const state = this.state(folder.uri);
			await state.loaded;
			const files = await this.eligible(folder.uri);
			let stale = !state.index;
			for (const uri of files) {
				cancelled(token);
				const file = relativeWorkspacePath(uri, folder.uri)!;
				if (!matchesPathPrefix(file, prefix)) { continue; }
				const snapshot = await this.read(uri, folder.uri, true);
				if (!snapshot) { continue; }
				const indexed = state.index;
				const matched = indexed?.data.files[file]?.hash === snapshot.hash;
				let valid = !!matched;
				const local: RetrievalCandidate[] = [];
				if (matched && indexed) {
					for (const chunk of indexed.data.chunks.filter(chunk => chunk.file === file)) {
						const text = sourceSlice(snapshot.text, chunk.range);
						if (text === undefined || await hashText(text) !== chunk.contentHash) { valid = false; break; }
						local.push({ file, range: chunk.range, symbolName: chunk.symbolName, text,
							vector: indexed.vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM),
							rootUri: workspaceKey(folder.uri), contentHash: snapshot.hash });
					}
				}
				if (valid) { candidates.push(...local); }
				else {
					stale = true;
					const overlay = this.overlay(snapshot, folder.uri);
					for (const [i, chunk] of overlay.chunks.entries()) {
						candidates.push({ file, range: chunk.range, text: chunk.text, symbolName: chunk.symbolName,
							vector: overlay.vectors?.subarray(i * VECTOR_DIM, (i + 1) * VECTOR_DIM),
							rootUri: workspaceKey(folder.uri), contentHash: snapshot.hash });
					}
				}
			}
			if (state.status) { statuses.add(state.status); }
			if (stale) { statuses.add('Current-file lexical fallback is active for changed/unindexed files.'); staleRoots.add(folder.uri); }
		}
		let queryVector: Float32Array | undefined;
		if (candidates.some(candidate => candidate.vector)) {
			const timeout = new vscode.CancellationTokenSource();
			const subscription = token?.onCancellationRequested(() => timeout.cancel());
			const timer = setTimeout(() => timeout.cancel(), 2500);
			try { queryVector = await embedQuery(query, timeout.token); }
			catch (error) { cancelled(token); statuses.add(`Semantic query unavailable; using current-file lexical search: ${(error as Error).message}`); }
			finally { clearTimeout(timer); subscription?.dispose(); timeout.dispose(); }
		}
		for (const root of staleRoots) { this.schedule(root); }
		cancelled(token);
		const ranked = rankCandidates(candidates, query, queryVector, 20);
		const verified = await this.verify(ranked, token);
		const limit = normalizeMaxResults(maxResults);
		return { results: verified.slice(0, limit), statuses: [...statuses] };
	}

	/** Recheck after model/tokenizer awaits; never serve a removed root, stale range or ignored file. */
	async verify(results: RankedCandidate[], token?: vscode.CancellationToken): Promise<RankedCandidate[]> {
		const verified: RankedCandidate[] = [];
		const eligibility = new Map<string, Set<string>>();
		for (const result of results) {
			cancelled(token);
			const root = (vscode.workspace.workspaceFolders ?? []).find(folder => workspaceKey(folder.uri) === result.candidate.rootUri)?.uri;
			if (!root) { continue; }
			if (!eligibility.has(result.candidate.rootUri)) {
				eligibility.set(result.candidate.rootUri, new Set((await this.eligible(root)).map(uri => uri.toString())));
			}
			const uri = vscode.Uri.joinPath(root, result.candidate.file);
			if (!eligibility.get(result.candidate.rootUri)!.has(uri.toString())) { this.schedule(root); continue; }
			const snapshot = await this.read(uri, root, true);
			if (!snapshot || snapshot.hash !== result.candidate.contentHash || sourceSlice(snapshot.text, result.candidate.range) !== result.candidate.text) {
				this.schedule(root); continue;
			}
			verified.push(result);
		}
		return verified;
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) { clearTimeout(timer); }
		for (const state of this.roots.values()) { state.removed = true; state.cancellation.cancel(); state.cancellation.dispose(); state.queue.dispose(); }
		this.timers.clear(); this.roots.clear(); this.overlays.clear(); this.listeners.clear();
	}
}

export const workspaceIndex = new WorkspaceIndexService();
