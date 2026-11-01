import * as vscode from 'vscode';
import { relativeWorkspacePath } from './utils';
import { splitSource, SourceSymbol } from './chunkCoverage';

/** Increment when chunk boundaries or embedding context change. */
export const CHUNKER_VERSION = 2;

const INDEXABLE_EXT = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
	'.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.php', '.lua',
	'.vue', '.svelte', '.md', '.mdx', '.rst', '.txt',
	'.json', '.yaml', '.yml', '.toml', '.xml',
	'.sh', '.bash', '.zsh', '.fish', '.css', '.scss', '.less', '.sql',
]);
const EXCLUDED_FILENAMES = new Set([
	'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
	'bun.lock', 'composer.lock', 'gemfile.lock', 'cargo.lock', 'poetry.lock',
	'pipfile.lock', 'packages.lock.json',
]);

export function isIndexable(uri: vscode.Uri): boolean {
	const filename = uri.path.slice(uri.path.lastIndexOf('/') + 1).toLowerCase();
	if (EXCLUDED_FILENAMES.has(filename)) { return false; }
	const dot = filename.lastIndexOf('.');
	return dot !== -1 && INDEXABLE_EXT.has(filename.slice(dot));
}

export interface RawChunk {
	file: string;
	/** Zero-based lines and UTF-16 columns; the end position is exclusive. */
	range: { start: number; end: number; startCharacter?: number; endCharacter?: number };
	preview: string;
	symbolName?: string;
	/** Symbol signature used only for embedding context, never as a source excerpt. */
	context?: string;
	text: string;
}

/** Chunk a live document, including unsaved contents, without omitting symbol gaps. */
export async function chunkDocument(doc: vscode.TextDocument, workspaceUri: vscode.Uri): Promise<RawChunk[]> {
	const file = relativeWorkspacePath(doc.uri, workspaceUri);
	if (file === undefined) { throw new Error('Document is outside the selected workspace root.'); }
	const text = doc.getText();
	const version = doc.version;
	const symbols: SourceSymbol[] = [];
	try {
		const provided = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider', doc.uri,
		);
		// A provider can finish after the buffer changes. Never apply its ranges to another version.
		if (doc.version !== version) { return chunkText(doc.getText(), file); }
		const visit = (items: vscode.DocumentSymbol[], parent: string): void => {
			for (const symbol of items ?? []) {
				if (!symbol.range) { continue; }
				const name = parent ? `${parent}.${symbol.name}` : symbol.name;
				const start = doc.offsetAt(symbol.range.start);
				const end = doc.offsetAt(symbol.range.end);
				const firstLine = text.slice(start, end).split(/\r?\n/, 1)[0].trim().slice(0, 200);
				symbols.push({ start, end, name, context: firstLine });
				visit(symbol.children ?? [], name);
			}
		};
		visit(provided ?? [], '');
	} catch {
		// Plain text, unavailable language servers, and failed providers still get full coverage.
	}
	if (doc.version !== version) { return chunkText(doc.getText(), file); }
	return splitSource(text, file, symbols);
}

/** Compatibility wrapper for existing callers. New callers should pass the complete root URI. */
export async function chunkFile(uri: vscode.Uri, workspaceRootPath: string): Promise<RawChunk[]> {
	const root = uri.with({ path: workspaceRootPath, fragment: '' });
	return chunkDocument(await vscode.workspace.openTextDocument(uri), root);
}

/** Fast, complete source windows for lexical fallback while semantic indexing catches up. */
export function chunkText(text: string, file: string): RawChunk[] {
	return splitSource(text, file);
}
