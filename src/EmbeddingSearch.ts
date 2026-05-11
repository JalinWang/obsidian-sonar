import { ZvecEmbeddingStore } from './ZvecEmbeddingStore';
import { MetadataStore, type ChunkMetadata } from './MetadataStore';
import type { Embedder } from './Embedder';
import { ConfigManager } from './ConfigManager';
import {
  matchesFolderFilters,
  type ChunkResult,
  type SearchResult,
  type FullSearchOptions,
} from './SearchManager';
import { WithLogging } from './WithLogging';
import { ChunkId } from './chunkId';

const ZVEC_TOPK_MULTIPLIER = 10;
const ZVEC_TOPK_MINIMUM = 100;

/**
 * Pure embedding-based semantic search using zvec ANN (HNSW) index.
 * Returns results in the same format as BM25Search for easy integration.
 */
export class EmbeddingSearch extends WithLogging {
  protected readonly componentName = 'EmbeddingSearch';

  constructor(
    private metadataStore: MetadataStore,
    private zvecStore: ZvecEmbeddingStore,
    private embedder: Embedder,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Search title only (searches title embeddings: path#title entries)
   */
  async searchTitle(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const scored = await this.searchChunks(query, 'title', options);

    return scored.slice(0, options.retrievalLimit).map(result => ({
      filePath: result.metadata.filePath,
      title: result.metadata.title || result.metadata.filePath,
      score: result.score,
      topChunk: {
        content: result.metadata.title,
        score: result.score,
        metadata: result.metadata,
      },
      chunkCount: 1,
      fileSize: result.metadata.size,
    }));
  }

  /**
   * Search content only (searches chunk embeddings: path#0, path#1, ... entries)
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<ChunkResult[]> {
    const scored = await this.searchChunks(query, 'content', options);

    return scored.slice(0, options.retrievalLimit).map(result => ({
      chunkId: result.id,
      filePath: result.metadata.filePath,
      chunkIndex: ChunkId.getChunkIndex(result.id),
      content: result.metadata.content,
      score: result.score,
      metadata: result.metadata,
    }));
  }

  /**
   * Core search: query zvec for nearest neighbors, then apply filters
   * using metadata from MetadataStore.
   */
  private async searchChunks(
    query: string,
    type: 'title' | 'content',
    options: FullSearchOptions
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const queryEmbeddings = await this.embedder.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const topk = Math.max(
      (options.retrievalLimit ?? 20) * ZVEC_TOPK_MULTIPLIER,
      ZVEC_TOPK_MINIMUM
    );
    const zvecResults = this.zvecStore.search(queryEmbedding, topk, type);

    if (zvecResults.length === 0) {
      return [];
    }

    const allChunks = await this.metadataStore.getAllChunks();
    const metadataById = new Map<string, ChunkMetadata>();
    const metadataByFilePath = new Map<string, ChunkMetadata>();
    for (const meta of allChunks) {
      metadataById.set(meta.id, meta);
      if (!metadataByFilePath.has(meta.filePath)) {
        metadataByFilePath.set(meta.filePath, meta);
      }
    }

    const results: Array<{
      id: string;
      score: number;
      metadata: ChunkMetadata;
    }> = [];

    for (const { id, score } of zvecResults) {
      let meta: ChunkMetadata | undefined;
      if (ChunkId.isTitle(id)) {
        meta = metadataByFilePath.get(ChunkId.getFilePath(id));
      } else {
        meta = metadataById.get(id);
      }

      if (!meta) continue;

      if (options?.excludeFilePath && meta.filePath === options.excludeFilePath)
        continue;
      if (!matchesFolderFilters(meta.filePath, options)) continue;

      results.push({ id, score, metadata: meta });
    }

    return results;
  }
}
