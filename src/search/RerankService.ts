import type { Reranker, RerankDocument, RerankResult } from '../core/Reranker';
import type { ConfigManager } from '../config/ConfigManager';
import type { ChunkResult, SearchResult } from '../core/search-types';
import { truncateTextToTokens } from './QueryProcessor';
import { isImageFilePath } from '../indexing/fileFilters';
import { WithLogging } from '../core/WithLogging';
import { aggregateChunksToFiles } from './SearchResultFusion';
import type { AggOptions } from './HybridRetriever';

export class RerankService extends WithLogging {
  protected readonly componentName = 'RerankService';

  constructor(
    private reranker: Reranker,
    protected configManager: ConfigManager,
    private readImageBase64?: (filePath: string) => Promise<string | null>
  ) {
    super();
  }

  isReady(): boolean {
    return this.reranker.isReady();
  }

  async rerankDocuments(
    query: string,
    results: SearchResult[],
    topK: number
  ): Promise<SearchResult[]> {
    const documents = results.map(r => r.topChunk.content);
    const fittedQuery = await this.fitQueryToRerankerContext(query, documents);

    const rerankResults = this.reranker.rerankMultimodal
      ? await this.rerankWithMultimodal(
          fittedQuery,
          results.map(r => ({
            content: r.topChunk.content,
            filePath: r.filePath,
          })),
          topK
        )
      : await this.reranker.rerank(fittedQuery, documents, topK);

    const reranked = rerankResults.map(r => ({
      result: results[r.index],
      score: r.relevanceScore,
    }));
    const textReranked = reranked.filter(
      r => !isImageFilePath(r.result.filePath)
    );
    const imageReranked = reranked.filter(r =>
      isImageFilePath(r.result.filePath)
    );
    this.log(
      `Doc rerank results: text=${textReranked.length} (top=${textReranked[0]?.score.toFixed(4) ?? '-'}), ` +
        `image=${imageReranked.length} (top=${imageReranked[0]?.score.toFixed(4) ?? '-'})`
    );
    this.log(
      `Doc rerank details:\n` +
        reranked
          .map(
            r =>
              `  ${r.score.toFixed(4)}  ${r.result.filePath} (${isImageFilePath(r.result.filePath) ? 'image' : 'text'})`
          )
          .join('\n')
    );

    return this.normalizeRerankResults(results, rerankResults);
  }

  async rerankChunks(
    query: string,
    chunks: ChunkResult[],
    options?: {
      prependTitle?: boolean;
      topK?: number;
      aggOptions?: AggOptions;
    }
  ): Promise<{ results: SearchResult[]; rerankedChunks: ChunkResult[] }> {
    const prependTitle = options?.prependTitle ?? true;
    const documents = chunks.map(c => {
      if (!prependTitle) return c.content;
      const title = c.metadata.title || '';
      return title ? `${title}\n\n${c.content}` : c.content;
    });
    const fittedQuery = await this.fitQueryToRerankerContext(query, documents);

    const rerankResults = this.reranker.rerankMultimodal
      ? await this.rerankWithMultimodal(
          fittedQuery,
          chunks.map((c, i) => ({
            content: documents[i],
            filePath: c.filePath,
          })),
          undefined
        )
      : await this.reranker.rerank(fittedQuery, documents);

    const rerankedChunks: ChunkResult[] = rerankResults.map(r => ({
      ...chunks[r.index],
      score: r.relevanceScore,
    }));

    const rerankedText = rerankedChunks.filter(
      c => !isImageFilePath(c.filePath)
    );
    const rerankedImages = rerankedChunks.filter(c =>
      isImageFilePath(c.filePath)
    );
    this.log(
      `Chunk rerank results: text=${rerankedText.length} (top=${rerankedText[0]?.score.toFixed(4) ?? '-'}), ` +
        `image=${rerankedImages.length} (top=${rerankedImages[0]?.score.toFixed(4) ?? '-'})`
    );

    const aggOptions = options?.aggOptions ?? {
      method: this.configManager.get('vectorAggMethod'),
      m: this.configManager.get('aggM'),
      l: this.configManager.get('aggL'),
      decay: this.configManager.get('aggDecay'),
      rrfK: this.configManager.get('aggRrfK'),
    };
    const results = aggregateChunksToFiles(rerankedChunks, aggOptions);
    this.normalizeAggregatedScores(results);

    const topK = options?.topK;
    return {
      results: topK !== undefined ? results.slice(0, topK) : results,
      rerankedChunks,
    };
  }

