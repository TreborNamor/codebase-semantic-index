import ignore = require('ignore');

export interface IgnoreLayerSource { base: string; contents: string; }

/** Git's per-directory precedence, including the rule against re-including children of ignored directories. */
export function createGitignoreFilter(sources: IgnoreLayerSource[]): (relativePath: string) => boolean {
	const layers: Array<{ base: string; matcher: ReturnType<typeof ignore> }> = [];
	const evaluate = (relativePath: string): boolean => {
		let ignored = false;
		for (const layer of layers) {
			if (layer.base && !relativePath.startsWith(`${layer.base}/`)) { continue; }
			const path = layer.base ? relativePath.slice(layer.base.length + 1) : relativePath;
			if (!path) { continue; }
			const result = layer.matcher.test(path);
			if (result.ignored) { ignored = true; }
			else if (result.unignored) { ignored = false; }
		}
		return ignored;
	};
	const depth = (base: string): number => base ? base.split('/').length : 0;
	for (const source of [...sources].sort((a, b) => depth(a.base) - depth(b.base))) {
		// Git never consults a .gitignore inside an already ignored directory.
		if (source.base && evaluate(`${source.base}/`)) { continue; }
		layers.push({ base: source.base, matcher: ignore({ ignorecase: false }).add(source.contents) });
	}
	return relativePath => {
		if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) { return true; }
		return evaluate(relativePath);
	};
}
