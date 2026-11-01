import * as vscode from 'vscode';
import { createGitignoreFilter, IgnoreLayerSource } from './eligibility';

export * from './embeddingConfig';

/** These directories can never contribute retrieval evidence. */
export const ALWAYS_EXCLUDE = [
	'**/.codebase-semantic-index/**', '**/.intellisearch/**', '**/.git/**',
];

/** Disable individual defaults through codebaseSemanticIndex.exclude when these contain source. */
export const DEFAULT_EXCLUDE = [
	'**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**',
	'**/.next/**', '**/.nuxt/**', '**/.cache/**', '**/.venv/**', '**/venv/**',
	'**/__pycache__/**', '**/target/**', '**/vendor/**',
];

function rootPath(uri: vscode.Uri): string {
	return uri.path.replace(/\/+$/, '') || '/';
}

/** Identity preserves remote scheme/authority and URI query as well as the checkout path. */
export function workspaceKey(uri: vscode.Uri): string {
	return uri.with({ path: rootPath(uri), fragment: '' }).toString();
}

/** Relative source path only when the entire URI belongs to this root, never a sibling/root alias. */
export function relativeWorkspacePath(uri: vscode.Uri, workspaceUri: vscode.Uri): string | undefined {
	if (uri.scheme !== workspaceUri.scheme || uri.authority !== workspaceUri.authority
		|| uri.query !== workspaceUri.query) { return undefined; }
	const base = rootPath(workspaceUri);
	const prefix = base === '/' ? '/' : `${base}/`;
	if (!uri.path.startsWith(prefix) || uri.path === base) { return undefined; }
	const relative = uri.path.slice(prefix.length);
	if (!relative || relative.split('/').some(part => part === '..' || part === '.')) { return undefined; }
	return relative;
}

export function isInsideWorkspaceRoot(uri: vscode.Uri, workspaceUri: vscode.Uri): boolean {
	return relativeWorkspacePath(uri, workspaceUri) !== undefined;
}

function generatedExcludes(workspaceUri?: vscode.Uri): string[] {
	const overrides = vscode.workspace.getConfiguration('codebaseSemanticIndex', workspaceUri)
		.get<Record<string, boolean>>('exclude') ?? {};
	return [...new Set([
		...DEFAULT_EXCLUDE.filter(pattern => overrides[pattern] !== false),
		...Object.entries(overrides).filter(([, enabled]) => enabled === true).map(([pattern]) => pattern),
	])];
}

function combineGlobs(patterns: string[]): string {
	const unique = [...new Set(patterns)];
	return unique.length === 1 ? unique[0] : `{${unique.join(',')}}`;
}

/** Resource-scoped settings ensure one root cannot change another root's eligibility. */
export function buildExcludeGlob(workspaceUri?: vscode.Uri): string {
	const files = vscode.workspace.getConfiguration('files', workspaceUri).get<Record<string, unknown>>('exclude') ?? {};
	const search = vscode.workspace.getConfiguration('search', workspaceUri).get<Record<string, unknown>>('exclude') ?? {};
	return combineGlobs([
		...ALWAYS_EXCLUDE, ...generatedExcludes(workspaceUri),
		...Object.entries(files).filter(([, value]) => value === true).map(([pattern]) => pattern),
		...Object.entries(search).filter(([, value]) => value === true).map(([pattern]) => pattern),
	]);
}

/** Rebuild this snapshot when .gitignore files change; never use Git blobs or history. */
export async function buildGitignoreFilter(workspaceUri: vscode.Uri): Promise<(uri: vscode.Uri) => boolean> {
	const found = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspaceUri, '**/.gitignore'),
		combineGlobs([...ALWAYS_EXCLUDE, ...generatedExcludes(workspaceUri)]),
	);
	// Read the root explicitly even if it was excluded from enumeration by a provider.
	const candidates = new Map(found.map(uri => [uri.toString(), uri]));
	const rootIgnore = vscode.Uri.joinPath(workspaceUri, '.gitignore');
	candidates.set(rootIgnore.toString(), rootIgnore);
	const sources: IgnoreLayerSource[] = [];
	for (const uri of candidates.values()) {
		const relative = relativeWorkspacePath(uri, workspaceUri);
		if (relative === undefined) { continue; }
		try {
			const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			const slash = relative.lastIndexOf('/');
			sources.push({ base: slash === -1 ? '' : relative.slice(0, slash), contents });
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { continue; }
			// Failing closed is safer than silently exposing a file whose ignore rules could not be read.
			throw error;
		}
	}
	const ignored = createGitignoreFilter(sources);
	return uri => {
		const relative = relativeWorkspacePath(uri, workspaceUri);
		return relative === undefined || ignored(relative);
	};
}

export function base64ToFloat32(b64: string): Float32Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
	const aligned = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(aligned).set(bytes);
	return new Float32Array(aligned);
}