  async rerankChunksForRAG(
    query: string,
    chunks: ChunkResult[],
    maxChunks: number
  ): Promise<ChunkResult[]> {
    const documents = chunks.map(c => {
      const title = c.metadata.title || '';
      return title ? `${title}\n\n${c.content}` : c.content;
    });
    const fittedQuery = await this.fitQueryToRerankerContext(query, documents);

    const rerankResults = this.reranker.rerankMultimodal
      ? await this.rerankWithMultimodal(
          fittedQuery,
          chunks.map((c, i) => ({
            content: documents[i],
            filePath: c.filePath,
          })),
          maxChunks
        )
      : await this.reranker.rerank(fittedQuery, documents, maxChunks);

    const rerankedResult = rerankResults.map(r => ({
      ...chunks[r.index],
      score: r.relevanceScore,
    }));
    const ragText = rerankedResult.filter(c => !isImageFilePath(c.filePath));
    const ragImages = rerankedResult.filter(c => isImageFilePath(c.filePath));
    this.log(
      `RAG rerank results: text=${ragText.length} (top=${ragText[0]?.score.toFixed(4) ?? '-'}), ` +
        `image=${ragImages.length} (top=${ragImages[0]?.score.toFixed(4) ?? '-'})`
    );

    return rerankedResult;
  }

  private async fitQueryToRerankerContext(
    query: string,
    documents: string[]
  ): Promise<string> {
    const contextSize = this.reranker.contextSize;
    if (contextSize === null || documents.length === 0) {
      return query;
    }
    const SAFETY_MARGIN = 32;
    const docTokenCounts = await Promise.all(
      documents.map(d => this.reranker.countTokens(d))
    );
    const maxDocTokens = Math.max(...docTokenCounts);
    const queryBudget = contextSize - maxDocTokens - SAFETY_MARGIN;
    if (queryBudget <= 0) {
      this.warn(
        `Reranker context (${contextSize}) too small for documents ` +
          `(max ${maxDocTokens} tokens). Passing query through untruncated.`
      );
      return query;
    }
    const queryTokens = await this.reranker.countTokens(query);
    if (queryTokens <= queryBudget) {
      return query;
    }
    this.log(
      `Truncating query for reranker: ${queryTokens} -> ${queryBudget} tokens ` +
        `(context=${contextSize}, max doc=${maxDocTokens})`
    );
    return truncateTextToTokens(query, queryBudget, this.reranker);
  }

  private async rerankWithMultimodal(
    query: string,
    items: Array<{ content: string; filePath: string }>,
    topN?: number
  ): Promise<RerankResult[]> {
    const documents: RerankDocument[] = await Promise.all(
      items.map(async item => {
        if (isImageFilePath(item.filePath) && this.readImageBase64) {
          const base64 = await this.readImageBase64(item.filePath);
          if (base64) return { image: base64 };
        }
        return { text: item.content };
      })
    );
    return this.reranker.rerankMultimodal!(query, documents, topN);
  }

  private normalizeRerankResults(
    results: SearchResult[],
    rerankResults: RerankResult[]
  ): SearchResult[] {
    const maxScore = Math.max(...rerankResults.map(r => r.relevanceScore));
    const minScore = Math.min(...rerankResults.map(r => r.relevanceScore));
    const scoreRange = maxScore - minScore;

    return rerankResults.map(r => ({
      ...results[r.index],
      score: scoreRange > 0 ? (r.relevanceScore - minScore) / scoreRange : 1,
    }));
  }

  private normalizeAggregatedScores(results: SearchResult[]): void {
    if (results.length === 0) return;
    const maxScore = results[0].score;
    const minScore = results[results.length - 1].score;
    const scoreRange = maxScore - minScore;
    for (const result of results) {
      result.score =
        scoreRange > 0 ? (result.score - minScore) / scoreRange : 1;
    }
  }
}
