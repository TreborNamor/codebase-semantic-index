import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
export const MODEL_NAME = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
export const VECTOR_DIM = 1024;

/** Folders that are never indexed, even without a .gitignore entry. */
export const ALWAYS_EXCLUDE = ['**/.intellisearch/**', '**/.git/**'];

/**
 * Builds a glob pattern that combines VS Code's files.exclude + search.exclude
 * settings (the same sources used by Find in Files' "Use Exclude Settings")
 * together with ALWAYS_EXCLUDE.
 */
export function buildExcludeGlob(): string {
	const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {};
	const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') ?? {};
	const patterns = [
		...ALWAYS_EXCLUDE,
		...Object.entries({ ...filesExclude, ...searchExclude })
			.filter(([, enabled]) => enabled)
			.map(([pattern]) => pattern),
	];
	return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

/** True when `uri` lies inside the workspace root folder (not a sibling or another workspace folder). */
export function isInsideWorkspaceRoot(uri: vscode.Uri, workspaceUri: vscode.Uri): boolean {
	return uri.path.startsWith(workspaceUri.path + '/');
}

// ---------------------------------------------------------------------------
// Gitignore-aware file filter
// ---------------------------------------------------------------------------

/** Escapes regex metacharacters in a literal string. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts one gitignore pattern (without `!`) to a regex matching the path or anything under it. */
function gitignorePatternToRegExp(pattern: string): RegExp {
	let p = pattern;
	const dirOnly = p.endsWith('/');
	if (dirOnly) { p = p.slice(0, -1); }
	// A slash left in the pattern anchors it to the .gitignore's directory.
	const anchored = p.includes('/');
	if (p.startsWith('/')) { p = p.slice(1); }

	let body = '';
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === '\\' && i + 1 < p.length) {
			body += escapeRegExp(p[++i]);
		} else if (c === '*' && p[i + 1] === '*') {
			const atSegmentStart = i === 0 || p[i - 1] === '/';
			if (atSegmentStart && p[i + 2] === '/') {
				body += '(?:.*/)?';
				i += 2;
			} else if (atSegmentStart && i + 2 === p.length) {
				body += '.*';
				i += 1;
			} else {
				body += '[^/]*';
				i += 1;
			}
		} else if (c === '*') {
			body += '[^/]*';
		} else if (c === '?') {
			body += '[^/]';
		} else if (c === '[' && p.indexOf(']', i + 2) !== -1) {
			const end = p.indexOf(']', i + 2);
			const content = p.slice(i + 1, end).replace(/\\/g, '\\\\');
			body += content.startsWith('!') ? `[^${content.slice(1)}]` : `[${content}]`;
			i = end;
		} else {
			body += escapeRegExp(c);
		}
	}

	const prefix = anchored ? '^' : '^(?:.*/)?';
	// A directory pattern matches only paths inside it, never a file with the same name.
	const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
	return new RegExp(prefix + body + suffix);
}

/** Reads every .gitignore in the workspace; deeper files override their parents. */
export async function buildGitignoreFilter(
	workspaceUri: vscode.Uri,
): Promise<(uri: vscode.Uri) => boolean> {
	const rootPath = workspaceUri.path;

	// Pass null as the exclude so we pick up .gitignore files that might
	// themselves live inside folders excluded by workspace settings.
	const gitignoreUris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspaceUri, '**/.gitignore'),
		null,
	);

	interface Rule { regex: RegExp; negated: boolean; }
	interface Layer { base: string; rules: Rule[]; }
	const layers: Layer[] = [];

	for (const giUri of gitignoreUris) {
		const giDir = giUri.path.slice(0, giUri.path.lastIndexOf('/'));
		// Workspace-relative base for this .gitignore (empty string = repo root)
		const base = giDir.length > rootPath.length
			? giDir.slice(rootPath.length + 1)
			: '';

		let content: string;
		try {
			content = new TextDecoder().decode(
				await vscode.workspace.fs.readFile(giUri),
			);
		} catch {
			continue;
		}

		const rules: Rule[] = [];
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) { continue; }

			const negated = line.startsWith('!');
			const pattern = negated ? line.slice(1) : line;
			if (pattern && pattern !== '/') {
				rules.push({ regex: gitignorePatternToRegExp(pattern), negated });
			}
		}
		layers.push({ base, rules });
	}

	if (layers.length === 0) {
		return () => false;
	}

	// Shallowest .gitignore first, so deeper files take precedence.
	const depth = (base: string) => (base ? base.split('/').length : 0);
	layers.sort((a, b) => depth(a.base) - depth(b.base));

	return (uri: vscode.Uri): boolean => {
		const prefix = rootPath + '/';
		if (!uri.path.startsWith(prefix)) { return false; }
		const relPath = uri.path.slice(prefix.length);

		let ignored = false;
		for (const { base, rules } of layers) {
			let subPath = relPath;
			if (base) {
				if (!relPath.startsWith(base + '/')) { continue; }
				subPath = relPath.slice(base.length + 1);
			}
			for (const { regex, negated } of rules) {
				if (regex.test(subPath)) { ignored = !negated; }
			}
		}
		return ignored;
	};
}

// ---------------------------------------------------------------------------
// Float32 ↔ Base64  (btoa / atob are available in the web-worker host)
// ---------------------------------------------------------------------------
export function float32ToBase64(arr: Float32Array): string {
	const bytes = new Uint8Array(arr.buffer);
	const CHUNK = 0x8000; // 32 768 — safe upper bound for spread
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

export function base64ToFloat32(b64: string): Float32Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const aligned = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(aligned).set(bytes);
	return new Float32Array(aligned);
}
