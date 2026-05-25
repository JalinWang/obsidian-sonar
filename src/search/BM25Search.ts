import { BM25Store } from '../storage/BM25Store';
import { MetadataStore } from '../storage/MetadataStore';
import {
  matchesFolderFilters,
  type ChunkResult,
  type SearchResult,
  type FullSearchOptions,
} from '../core/search-types';
import type { ConfigManager } from '../config/ConfigManager';
import { WithLogging } from '../core/WithLogging';
import { ChunkId } from '../core/chunkId';

/**
 * BM25 full-text search interface
 * Returns results in the same format as EmbeddingSearch for easy integration
 * Supports separate title and content search
 */
export class BM25Search extends WithLogging {
  protected readonly componentName = 'BM25Search';

  constructor(
    private bm25Store: BM25Store,
    private metadataStore: MetadataStore,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  /**
   * Search title only
   * Computes BM25 for all titles, returns all results sorted by score
   */
  async searchTitle(
    query: string,
    options: FullSearchOptions
  ): Promise<SearchResult[]> {
    const bm25Results = await this.bm25Store.search(
      query,
      options.retrievalLimit * 3
    );

    if (bm25Results.length === 0) {
      return [];
    }

    // Filter only title results and extract filePath with score
    const titleScores = new Map<string, number>();
    for (const result of bm25Results) {
      if (ChunkId.isTitle(result.docId)) {
        const filePath = ChunkId.getFilePath(result.docId);
        if (options?.excludeFilePath && filePath === options.excludeFilePath) {
          continue;
        }
        titleScores.set(filePath, result.score);
      }
    }

    if (titleScores.size === 0) {
      return [];
    }

    const matchedPaths = [...titleScores.keys()];
    const fetches = matchedPaths.map(fp =>
      this.metadataStore.getChunksByFile(fp)
    );
    const chunksByFile = await Promise.all(fetches);

    const results: SearchResult[] = [];
    for (let i = 0; i < matchedPaths.length; i++) {
      const filePath = matchedPaths[i];
      const score = titleScores.get(filePath)!;
      const fileChunks = chunksByFile[i];
      const titleChunk = fileChunks.find(c => ChunkId.isTitle(c.id));
      if (!titleChunk) continue;

      results.push({
        filePath,
        title: titleChunk.title || filePath,
        score,
        topChunk: {
          content: titleChunk.content,
          score,
          metadata: titleChunk,
        },
        chunkCount: fileChunks.length,
        fileSize: titleChunk.size,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Search content only
   * ChunkId format: "filePath#0", "filePath#1", ...
   * Returns chunk-level results
   */
  async searchContent(
    query: string,
    options: FullSearchOptions
  ): Promise<ChunkResult[]> {
    const bm25Results = await this.bm25Store.search(
      query,
      options.retrievalLimit * 3
    );

    if (bm25Results.length === 0) {
      return [];
    }

    const contentChunks = bm25Results.filter(result => {
      if (ChunkId.isTitle(result.docId)) return false;
      const filePath = ChunkId.getFilePath(result.docId);
      if (options?.excludeFilePath && filePath === options.excludeFilePath) {
        return false;
      }
      return matchesFolderFilters(filePath, options);
    });

    const limitedChunks = contentChunks.slice(0, options.retrievalLimit);

    const chunkIds = limitedChunks.map(r => r.docId);
    const metadataById = await this.metadataStore.getChunksByIds(chunkIds);

    const results: ChunkResult[] = [];
    for (const result of limitedChunks) {
      const metadata = metadataById.get(result.docId);
      if (!metadata) continue;

      results.push({
        chunkId: result.docId,
        filePath: ChunkId.getFilePath(result.docId),
        chunkIndex: ChunkId.getChunkIndex(result.docId),
        content: metadata.content,
        score: result.score,
        metadata,
      });
    }

    return results;
  }
}
