export interface SourceRange {
	/** Zero-based inclusive lines, with optional exact columns. */
	start: number;
	end: number;
	startCharacter?: number;
	endCharacter?: number;
}

export interface Chunk {
	file: string;
	range: SourceRange;
	vectorOffset: number;
	preview: string;
	symbolName?: string;
	contentHash: string;
	/** Hash of the contextual embedding payload, for vector reuse. */
	embeddingHash: string;
}

export interface FileManifest { hash: string }

export interface MetaJson {
	version: number;
	model: string;
	modelRevision: string;
	pipelineId: string;
	chunkerVersion: number;
	rootUri: string;
	generation: string;
	created: number;
	chunkCount: number;
	vectorDim: number;
}

export interface IndexData {
	meta: MetaJson;
	files: Record<string, FileManifest>;
	chunks: Chunk[];
}

export interface LoadedIndex { data: IndexData; vectors: Float32Array }
