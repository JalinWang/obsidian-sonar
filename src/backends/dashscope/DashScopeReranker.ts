import type { ConfigManager } from '../../config/ConfigManager';
import type {
  Reranker,
  RerankDocument,
  RerankResult,
} from '../../core/Reranker';
import type { ModelStatus } from '../../core/SonarState';
import { WithLogging } from '../../core/WithLogging';
import {
  dashscopeMultimodalRerank,
  dashscopeRerank,
  estimateDashScopeTokens,
} from './dashscopeApi';

const DEFAULT_CONTEXT_SIZE = 4000;

export class DashScopeReranker extends WithLogging implements Reranker {
  protected readonly componentName = 'DashScopeReranker';

  private _status: ModelStatus = 'uninitialized';

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    protected configManager: ConfigManager,
    private onStatusChange: (status: ModelStatus) => void,
    multimodal: boolean = false
  ) {
    super();
    if (multimodal) {
      this.rerankMultimodal = this._rerankMultimodal.bind(this);
    }
  }

  get status(): ModelStatus {
    return this._status;
  }

  get contextSize(): number | null {
    return DEFAULT_CONTEXT_SIZE;
  }

  private setStatus(status: ModelStatus): void {
    this._status = status;
    this.onStatusChange(status);
  }

  async initialize(): Promise<void> {
    this.setStatus('initializing');
    try {
      this.log(`Initializing with model: ${this.model}`);

      await dashscopeRerank(
        this.baseUrl,
        this.apiKey,
        this.model,
        'test',
        ['test document'],
        1
      );

      this.log('Initialized');
      this.setStatus('ready');
    } catch (error) {
      this.setStatus('failed');
      this.error(
        `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]> {
    if (this._status !== 'ready') {
      throw new Error('Reranker not initialized. Call initialize() first.');
    }
    return dashscopeRerank(
      this.baseUrl,
      this.apiKey,
      this.model,
      query,
      documents,
      topN ?? documents.length
    );
  }

  rerankMultimodal?: (
    query: string,
    documents: RerankDocument[],
    topN?: number
  ) => Promise<RerankResult[]>;

  private async _rerankMultimodal(
    query: string,
    documents: RerankDocument[],
    topN?: number
  ): Promise<RerankResult[]> {
    if (this._status !== 'ready') {
      throw new Error('Reranker not initialized. Call initialize() first.');
    }
    // this.log("rerankMultimodal: \n" +
    //   JSON.stringify({
    //     input: { query, documents },
    //   })
    // );
    return dashscopeMultimodalRerank(
      this.baseUrl,
      this.apiKey,
      this.model,
      { text: query },
      documents,
      topN ?? documents.length
    );
  }

  async countTokens(text: string): Promise<number> {
    return estimateDashScopeTokens(text);
  }

  isReady(): boolean {
    return this._status === 'ready';
  }

  async cleanup(): Promise<void> {
    this.log('Completed cleanup');
  }
}
