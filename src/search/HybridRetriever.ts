import { EmbeddingSearch } from './EmbeddingSearch';
import { BM25Search } from './BM25Search';
import type { ConfigManager } from '../config/ConfigManager';
import type {
  ChunkResult,
  SearchResult,
  FullSearchOptions,
} from '../core/search-types';
import { fuseFileResults, aggregateChunksToFiles } from './SearchResultFusion';
import { WithLogging } from '../core/WithLogging';
import { isImageFilePath } from '../indexing/fileFilters';
import type { AggregationMethod } from './ChunkAggregation';

export interface RetrievalResult {
  textEmbeddingChunks: ChunkResult[];
  imageEmbeddingChunks: ChunkResult[];
  bm25Chunks: ChunkResult[];
}

export interface AggOptions {
  method: AggregationMethod;
  m: number;
  l: number;
  decay: number;
  rrfK: number;
}

export interface RetrievalLimits {
  embeddingLimit: number;
  bm25Limit: number;
}

export class HybridRetriever extends WithLogging {
  protected readonly componentName = 'HybridRetriever';

  constructor(
    private embeddingSearch: EmbeddingSearch,
    private bm25Search: BM25Search,
    protected configManager: ConfigManager
  ) {
    super();
  }

  getAggOptions(): AggOptions {
    return {
      method: this.configManager.get('vectorAggMethod'),
      m: this.configManager.get('aggM'),
      l: this.configManager.get('aggL'),
      decay: this.configManager.get('aggDecay'),
      rrfK: this.configManager.get('aggRrfK'),
    };
  }

  getBm25AggOptions(): AggOptions {
    return {
      ...this.getAggOptions(),
      method: this.configManager.get('bm25AggMethod'),
    };
  }

  async retrieveContentChunks(
    query: string,
    options: FullSearchOptions,
    embeddingWeight: number,
    bm25Weight: number,
    limits?: RetrievalLimits
  ): Promise<RetrievalResult> {
    const embeddingLimit = limits?.embeddingLimit ?? options.retrievalLimit;
    const bm25Limit = limits?.bm25Limit ?? options.retrievalLimit;

    const [textEmbeddingChunks, imageEmbeddingChunks, bm25Chunks] =
      await Promise.all([
        embeddingWeight > 0
          ? this.embeddingSearch.searchContent(query, {
              ...options,
              retrievalLimit: embeddingLimit,
              modality: 'text',
            })
          : Promise.resolve([]),
        embeddingWeight > 0
          ? this.embeddingSearch.searchContent(query, {
              ...options,
              retrievalLimit: embeddingLimit,
              modality: 'image',
            })
          : Promise.resolve([]),
        bm25Weight > 0
          ? this.bm25Search.searchContent(query, {
              ...options,
              retrievalLimit: bm25Limit,
            })
          : Promise.resolve([]),
      ]);

    return { textEmbeddingChunks, imageEmbeddingChunks, bm25Chunks };
  }

  logContentRetrieval(label: string, retrieval: RetrievalResult): void {
    const { textEmbeddingChunks, imageEmbeddingChunks, bm25Chunks } = retrieval;
    this.log(
      `${label}: text=${textEmbeddingChunks.length} chunks (embedding) + ${bm25Chunks.length} chunks (BM25), ` +
        `image=${imageEmbeddingChunks.length} chunks (embedding-only)`
    );
    this.logChunkTopResults('text embedding', textEmbeddingChunks);
    this.logChunkTopResults('BM25', bm25Chunks);
    this.logChunkTopResults('image embedding', imageEmbeddingChunks);
  }

  async retrieveTitleResults(
    query: string,
    options: FullSearchOptions,
    embeddingWeight: number,
    bm25Weight: number
  ): Promise<SearchResult[]> {
    const [embeddingResults, bm25Results] = await Promise.all([
      embeddingWeight > 0
        ? this.embeddingSearch.searchTitle(query, options)
        : Promise.resolve([]),
      bm25Weight > 0
        ? this.bm25Search.searchTitle(query, options)
        : Promise.resolve([]),
    ]);

    if (embeddingWeight === 0) return bm25Results;
    if (bm25Weight === 0) return embeddingResults;

    return fuseFileResults(
      embeddingResults,
      bm25Results,
      embeddingWeight,
      bm25Weight
    );
  }

  async retrieveByVector(
    queryEmbedding: number[],
    options: FullSearchOptions
  ): Promise<ChunkResult[]> {
    const embeddingChunks = await this.embeddingSearch.searchContentByVector(
      queryEmbedding,
      options
    );

    const textChunks = embeddingChunks.filter(
      c => !isImageFilePath(c.filePath)
    );
    const imageChunks = embeddingChunks.filter(c =>
      isImageFilePath(c.filePath)
    );
    this.log(
      `Vector search: text=${textChunks.length} chunks, image=${imageChunks.length} chunks`
    );

    return embeddingChunks;
  }

  fuseContentToFiles(
    retrieval: RetrievalResult,
    embeddingWeight: number,
    bm25Weight: number
  ): SearchResult[] {
    const { textEmbeddingChunks, imageEmbeddingChunks, bm25Chunks } = retrieval;
    const aggOptions = this.getAggOptions();
    const bm25AggOptions = this.getBm25AggOptions();

    const textEmbeddingResults = aggregateChunksToFiles(
      textEmbeddingChunks,
      aggOptions
    );
    const bm25Results = aggregateChunksToFiles(bm25Chunks, bm25AggOptions);

    let textResults: SearchResult[];
    if (embeddingWeight === 0) {
      textResults = bm25Results;
    } else if (bm25Weight === 0) {
      textResults = textEmbeddingResults;
    } else {
      textResults = fuseFileResults(
        textEmbeddingResults,
        bm25Results,
        embeddingWeight,
        bm25Weight
      );
    }

    const imageResults = aggregateChunksToFiles(
      imageEmbeddingChunks,
      aggOptions
    );

    if (imageResults.length === 0) return textResults;
    if (textResults.length === 0) return imageResults;

    const merged = [...textResults, ...imageResults];
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  getEmbedding(chunkId: string): Promise<number[] | null> {
    return this.embeddingSearch.getEmbedding(chunkId);
  }

  private logChunkTopResults(label: string, chunks: ChunkResult[]): void {
    if (chunks.length === 0) return;
    const sorted = [...chunks].sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, 10);
    const lines = top.map(c => `  ${c.score.toFixed(4)}  ${c.chunkId}`);
    this.log(`${label} top chunks:\n${lines.join('\n')}`);
  }
}
