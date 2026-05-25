import type { ModelStatus } from './SonarState';

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

export interface RerankDocument {
  text?: string;
  image?: string;
}

export interface Reranker {
  readonly status: ModelStatus;
  readonly contextSize: number | null;
  isReady(): boolean;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  rerank(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]>;
  rerankMultimodal?(
    query: string,
    documents: RerankDocument[],
    topN?: number
  ): Promise<RerankResult[]>;
  countTokens(text: string): Promise<number>;
}
