import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { ConfigManager } from '../config/ConfigManager';
import { WithLogging } from '../core/WithLogging';
import {
  combineSearchResults,
  mergeAndDeduplicateChunks,
  aggregateChunksToFiles,
} from './SearchResultFusion';
import type { Reranker } from '../core/Reranker';
import { isImageFilePath } from '../indexing/fileFilters';
import type {
  ChunkResult,
  SearchResult,
  SearchOptionsWithTopK,
  ChunkRerankResult,
} from '../core/search-types';
import { RequestQueue } from './RequestQueue';
import { HybridRetriever } from './HybridRetriever';
import { RerankService } from './RerankService';

export type {
  ChunkResult,
  ChunkSearchResult,
  SearchResult,
  SearchOptions,
  SearchOptionsWithTopK,
  Modality,
  FullSearchOptions,
  ChunkRerankMetadata,
  ChunkRerankResult,
  ChunkRerankDebugData,
} from '../core/search-types';
export { matchesFolderFilters } from '../core/search-types';

interface SearchQueueRequest {
  componentId: string;
  query: string;
  options: SearchOptionsWithTopK;
}

interface RerankQueueRequest {
  componentId: string;
  query: string;
  results: SearchResult[];
  topK: number;
}

/**
 * High-level search manager that orchestrates hybrid search
 * combining embedding-based and BM25 full-text search.
 *
 * Uses processing queues to handle concurrent requests from multiple UI
 * components. When a new request arrives from the same component, any pending
 * request is superseded and resolved with null.
 */
export class SearchManager extends WithLogging {
  protected readonly componentName = 'SearchManager';
  private searchQueue: RequestQueue<SearchQueueRequest, SearchResult[]>;
  private rerankQueue: RequestQueue<RerankQueueRequest, SearchResult[]>;
  private retriever: HybridRetriever;
  private rerankService: RerankService;
  protected configManager: ConfigManager;

  constructor(
    embeddingSearch: EmbeddingSearch,
    bm25Search: BM25Search,
    reranker: Reranker,
    configManager: ConfigManager,
    readImageBase64?: (filePath: string) => Promise<string | null>
  ) {
    super();
    this.configManager = configManager;
    this.retriever = new HybridRetriever(
      embeddingSearch,
      bm25Search,
      configManager
    );
    this.rerankService = new RerankService(
      reranker,
      configManager,
      readImageBase64
    );
    this.searchQueue = new RequestQueue(req =>
      this.executeSearch(req.query, req.options)
    );
    this.rerankQueue = new RequestQueue(req =>
      this.rerankService.rerankDocuments(req.query, req.results, req.topK)
    );
    this.log('Initialized');
  }

  async getEmbedding(chunkId: string): Promise<number[] | null> {
    return this.retriever.getEmbedding(chunkId);
  }

  async search(
    componentId: string,
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[] | null> {
    return this.searchQueue.enqueue({ componentId, query, options });
  }

  async searchByVector(
    queryEmbedding: number[],
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;
    const fullOptions = { ...options, retrievalLimit };

    const embeddingChunks = await this.retriever.retrieveByVector(
      queryEmbedding,
      fullOptions
    );

    const aggOptions = this.retriever.getAggOptions();
    const results = aggregateChunksToFiles(embeddingChunks, aggOptions);
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.topK);
  }

  async rerank(
    componentId: string,
    query: string,
    results: SearchResult[],
    topK: number
  ): Promise<SearchResult[] | null> {
    if (!this.rerankService.isReady() || results.length === 0) {
      return null;
    }
    return this.rerankQueue.enqueue({
      componentId,
      query,
      results,
      topK,
    });
  }

