/** Current, verified source supplied by the workspace index service. */
export interface RetrievalCandidate {
	file: string;
	range: { start: number; end: number; startCharacter?: number; endCharacter?: number };
	symbolName?: string;
	text: string;
	vector?: Float32Array;
	rootUri: string;
	contentHash: string;
}

export interface RankedCandidate {
	candidate: RetrievalCandidate;
	/** Exact-match priority plus reciprocal rank fusion; not a probability. */
	score: number;
	similarity?: number;
}

const RRF_K = 60;
const STOP_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'find',
	'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
	'this', 'to', 'what', 'when', 'where', 'which', 'with',
]);

/** Both whole identifiers and their camel/snake/path components are searchable. */
function tokens(text: string): string[] {
	const identifiers = text.match(/[\p{L}\p{N}_$]+/gu) ?? [];
	const result: string[] = [];
	for (const identifier of identifiers) {
		const whole = identifier.toLocaleLowerCase('en-US');
		result.push(whole);
		const components = identifier
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.toLocaleLowerCase('en-US')
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
		for (const component of components) {
			if (component !== whole) { result.push(component); }
		}
	}
	return result;
}

function lexicalScore(candidate: RetrievalCandidate, query: string, terms: string[]): number {
	const path = new Set(tokens(candidate.file));
	const symbol = new Set(tokens(candidate.symbolName ?? ''));
	const body = new Map<string, number>();
	for (const token of tokens(candidate.text)) { body.set(token, (body.get(token) ?? 0) + 1); }
	let score = 0;
	for (const term of terms) {
		if (symbol.has(term)) { score += 5; }
		if (path.has(term)) { score += 4; }
		const frequency = body.get(term) ?? 0;
		if (frequency) { score += 1 + Math.log1p(frequency); }
	}
	const phrase = query.trim().toLocaleLowerCase('en-US');
	if (phrase && (candidate.symbolName ?? '').toLocaleLowerCase('en-US') === phrase) { score += 100; }
	if (phrase && candidate.file.toLocaleLowerCase('en-US') === phrase) { score += 100; }
	if (phrase && candidate.file.toLocaleLowerCase('en-US').includes(phrase)) { score += 12; }
	if (phrase && candidate.text.toLocaleLowerCase('en-US').includes(phrase)) { score += 6; }
	return score;
}

function isExactLookup(candidate: RetrievalCandidate, query: string): boolean {
	const lookup = query.trim();
	const path = lookup.replace(/\\/g, '/').replace(/^\.\//, '');
	if (candidate.file === path || candidate.file.slice(candidate.file.lastIndexOf('/') + 1) === path) { return true; }
	if (candidate.symbolName === lookup) { return true; }
	if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(lookup)) { return false; }
	const identifiers: readonly string[] = candidate.text.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [];
	return identifiers.includes(lookup);
}

/** Invalid or incompatible embeddings are never given a dense rank. */
function cosine(a: Float32Array, b: Float32Array): number | undefined {
	if (!a.length || a.length !== b.length) { return undefined; }
	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let i = 0; i < a.length; i++) {
		if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { return undefined; }
		dot += a[i] * b[i];
		aNorm += a[i] * a[i];
		bNorm += b[i] * b[i];
	}
	if (!aNorm || !bNorm) { return undefined; }
	return Math.max(-1, Math.min(1, dot / Math.sqrt(aNorm * bNorm)));
}

export function normalizeMaxResults(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) { return 5; }
	return Math.min(20, Math.max(1, Math.floor(value)));
}

/** Prefixes are literal workspace-relative paths, never globs or URI references. */
export function normalizePathPrefix(value: unknown): string {
	if (value === undefined || value === '') { return ''; }
	if (typeof value !== 'string') { throw new Error('pathPrefix must be a workspace-relative path.'); }
	const normalized = value.replace(/\\/g, '/');
	if (normalized.startsWith('/') || normalized.includes(':') || normalized.includes('\0')) {
		throw new Error('pathPrefix must be a workspace-relative path without a drive or URI.');
	}
	const segments = normalized.split('/');
	if (segments.includes('..')) { throw new Error('pathPrefix cannot traverse outside the workspace.'); }
	return segments.filter(segment => segment && segment !== '.').join('/');
}

