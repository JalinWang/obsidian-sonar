import {
  ZVecInitialize,
  ZVecLogLevel,
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  isZVecError,
  type ZVecCollection,
} from '@zvec/zvec';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { ChunkId } from './chunkId';

const COLLECTION_NAME = 'sonar_embeddings';
const VECTOR_FIELD = 'embedding';
const IDB_STORE_EMBEDDINGS = 'embeddings';

let zvecInitialized = false;

function ensureZVecInitialized(): void {
  if (!zvecInitialized) {
    ZVecInitialize({ logLevel: ZVecLogLevel.WARN });
    zvecInitialized = true;
  }
}

function buildSchema(dimension: number): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name: COLLECTION_NAME,
    fields: [
      {
        name: 'filePath',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
      {
        name: 'chunkType',
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
    ],
    vectors: [
      {
        name: VECTOR_FIELD,
        dataType: ZVecDataType.VECTOR_FP32,
        dimension,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE,
        },
      },
    ],
  });
}

export class ZvecEmbeddingStore extends WithLogging {
  protected readonly componentName = 'ZvecEmbeddingStore';

  private constructor(
    private collection: ZVecCollection,
    private collectionPath: string,
    private dimension: number,
    protected configManager: ConfigManager
  ) {
    super();
  }

  static async initialize(
    collectionPath: string,
    dimension: number,
    configManager: ConfigManager
  ): Promise<ZvecEmbeddingStore> {
    ensureZVecInitialized();

    let collection: ZVecCollection;
    try {
      collection = ZVecOpen(collectionPath);
    } catch (e) {
      if (isZVecError(e) && e.code === 'ZVEC_NOT_FOUND') {
        const schema = buildSchema(dimension);
        collection = ZVecCreateAndOpen(collectionPath, schema);
      } else {
        throw e;
      }
    }

    const store = new ZvecEmbeddingStore(
      collection,
      collectionPath,
      dimension,
      configManager
    );
    store.log(
      `Initialized at ${collectionPath} (${collection.stats.docCount} docs)`
    );
    return store;
  }

  async addEmbeddings(
    items: Array<{
      id: string;
      embedding: number[];
      filePath: string;
      chunkType: 'title' | 'content';
    }>
  ): Promise<void> {
    if (items.length === 0) return;

    this.log(`Indexing ${items.length} embeddings...`);

    const docs = items.map(item => ({
      id: item.id,
      vectors: { [VECTOR_FIELD]: item.embedding },
      fields: { filePath: item.filePath, chunkType: item.chunkType },
    }));

    this.collection.upsertSync(docs);
    this.log(`Indexed ${items.length} embeddings`);
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    this.log(`Deleting ${ids.length} embeddings...`);
    this.collection.deleteSync(ids);
    this.log(`Deleted ${ids.length} embeddings`);
  }

  search(
    queryVector: number[],
    topk: number,
    chunkType?: 'title' | 'content'
  ): Array<{ id: string; score: number }> {
    const filter = chunkType ? `chunkType == '${chunkType}'` : undefined;
    const results = this.collection.querySync({
      fieldName: VECTOR_FIELD,
      vector: queryVector,
      topk,
      filter,
      outputFields: [],
    });
    return results.map(doc => ({ id: doc.id, score: doc.score }));
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');
    this.collection.destroySync();
    const schema = buildSchema(this.dimension);
    this.collection = ZVecCreateAndOpen(this.collectionPath, schema);
    this.log('All data cleared');
  }

  async optimize(): Promise<void> {
    this.log('Optimizing vector index...');
    this.collection.optimizeSync();
    this.log('Vector index optimized');
  }

  close(): void {
    this.collection.closeSync();
  }

  destroy(): void {
    this.collection.destroySync();
  }

  /**
   * One-time migration: reads embeddings from the IDB `embeddings` object
   * store, upserts them into the zvec collection, and clears the IDB store.
   * Returns the number of migrated embeddings (0 means nothing to migrate).
   */
  static async migrateFromIDB(
    db: IDBDatabase,
    zvecStore: ZvecEmbeddingStore
  ): Promise<number> {
    if (!db.objectStoreNames.contains(IDB_STORE_EMBEDDINGS)) {
      return 0;
    }

    const embeddings = await new Promise<
      Array<{ id: string; embedding: number[] }>
    >((resolve, reject) => {
      const transaction = db.transaction([IDB_STORE_EMBEDDINGS], 'readonly');
      const store = transaction.objectStore(IDB_STORE_EMBEDDINGS);
      const request = store.getAll();
      request.onsuccess = () =>
        resolve(request.result as Array<{ id: string; embedding: number[] }>);
      request.onerror = () =>
        reject(new Error('Failed to read embeddings from IndexedDB'));
    });

    if (embeddings.length === 0) {
      return 0;
    }

    zvecStore.log(
      `Migrating ${embeddings.length} embeddings from IndexedDB...`
    );

    const items = embeddings.map(emb => ({
      id: emb.id,
      embedding: emb.embedding,
      filePath: ChunkId.getFilePath(emb.id),
      chunkType: (ChunkId.isTitle(emb.id) ? 'title' : 'content') as
        | 'title'
        | 'content',
    }));

    await zvecStore.addEmbeddings(items);

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([IDB_STORE_EMBEDDINGS], 'readwrite');
      const store = transaction.objectStore(IDB_STORE_EMBEDDINGS);
      store.clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error('Failed to clear embeddings from IndexedDB'));
    });

    zvecStore.log(`Migrated ${embeddings.length} embeddings from IndexedDB`);
    return embeddings.length;
  }
}