  async searchWithChunkRerank(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<ChunkRerankResult | null> {
    if (!this.rerankService.isReady()) {
      return null;
    }
    return this.executeChunkRerank(query, options);
  }

  async getRerankedChunksForRAG(
    query: string,
    maxChunks: number,
    excludeFolderPath?: string
  ): Promise<ChunkResult[] | null> {
    if (!this.rerankService.isReady()) {
      return null;
    }

    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = maxChunks * retrievalMultiplier;
    const embeddingLimit = Math.ceil(retrievalLimit * 0.6);
    const bm25Limit = Math.ceil(retrievalLimit * 0.4);

    const retrieval = await this.retriever.retrieveContentChunks(
      query,
      { topK: maxChunks, retrievalLimit, excludeFolderPath },
      0.6,
      0.4,
      { embeddingLimit, bm25Limit }
    );

    this.retriever.logContentRetrieval('RAG retrieval', retrieval);

    const embeddingChunks = [
      ...retrieval.textEmbeddingChunks,
      ...retrieval.imageEmbeddingChunks,
    ];
    const mergedChunks = mergeAndDeduplicateChunks(
      embeddingChunks,
      retrieval.bm25Chunks
    );
    if (mergedChunks.length === 0) {
      return [];
    }

    return this.rerankService.rerankChunksForRAG(
      query,
      mergedChunks,
      maxChunks
    );
  }

  cancelPendingRequests(componentId: string): void {
    this.searchQueue.cancelByComponent(componentId);
    this.rerankQueue.cancelByComponent(componentId);
  }

  private async executeSearch(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<SearchResult[]> {
    const titleWeight = options.titleWeight ?? 0.0;
    const contentWeight = options.contentWeight ?? 1.0;
    const embeddingWeight = options.embeddingWeight ?? 0.6;
    const bm25Weight = options.bm25Weight ?? 0.4;

    if (titleWeight === 0 && contentWeight === 0) {
      throw new Error(
        'At least one of titleWeight or contentWeight must be non-zero'
      );
    }
    if (embeddingWeight === 0 && bm25Weight === 0) {
      throw new Error(
        'At least one of embeddingWeight or bm25Weight must be non-zero'
      );
    }

    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;
    const fullOptions = { ...options, retrievalLimit };

    const [titleResults, contentResults] = await Promise.all([
      titleWeight > 0
        ? this.retriever.retrieveTitleResults(
            query,
            fullOptions,
            embeddingWeight,
            bm25Weight
          )
        : Promise.resolve([]),
      contentWeight > 0
        ? this.hybridContentSearch(
            query,
            embeddingWeight,
            bm25Weight,
            fullOptions
          )
        : Promise.resolve([]),
    ]);

    const limit = options.topK * retrievalMultiplier;
    const combined = combineSearchResults(
      titleResults,
      contentResults,
      titleWeight,
      contentWeight,
      limit
    );

    return this.ensureImageRepresentation(combined, contentResults, limit);
  }

  private async hybridContentSearch(
    query: string,
    embeddingWeight: number,
    bm25Weight: number,
    options: SearchOptionsWithTopK & { retrievalLimit: number }
  ): Promise<SearchResult[]> {
    const retrieval = await this.retriever.retrieveContentChunks(
      query,
      options,
      embeddingWeight,
      bm25Weight
    );
    this.retriever.logContentRetrieval('Content retrieval', retrieval);
    return this.retriever.fuseContentToFiles(
      retrieval,
      embeddingWeight,
      bm25Weight
    );
  }

  private async executeChunkRerank(
    query: string,
    options: SearchOptionsWithTopK
  ): Promise<ChunkRerankResult> {
    const totalStart = performance.now();

    const embeddingWeight = options.embeddingWeight ?? 0.6;
    const bm25Weight = options.bm25Weight ?? 0.4;
    const totalWeight = embeddingWeight + bm25Weight;

    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const retrievalLimit = options.topK * retrievalMultiplier;
    const embeddingLimit = Math.round(
      (retrievalLimit * embeddingWeight) / totalWeight
    );
    const bm25Limit = Math.round((retrievalLimit * bm25Weight) / totalWeight);
    const fullOptions = { ...options, retrievalLimit };

    const retrievalStart = performance.now();
    const retrieval = await this.retriever.retrieveContentChunks(
      query,
      fullOptions,
      embeddingWeight,
      bm25Weight,
      { embeddingLimit, bm25Limit }
    );
    const retrievalTimeMs = performance.now() - retrievalStart;

    this.retriever.logContentRetrieval('Chunk rerank retrieval', retrieval);

    const embeddingChunks = [
      ...retrieval.textEmbeddingChunks,
      ...retrieval.imageEmbeddingChunks,
    ];
    const mergedChunks = mergeAndDeduplicateChunks(
      embeddingChunks,
      retrieval.bm25Chunks
    );

    if (mergedChunks.length === 0) {
      return {
        results: [],
        metadata: {
          embeddingChunkCount: 0,
          bm25ChunkCount: 0,
          mergedChunkCount: 0,
          retrievalTimeMs,
          rerankTimeMs: 0,
          totalTimeMs: performance.now() - totalStart,
        },
      };
    }

    const rerankStart = performance.now();
    const { results } = await this.rerankService.rerankChunks(
      query,
      mergedChunks,
      {
        prependTitle: options.prependTitleToChunks ?? true,
        topK: options.topK,
        aggOptions: this.retriever.getAggOptions(),
      }
    );
    const rerankTimeMs = performance.now() - rerankStart;

    return {
      results,
      metadata: {
        embeddingChunkCount: embeddingChunks.length,
        bm25ChunkCount: retrieval.bm25Chunks.length,
        mergedChunkCount: mergedChunks.length,
        retrievalTimeMs,
        rerankTimeMs,
        totalTimeMs: performance.now() - totalStart,
      },
    };
  }

  private ensureImageRepresentation(
    combined: SearchResult[],
    contentResults: SearchResult[],
    limit: number
  ): SearchResult[] {
    const imageCount = combined.filter(r => isImageFilePath(r.filePath)).length;
    const maxImageSlots = Math.ceil(limit * 0.3);
    if (imageCount >= maxImageSlots) return combined;

    const includedPaths = new Set(combined.map(r => r.filePath));
    const topImages = contentResults
      .filter(
        r => isImageFilePath(r.filePath) && !includedPaths.has(r.filePath)
      )
      .slice(0, maxImageSlots - imageCount);

    if (topImages.length === 0) return combined;

    const textResults = combined.filter(r => !isImageFilePath(r.filePath));
    const existingImages = combined.filter(r => isImageFilePath(r.filePath));
    const textSlots = limit - existingImages.length - topImages.length;

    const result = [
      ...textResults.slice(0, textSlots),
      ...existingImages,
      ...topImages,
    ];
    result.sort((a, b) => b.score - a.score);
    return result;
  }
}
