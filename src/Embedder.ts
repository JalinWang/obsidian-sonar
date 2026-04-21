import type { ModelStatus } from './SonarState';

export interface MultimodalInput {
  text?: string;
  image?: string;
}

export interface Embedder {
  readonly status: ModelStatus;
  readonly contextSize: number | null;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  getEmbeddings(texts: string[]): Promise<number[][]>;
  getImageEmbedding?(input: MultimodalInput): Promise<number[]>;
  countTokens(text: string): Promise<number>;
}
