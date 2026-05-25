import type { ChunkMetadata } from '../storage/MetadataStore';

export interface ChunkResult {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface ChunkSearchResult {
  content: string;
  score: number;
  metadata: ChunkMetadata;
}

/**
 * Search result representing a matched document.
 *
 * The `score` field is normalized to [0, 1] for UI display purposes (e.g.,
 * progress bars). It does NOT represent absolute relevance and should not
 * be compared across different queries.
 */
export interface SearchResult {
  filePath: string;
  title: string;
  /** Normalized score in [0, 1] for UI display. */
  score: number;
  topChunk: ChunkSearchResult;
  chunkCount: number;
  fileSize: number;
}

export interface SearchOptions {
  excludeFilePath?: string;
  excludeFolderPath?: string;
  folderPath?: string;
  titleWeight?: number;
  contentWeight?: number;
  embeddingWeight?: number;
  bm25Weight?: number;
}

export interface SearchOptionsWithTopK extends SearchOptions {
  topK: number;
  prependTitleToChunks?: boolean;
}

export type Modality = 'text' | 'image';

export interface FullSearchOptions extends SearchOptionsWithTopK {
  retrievalLimit: number;
  modality?: Modality;
}

export interface ChunkRerankMetadata {
  embeddingChunkCount: number;
  bm25ChunkCount: number;
  mergedChunkCount: number;
  retrievalTimeMs: number;
  rerankTimeMs: number;
  totalTimeMs: number;
}

export interface ChunkRerankResult {
  results: SearchResult[];
  metadata: ChunkRerankMetadata;
}

export interface ChunkRerankDebugData {
  query: string;
  embeddingChunks: ChunkResult[];
  bm25Chunks: ChunkResult[];
  mergedChunks: ChunkResult[];
  rerankedChunks: ChunkResult[];
  results: SearchResult[];
  metadata: ChunkRerankMetadata;
}

function toFolderPrefix(path: string): string {
  return path.endsWith('/') ? path : path + '/';
}

export function matchesFolderFilters(
  filePath: string,
  options?: Pick<SearchOptions, 'folderPath' | 'excludeFolderPath'>
): boolean {
  if (options?.folderPath) {
    if (!filePath.startsWith(toFolderPrefix(options.folderPath))) return false;
  }
  if (options?.excludeFolderPath) {
    if (filePath.startsWith(toFolderPrefix(options.excludeFolderPath)))
      return false;
  }
  return true;
}
