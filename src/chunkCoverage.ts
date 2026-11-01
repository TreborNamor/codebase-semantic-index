import type { RawChunk } from './chunker';

export const MAX_CHUNK_CHARS = 1_024;
export const CHUNK_OVERLAP_CHARS = 128;

export interface SourceSymbol {
	start: number;
	end: number;
	name: string;
	context?: string;
}

/** Source-only windows. Symbols partition the file rather than replacing its non-symbol regions. */
export function splitSource(text: string, file: string, symbols: SourceSymbol[] = []): RawChunk[] {
	const valid = symbols.filter(s => Number.isInteger(s.start) && Number.isInteger(s.end)
		&& s.start >= 0 && s.end > s.start && s.end <= text.length);
	const boundaries = [...new Set([0, text.length, ...valid.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
	const lineStarts = [0];
	const lineBreaks = /\r\n|\r|\n/g;
	let lineBreak: RegExpExecArray | null;
	while ((lineBreak = lineBreaks.exec(text))) { lineStarts.push(lineBreak.index + lineBreak[0].length); }
	const position = (offset: number): { line: number; character: number } => {
		let low = 0;
		let high = lineStarts.length;
		while (low + 1 < high) {
			const mid = (low + high) >>> 1;
			if (lineStarts[mid] <= offset) { low = mid; } else { high = mid; }
		}
		return { line: low, character: offset - lineStarts[low] };
	};
	const chunks: RawChunk[] = [];
	for (let i = 0; i + 1 < boundaries.length; i++) {
		const regionStart = boundaries[i];
		const regionEnd = boundaries[i + 1];
		const symbol = valid.filter(s => s.start <= regionStart && s.end >= regionEnd)
			.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
		let cursor = regionStart;
		while (cursor < regionEnd) {
			let end = Math.min(cursor + MAX_CHUNK_CHARS, regionEnd);
			if (end < regionEnd) {
				const newline = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf('\r', end - 1));
				if (newline > cursor + MAX_CHUNK_CHARS / 2) { end = newline + 1; }
				// Do not divide a surrogate pair on a very long source line.
				if (end > cursor && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) { end--; }
			}
			const raw = text.slice(cursor, end);
			const leading = raw.length - raw.trimStart().length;
			const content = raw.trim();
			if (content) {
				const startPos = position(cursor + leading);
				const endPos = position(cursor + leading + content.length);
				chunks.push({
					file,
					range: { start: startPos.line, end: endPos.line, startCharacter: startPos.character, endCharacter: endPos.character },
					text: content,
					preview: content.slice(0, 150).replace(/\s+/g, ' ').trim(),
					...(symbol ? { symbolName: symbol.name, context: symbol.context } : {}),
				});
			}
			if (end === regionEnd) { break; }
			let next = Math.max(cursor + 1, end - CHUNK_OVERLAP_CHARS);
			if (next > 0 && /[\uDC00-\uDFFF]/.test(text[next]) && /[\uD800-\uDBFF]/.test(text[next - 1])) { next--; }
			cursor = next;
		}
	}
	return chunks;
}
