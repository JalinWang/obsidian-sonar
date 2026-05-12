import { ZvecEmbeddingStore } from './ZvecEmbeddingStore';
import { EmbeddingStore } from './EmbeddingStore';
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
const LOG_TOP_N = 5;

function cosineSimilarity(vec1: number[], vec2: number[]): number {
  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i];
    n1 += vec1[i] * vec1[i];
    n2 += vec2[i] * vec2[i];
  }
  if (n1 === 0 || n2 === 0) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

/**
 * Pure embedding-based semantic search.
 *
 * Supports two backends selected by the `vectorSearchMode` setting:
 * - `zvec`: fast ANN search via the zvec HNSW index (default).
 * - `bf`:   exact brute-force cosine similarity over all IDB embeddings.
 *
 * Both modes log the query string and the top results so their output can
 * be compared in the console.
 */
export class EmbeddingSearch extends WithLogging {
  protected readonly componentName = 'EmbeddingSearch';

  constructor(
    private metadataStore: MetadataStore,
    private zvecStore: ZvecEmbeddingStore,
    private idbEmbeddingStore: EmbeddingStore,
    private embedder: Embedder,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

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

  private async searchChunks(
    query: string,
    type: 'title' | 'content',
    options: FullSearchOptions
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const mode = this.configManager.get('vectorSearchMode');
    if (mode === 'bf') {
      return this.searchChunksBF(query, type, options);
    }
    return this.searchChunksZvec(query, type, options);
  }

  // ---------------------------------------------------------------------------
  // zvec ANN backend
  // ---------------------------------------------------------------------------

  private async searchChunksZvec(
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
    const rawResults = this.zvecStore.search(queryEmbedding, topk, type);

    this.log(
      `[zvec] query="${query}" type=${type} topk=${topk} raw_hits=${rawResults.length}`
    );
    this.logTopResults('[zvec]', rawResults.slice(0, LOG_TOP_N));

    if (rawResults.length === 0) return [];

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

    for (const { id, score } of rawResults) {
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

  // ---------------------------------------------------------------------------
  // Brute-force cosine backend (IDB)
  // ---------------------------------------------------------------------------

  private async searchChunksBF(
    query: string,
    type: 'title' | 'content',
    options: FullSearchOptions
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const queryEmbeddings = await this.embedder.getEmbeddings([query]);
    const queryEmbedding = queryEmbeddings[0];

    const [allEmbeddings, allChunks] = await Promise.all([
      this.idbEmbeddingStore.getAllEmbeddings(),
      this.metadataStore.getAllChunks(),
    ]);

    const metadataById = new Map<string, ChunkMetadata>();
    const metadataByFilePath = new Map<string, ChunkMetadata>();
    for (const meta of allChunks) {
      metadataById.set(meta.id, meta);
      if (!metadataByFilePath.has(meta.filePath)) {
        metadataByFilePath.set(meta.filePath, meta);
      }
    }

    const filtered = allEmbeddings.filter(emb => {
      // Skip sentinel records and any entry with no embedding vector.
      if (emb.embedding.length === 0) return false;
      const isTitle = ChunkId.isTitle(emb.id);
      return type === 'title' ? isTitle : !isTitle;
    });

    const scored = filtered
      .map(emb => ({
        id: emb.id,
        score: cosineSimilarity(queryEmbedding, emb.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    this.log(
      `[bf] query="${query}" type=${type} candidates=${filtered.length}`
    );
    this.logTopResults('[bf]', scored.slice(0, LOG_TOP_N));

    const results: Array<{
      id: string;
      score: number;
      metadata: ChunkMetadata;
    }> = [];

    for (const { id, score } of scored) {
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

      if (
        options.retrievalLimit !== undefined &&
        results.length >= options.retrievalLimit
      ) {
        break;
      }
    }

    return results;
  }

  private logTopResults(
    prefix: string,
    results: Array<{ id: string; score: number }>
  ): void {
    if (results.length === 0) return;
    const lines = results.map(r => `  ${r.score.toFixed(4)}  ${r.id}`);
    this.log(`${prefix} top results:\n${lines.join('\n')}`);
  }
}
