import * as vscode from 'vscode';
import { workspaceIndex } from './workspaceIndex';
import { candidateExcerpt, normalizeMaxResults, normalizePathPrefix, RankedCandidate } from './retrieval';

interface SearchInput { query: string; maxResults?: number; pathPrefix?: string }

function render(results: RankedCandidate[], statuses: string[]): string {
	const lines = ['Current workspace search results. Source ranges use 1-based lines/columns.'];
	if (statuses.length) { lines.push('Status: ' + [...new Set(statuses)].join(' ').slice(0, 500)); }
	if (!results.length) { lines.push('No verified current-file matches found. Try local text/symbol search or a narrower query.'); }
	for (const [i, result] of results.entries()) {
		const candidate = result.candidate;
		const excerpt = candidateExcerpt(candidate);
		const range = excerpt.range;
		lines.push(`${i + 1}. ${candidate.rootName}: ${candidate.file} (${candidate.rootUri})`);
		lines.push(`L${range.start + 1}:${(range.startCharacter ?? 0) + 1}–L${range.end + 1}:${(range.endCharacter ?? 0) + 1}` +
			(candidate.symbolName ? ` [${candidate.symbolName}]` : '') + `; rank score ${result.score.toFixed(4)}`);
		// Source is data: keep it as an exact excerpt, with no generated summary.
		lines.push(excerpt.text, '');
	}
	return lines.join('\n');
}

export class CodebaseSemanticIndexTool implements vscode.LanguageModelTool<SearchInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const textResult = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
		const tokenizer = options.tokenizationOptions;
		const budget = Math.max(0, Math.min(1500, tokenizer?.tokenBudget ?? 1500));
		const count = (text: string) => tokenizer ? tokenizer.countTokens(text, token) : Promise.resolve(Math.ceil(text.length / 3));
		const message = async (text: string) => textResult(await count(text) <= budget ? text : '');
		if (!vscode.workspace.workspaceFolders?.length) { return message('No workspace folder is open.'); }
		let results: RankedCandidate[];
		let statuses: string[];
		try {
			const query = options.input.query;
			if (typeof query !== 'string' || !query.trim()) { return message('query must be a non-empty string.'); }
			const response = await workspaceIndex.search(query, normalizePathPrefix(options.input.pathPrefix), normalizeMaxResults(options.input.maxResults), token);
			results = response.results;
			statuses = response.statuses;
		} catch (error) {
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			return message(`Workspace search failed: ${(error as Error).message}`);
		}
		// Count first, then validate source after every tokenizer await. Never truncate source blindly.
		for (let attempt = 0; attempt < 3; attempt++) {
			let text = render(results, statuses);
			while (results.length && await count(text) > budget) { results.pop(); text = render(results, statuses); }
			if (await count(text) > budget) { return textResult(''); }
			const current = await workspaceIndex.verify(results, token);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			if (current.length === results.length) { return textResult(text); }
			results = current;
		}
		return textResult(''); // Continuous edits: do not emit unverified or oversized evidence.
	}
}