export function matchesPathPrefix(file: string, prefix: string): boolean {
	return !prefix || file === prefix || file.startsWith(prefix + '/');
}

function comparePosition(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
	return aLine === bLine ? aColumn - bColumn : aLine - bLine;
}

function overlaps(a: RetrievalCandidate, b: RetrievalCandidate): boolean {
	if (a.rootUri !== b.rootUri || a.file !== b.file) { return false; }
	// Missing end columns describe a full inclusive end line; explicit columns are exclusive.
	return comparePosition(a.range.end, a.range.endCharacter ?? Infinity,
		b.range.start, b.range.startCharacter ?? 0) > 0
		&& comparePosition(b.range.end, b.range.endCharacter ?? Infinity,
			a.range.start, a.range.startCharacter ?? 0) > 0;
}

/** Fuse independent lexical and dense ranks without mixing their raw score scales. */
export function rankCandidates(
	candidates: RetrievalCandidate[],
	query: string,
	queryVector?: Float32Array,
	maxResults?: number,
): RankedCandidate[] {
	if (!query.trim()) { return []; }
	const queryTokens = [...new Set(tokens(query))];
	const meaningful = queryTokens.filter(term => !STOP_WORDS.has(term));
	const terms = meaningful.length ? meaningful : queryTokens;
	const scores = candidates.map((candidate, index) => ({
		candidate, index,
		lexical: lexicalScore(candidate, query, terms),
		similarity: queryVector && candidate.vector ? cosine(queryVector, candidate.vector) : undefined,
		// Exact lookup must remain useful while a changed file's embedding is pending.
		// Its priority is separate from RRF; equally exact candidates still benefit from both channels.
		score: isExactLookup(candidate, query) ? 1 : 0,
		lexicalRank: Infinity,
	}));
	const lexical = scores.filter(item => item.lexical > 0)
		.sort((a, b) => b.lexical - a.lexical || a.index - b.index);
	for (let i = 0; i < lexical.length; i++) {
		lexical[i].score += 1 / (RRF_K + i + 1);
		lexical[i].lexicalRank = i;
	}
	const dense = scores.filter(item => item.similarity !== undefined)
		.sort((a, b) => b.similarity! - a.similarity! || a.index - b.index);
	for (let i = 0; i < dense.length; i++) { dense[i].score += 1 / (RRF_K + i + 1); }
	const ranked = scores.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.lexicalRank - b.lexicalRank || a.index - b.index);
	const results: RankedCandidate[] = [];
	const limit = normalizeMaxResults(maxResults);
	for (const item of ranked) {
		if (results.some(result => overlaps(result.candidate, item.candidate))) { continue; }
		results.push({ candidate: item.candidate, score: item.score, similarity: item.similarity });
		if (results.length === limit) { break; }
	}
	return results;
}

/** Return an unmodified source prefix and the precise range of the text actually shown. */
export function candidateExcerpt(
	candidate: RetrievalCandidate,
	maxChars = 400,
): { text: string; range: RetrievalCandidate['range'] } {
	let length = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 400;
	length = Math.min(length, candidate.text.length);
	// Keep UTF-16 surrogate pairs and CRLF line endings intact at the boundary.
	if (length > 0 && length < candidate.text.length) {
		const last = candidate.text.charCodeAt(length - 1);
		if ((last >= 0xD800 && last <= 0xDBFF)
			|| (candidate.text[length - 1] === '\r' && candidate.text[length] === '\n')) { length--; }
	}
	const text = candidate.text.slice(0, length);
	const lines = text.split(/\r\n|\r|\n/);
	const startCharacter = candidate.range.startCharacter ?? 0;
	return {
		text,
		range: {
			start: candidate.range.start,
			startCharacter,
			end: candidate.range.start + lines.length - 1,
			endCharacter: lines.length === 1 ? startCharacter + text.length : lines[lines.length - 1].length,
		},
	};
}
