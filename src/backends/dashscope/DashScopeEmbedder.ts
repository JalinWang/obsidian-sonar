import type { ConfigManager } from '../../config/ConfigManager';
import type { Embedder, MultimodalInput } from '../../core/Embedder';
import type { ModelStatus } from '../../core/SonarState';
import { WithLogging } from '../../core/WithLogging';
import { dashscopeEmbedding, estimateDashScopeTokens } from './dashscopeApi';

const BATCH_SIZE = 20;

export class DashScopeEmbedder extends WithLogging implements Embedder {
  protected readonly componentName = 'DashScopeEmbedder';

  private _status: ModelStatus = 'uninitialized';

  private _dimension: number;

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    dimension: number,
    protected configManager: ConfigManager,
    private onStatusChange: (status: ModelStatus) => void,
    multimodal: boolean = false
  ) {
    super();
    this._dimension = dimension;
    if (multimodal) {
      this.getImageEmbedding = this._getImageEmbedding.bind(this);
    }
  }

  get status(): ModelStatus {
    return this._status;
  }

  get contextSize(): number | null {
    return 8192;
  }

  get dimension(): number {
    return this._dimension;
  }

  private setStatus(status: ModelStatus): void {
    this._status = status;
    this.onStatusChange(status);
  }

  async initialize(): Promise<void> {
    this.setStatus('initializing');
    try {
      this.log(
        `Initializing with model: ${this.model} (dimension: ${this._dimension})`
      );

      await dashscopeEmbedding(
        this.baseUrl,
        this.apiKey,
        this.model,
        [{ text: 'test' }],
        this._dimension
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

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (this._status !== 'ready') {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    const inputs: MultimodalInput[] = texts.map(t => ({ text: t }));
    const allEmbeddings: number[][] = new Array(texts.length);

    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);
      const batchResult = await dashscopeEmbedding(
        this.baseUrl,
        this.apiKey,
        this.model,
        batch,
        this._dimension
      );
      for (let j = 0; j < batchResult.length; j++) {
        allEmbeddings[i + j] = batchResult[j];
      }
    }

    return allEmbeddings;
  }

  getImageEmbedding?: (input: MultimodalInput) => Promise<number[]>;

  private async _getImageEmbedding(input: MultimodalInput): Promise<number[]> {
    if (this._status !== 'ready') {
      throw new Error('Embedder not initialized. Call initialize() first.');
    }
    const results = await dashscopeEmbedding(
      this.baseUrl,
      this.apiKey,
      this.model,
      [input],
      this._dimension
    );
    return results[0];
  }

  async countTokens(text: string): Promise<number> {
    return estimateDashScopeTokens(text);
  }

  async cleanup(): Promise<void> {
    this.log('Completed cleanup');
  }
}
