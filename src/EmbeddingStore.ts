import type { ConfigManager } from './ConfigManager';
import { STORE_EMBEDDINGS } from './MetadataStore';
import { WithLogging } from './WithLogging';

export interface EmbeddingData {
  id: string;
  embedding: number[];
}

export class EmbeddingStore extends WithLogging {
  protected readonly componentName = 'EmbeddingStore';
  private embeddingsCache: EmbeddingData[] | null = null;

  constructor(
    private db: IDBDatabase,
    protected configManager: ConfigManager
  ) {
    super();
    this.log('Initialized');
  }

  async addEmbeddings(
    embeddings: Array<{ id: string; embedding: number[] }>
  ): Promise<void> {
    if (embeddings.length === 0) return;

    this.log(`Indexing ${embeddings.length} embeddings...`);

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);

      for (const emb of embeddings) {
        store.put({ id: emb.id, embedding: emb.embedding });
      }

      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log(`Indexed ${embeddings.length} embeddings`);
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to add embeddings'));
    });
  }

  async deleteEmbeddings(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;

    this.log(`Deleting ${chunkIds.length} embeddings...`);

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      for (const id of chunkIds) {
        store.delete(id);
      }
      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log(`Deleted ${chunkIds.length} embeddings`);
        resolve();
      };
      transaction.onerror = () =>
        reject(new Error('Failed to delete embeddings'));
    });
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      store.clear();

      transaction.oncomplete = () => {
        this.invalidateCache();
        this.log('All data cleared');
        resolve();
      };
      transaction.onerror = () => reject(new Error('Failed to clear store'));
    });
  }

  private invalidateCache(): void {
    this.embeddingsCache = null;
  }

  async getEmbedding(id: string): Promise<number[] | null> {
    if (this.embeddingsCache) {
      const found = this.embeddingsCache.find(e => e.id === id);
      return found?.embedding ?? null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readonly');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      const request = store.get(id);
      request.onsuccess = () => {
        const data = request.result as EmbeddingData | undefined;
        resolve(data?.embedding ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllEmbeddings(): Promise<EmbeddingData[]> {
    if (this.embeddingsCache) {
      return this.embeddingsCache;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_EMBEDDINGS], 'readonly');
      const store = transaction.objectStore(STORE_EMBEDDINGS);
      const request = store.getAll();
      request.onsuccess = () => {
        this.embeddingsCache = request.result as EmbeddingData[];
        resolve(this.embeddingsCache);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
