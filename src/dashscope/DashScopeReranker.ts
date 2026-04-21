import type { ConfigManager } from '../ConfigManager';
import type { Reranker, RerankResult } from '../Reranker';
import type { ModelStatus } from '../SonarState';
import { WithLogging } from '../WithLogging';
import { dashscopeRerank } from './dashscopeApi';

const DEFAULT_CONTEXT_SIZE = 4000;

export class DashScopeReranker extends WithLogging implements Reranker {
  protected readonly componentName = 'DashScopeReranker';

  private _status: ModelStatus = 'uninitialized';

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    protected configManager: ConfigManager,
    private onStatusChange: (status: ModelStatus) => void
  ) {
    super();
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

  async countTokens(text: string): Promise<number> {
    let count = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      count += code > 0x7f ? 2 : 1;
    }
    return Math.ceil(count / 3);
  }

  isReady(): boolean {
    return this._status === 'ready';
  }

  async cleanup(): Promise<void> {
    this.log('Completed cleanup');
  }
}
