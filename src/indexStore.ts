import * as vscode from 'vscode';
import { IndexData, LoadedIndex } from './types';
import { MODEL_NAME, MODEL_REVISION, PIPELINE_ID, VECTOR_DIM } from './embeddingConfig';
import { CHUNKER_VERSION } from './chunker';
import { workspaceKey } from './utils';
import { hashBytes } from './fingerprints';

export const INDEX_VERSION = 2;
const FOLDER = '.codebase-semantic-index';
const MANIFEST = 'index.json';
const enc = new TextEncoder();
const dec = new TextDecoder();
const generationPattern = /^[a-zA-Z0-9-]+$/;
const hashPattern = /^[a-f0-9]{64}$/;

export class IndexCompatibilityError extends Error {}

function dir(root: vscode.Uri): vscode.Uri { return vscode.Uri.joinPath(root, FOLDER); }
function safeFile(file: string): boolean {
	return !!file && !file.startsWith('/') && !file.includes('\\') && !file.includes(':') &&
		!file.split('/').some(part => part === '..' || part === '.' || part === '');
}

export function validateIndex(root: vscode.Uri, index: LoadedIndex): void {
	const { data, vectors } = index;
	const meta = data?.meta;
	if (!meta || meta.version !== INDEX_VERSION || meta.rootUri !== workspaceKey(root) ||
		meta.model !== MODEL_NAME || meta.modelRevision !== MODEL_REVISION || meta.pipelineId !== PIPELINE_ID ||
		meta.chunkerVersion !== CHUNKER_VERSION || meta.vectorDim !== VECTOR_DIM ||
		!generationPattern.test(meta.generation) || !Number.isFinite(meta.created)) {
		throw new IndexCompatibilityError('Index belongs to another workspace or embedding/chunker version. Rebuild required.');
	}
	if (!Array.isArray(data.chunks) || !data.files || typeof data.files !== 'object' ||
		meta.chunkCount !== data.chunks.length || vectors.length !== data.chunks.length * VECTOR_DIM) {
		throw new IndexCompatibilityError('Index metadata and vectors do not match. Rebuild required.');
	}
	for (const [file, record] of Object.entries(data.files)) {
		if (!safeFile(file) || !record || !hashPattern.test(record.hash)) {
			throw new IndexCompatibilityError('Invalid file manifest. Rebuild required.');
		}
	}
	for (const [i, chunk] of data.chunks.entries()) {
		const r = chunk.range;
		if (!safeFile(chunk.file) || !Object.hasOwn(data.files, chunk.file) || !r ||
			!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end < r.start ||
			![r.startCharacter ?? 0, r.endCharacter ?? 0].every(n => Number.isInteger(n) && n >= 0) ||
			(r.start === r.end && r.endCharacter !== undefined && r.endCharacter < (r.startCharacter ?? 0)) ||
			typeof chunk.preview !== 'string' || (chunk.symbolName !== undefined && typeof chunk.symbolName !== 'string') ||
			chunk.vectorOffset !== i * VECTOR_DIM || !hashPattern.test(chunk.contentHash) || !hashPattern.test(chunk.embeddingHash)) {
			throw new IndexCompatibilityError('Invalid source chunk metadata. Rebuild required.');
		}
		let norm = 0;
		for (const value of vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM)) {
			if (!Number.isFinite(value)) { throw new IndexCompatibilityError('Index contains non-finite embeddings. Rebuild required.'); }
			norm += value * value;
		}
		if (Math.abs(norm - 1) > 0.05) { throw new IndexCompatibilityError('Index contains invalid embeddings. Rebuild required.'); }
	}
}

async function readPointer(root: vscode.Uri): Promise<{ generation: string; dataHash: string; vectorHash: string } | null> {
	let bytes: Uint8Array;
	try { bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir(root), MANIFEST)); }
	catch (error) {
		if ((error as { code?: string }).code === 'FileNotFound') { return null; }
		throw error;
	}
	const pointer = JSON.parse(dec.decode(bytes)) as { generation: string; version: number; dataHash: string; vectorHash: string };
	if (pointer.version !== INDEX_VERSION || !generationPattern.test(pointer.generation) || !hashPattern.test(pointer.dataHash) || !hashPattern.test(pointer.vectorHash)) {
		throw new IndexCompatibilityError('Legacy or incomplete index. Rebuild required.');
	}
	return pointer;
}

/** Read immutable generation files through one committed pointer. Never mix pairs. */
export async function loadIndex(root: vscode.Uri): Promise<LoadedIndex | null> {
	try {
		const pointer = await readPointer(root);
		if (!pointer) {
			try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, '.intellisearch', 'index.json')); }
			catch (error) { if ((error as { code?: string }).code === 'FileNotFound') { return null; } throw error; }
			throw new IndexCompatibilityError('Legacy index found. Rebuild required from current workspace files.');
		}
		const [json, bin] = await Promise.all([
			vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir(root), pointer.generation + '.json')),
			vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir(root), pointer.generation + '.bin')),
		]);
		if (await hashBytes(json) !== pointer.dataHash || await hashBytes(bin) !== pointer.vectorHash) {
			throw new Error('Index integrity checksum mismatch');
		}
		if (bin.byteLength % 4 !== 0) { throw new Error('Unaligned vector data'); }
		const aligned = new Uint8Array(bin.byteLength);
		aligned.set(bin);
		const data = JSON.parse(dec.decode(json)) as IndexData;
		if (data.meta?.generation !== pointer.generation) { throw new Error('Index generation mismatch'); }
		const loaded = { data, vectors: new Float32Array(aligned.buffer) };
		validateIndex(root, loaded);
		return loaded;
	} catch (error) {
		if (error instanceof IndexCompatibilityError) { throw error; }
		throw new IndexCompatibilityError(`Cannot load index: ${(error as Error).message}. Rebuild required.`);
	}
}

export async function saveIndex(root: vscode.Uri, data: IndexData, vectors: Float32Array): Promise<void> {
	validateIndex(root, { data, vectors });
	await vscode.workspace.fs.createDirectory(dir(root));
	const generation = data.meta.generation;
	const json = enc.encode(JSON.stringify(data));
	const binary = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
	const [dataHash, vectorHash] = await Promise.all([hashBytes(json), hashBytes(binary)]);
	await Promise.all([
		vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir(root), generation + '.json'), json),
		vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir(root), generation + '.bin'), binary),
	]);
	const temp = vscode.Uri.joinPath(dir(root), generation + '.pending');
	await vscode.workspace.fs.writeFile(temp, enc.encode(JSON.stringify({ version: INDEX_VERSION, generation, dataHash, vectorHash })));
	await vscode.workspace.fs.rename(temp, vscode.Uri.joinPath(dir(root), MANIFEST), { overwrite: true });
	// Other VS Code windows can be staging or reading generations in this folder.
	// Do not prune them during live writes without a cross-window lease protocol.
}

export async function indexExists(root: vscode.Uri): Promise<boolean> {
	try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir(root), MANIFEST)); return true; }
	catch { return false; }
}
