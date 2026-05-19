import type { ZVecCollection } from '@zvec/zvec';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import { ChunkId } from './chunkId';
import { isImageExtension } from './fileFilters';
import { createHash } from 'crypto';
import * as path from 'path';

const COLLECTION_NAME = 'sonar_embeddings';
const ZVEC_MAX_BATCH_SIZE = 1024;
const VECTOR_FIELD = 'embedding';
const IDB_STORE_EMBEDDINGS = 'embeddings';
const MIGRATION_SENTINEL_ID = '__zvec_migration_v1';

// Shape of the object exported by zvec_node_binding.node.
// This intentionally avoids importing @zvec/zvec as a value (only as a type)
// so that esbuild never emits a require('@zvec/zvec') call. In Obsidian,
// plugins are loaded under a virtual plugin: URL scheme, which prevents
// Electron's module resolver from walking node_modules by name. The binary
// is therefore loaded using an absolute path determined at runtime.
interface ZvecBinding {
  DataType: { STRING: unknown; VECTOR_FP32: unknown };
  IndexType: { INVERT: unknown; HNSW: unknown };
  MetricType: { COSINE: unknown };
  LogLevel: { WARN: unknown };
  CollectionSchema: new (schema: object) => object;
  initialize: (opts: object) => void;
  createAndOpen: (collectionPath: string, schema: object) => ZVecCollection;
  open: (collectionPath: string) => ZVecCollection;
  Collection: { prototype: Record<string, unknown> };
}

let cachedBinding: ZvecBinding | null = null;
let zvecInitialized = false;

// Absolute path to the plugin directory; must be set before the first call to
// initialize(). In main.ts this is derived from app.vault.adapter.getBasePath()
// combined with this.manifest.dir.
let zvecPluginDir: string | null = null;

export function configureZvecPluginDir(dir: string): void {
  zvecPluginDir = dir;
}

// Converts an arbitrary chunk ID to a zvec-safe document primary key.
//
// zvec requires: ^[a-zA-Z0-9_!@#$%+=.-]{1,64}$
// Chunk IDs contain '/' (path separators) and can exceed 64 characters, so
// they cannot be stored directly as zvec doc IDs. SHA-256 hex output is
// exactly 64 lowercase hex characters, which always satisfies the regex.
// The original chunk ID is preserved in the `chunkId` scalar field.
function zvecDocId(chunkId: string): string {
  return createHash('sha256').update(chunkId).digest('hex');
}

function loadBinding(): ZvecBinding {
  if (cachedBinding) return cachedBinding;
  if (!zvecPluginDir) {
    throw new Error(
      'ZvecEmbeddingStore: plugin directory not configured. ' +
        'Call configureZvecPluginDir() before initializing the store.'
    );
  }

  const bindingPath = path.join(
    zvecPluginDir,
    'node_modules',
    '@zvec',
    `bindings-${process.platform}-${process.arch}`,
    'zvec_node_binding.node'
  );

  // window.require() loads through Electron's module system with the
  // delay-load hook active, so node.exe symbols resolve from Obsidian.exe.
  // An absolute path is required because the plugin: URL scheme prevents
  // bare package-name resolution for native addons.
  let binding: ZvecBinding;
  try {
    binding = (window as any).require(bindingPath) as ZvecBinding;
  } catch (err) {
    throw new Error(
      `Failed to load native binding from "${bindingPath}": ${String(err)}`
    );
  }

  // Add querySync prototype method (replicates @zvec/zvec/src/index.js)
  binding.Collection.prototype['querySync'] = function (queryObj: unknown) {
    if (arguments.length !== 1) {
      const err = new Error(
        'Collection.querySync(): Expected exactly 1 argument. Argument must be an Query object'
      );
      Object.assign(err, {
        name: 'InvalidArgumentError',
        code: 'ZVEC_INVALID_ARGUMENT',
      });
      throw err;
    }
    if (queryObj === null || typeof queryObj !== 'object') {
      const err = new Error(
        'Collection.querySync(): Expected exactly 1 argument. Argument must be an Query object'
      );
      Object.assign(err, {
        name: 'InvalidArgumentError',
        code: 'ZVEC_INVALID_ARGUMENT',
      });
      throw err;
    }
    if ('vectors' in (queryObj as object)) {
      const err = new Error(
        'MultiQuery functionality has not been implemented yet.'
      );
      Object.assign(err, {
        name: 'NotSupportedError',
        code: 'ZVEC_NOT_SUPPORTED',
      });
      throw err;
    }
    return (this as { _internalQuery(q: unknown): unknown })._internalQuery(
      queryObj
    );
  };

  cachedBinding = binding;
  return binding;
}

function isZVecError(error: unknown): error is { name: string; code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { name?: unknown }).name === 'string' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('ZVEC_')
  );
}

function ensureZVecInitialized(): void {
  if (!zvecInitialized) {
    const binding = loadBinding();
    binding.initialize({ logLevel: binding.LogLevel.WARN });
    zvecInitialized = true;
  }
}

function buildSchema(dimension: number): object {
  const b = loadBinding();
  return new b.CollectionSchema({
    name: COLLECTION_NAME,
    fields: [
      // Stores the original chunk ID (which may contain '/' and exceed 64
      // chars). The zvec doc PK is its SHA-256 hex; this field is used to
      // recover the original ID from search results.
      {
        name: 'chunkId',
        dataType: b.DataType.STRING,
      },
      {
        name: 'filePath',
        dataType: b.DataType.STRING,
        indexParams: { indexType: b.IndexType.INVERT },
      },
      {
        name: 'chunkType',
        dataType: b.DataType.STRING,
        indexParams: { indexType: b.IndexType.INVERT },
      },
      {
        name: 'modality',
        dataType: b.DataType.STRING,
        indexParams: { indexType: b.IndexType.INVERT },
      },
    ],
    vectors: [
      {
        name: VECTOR_FIELD,
        dataType: b.DataType.VECTOR_FP32,
        dimension,
        indexParams: {
          indexType: b.IndexType.HNSW,
          metricType: b.MetricType.COSINE,
        },
      },
    ],
  });
}

function deriveModality(filePath: string): 'text' | 'image' {
  const ext = filePath.split('.').pop() ?? '';
  return isImageExtension(ext) ? 'image' : 'text';
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
    const binding = loadBinding();

    let collection: ZVecCollection;
    try {
      collection = binding.open(collectionPath);

      // Detect collections with outdated schemas and recreate them.
      const fields = collection.schema.fields();
      const hasChunkId = fields.some(f => f.name === 'chunkId');
      const hasModality = fields.some(f => f.name === 'modality');
      if (!hasChunkId || !hasModality) {
        collection.destroySync();
        const schema = buildSchema(dimension);
        collection = binding.createAndOpen(collectionPath, schema);
      }
    } catch (e) {
      if (
        isZVecError(e) &&
        (e.code === 'ZVEC_NOT_FOUND' || e.code === 'ZVEC_INVALID_ARGUMENT')
      ) {
        const schema = buildSchema(dimension);
        collection = binding.createAndOpen(collectionPath, schema);
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
      id: zvecDocId(item.id),
      vectors: { [VECTOR_FIELD]: item.embedding },
      fields: {
        chunkId: item.id,
        filePath: item.filePath,
        chunkType: item.chunkType,
        modality: deriveModality(item.filePath),
      },
    }));

    // zvec enforces a max write batch size of 1024 documents per upsertSync call.
    for (let i = 0; i < docs.length; i += ZVEC_MAX_BATCH_SIZE) {
      this.collection.upsertSync(docs.slice(i, i + ZVEC_MAX_BATCH_SIZE));
    }
    this.log(`Indexed ${items.length} embeddings`);
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    this.log(`Deleting ${ids.length} embeddings...`);
    try {
      this.collection.deleteSync(ids.map(zvecDocId));
    } catch (e) {
      this.error(`Failed to delete embeddings: ${e}`);
      throw e;
    }
    this.log(`Deleted ${ids.length} embeddings`);
  }

  search(
    queryVector: number[],
    topk: number,
    chunkType?: 'title' | 'content',
    modality?: 'text' | 'image'
  ): Array<{ id: string; score: number }> {
    const conditions: string[] = [];
    if (chunkType) conditions.push(`chunkType = '${chunkType}'`);
    if (modality) conditions.push(`modality = '${modality}'`);
    const filter = conditions.length > 0 ? conditions.join(' AND ') : undefined;

    const results = this.collection.querySync({
      fieldName: VECTOR_FIELD,
      vector: queryVector,
      topk,
      filter,
      outputFields: ['chunkId'],
    });
    // zvec COSINE metric returns cosine distance (0 = identical, 1 = orthogonal).
    // Downstream aggregation expects cosine similarity (1 = identical, 0 = orthogonal),
    // so invert the score here.
    return results.map(doc => ({
      id: doc.fields.chunkId as string,
      score: 1 - doc.score,
    }));
  }

  async clearAll(): Promise<void> {
    this.log('Clearing all data...');
    this.collection.destroySync();
    const schema = buildSchema(this.dimension);
    this.collection = loadBinding().createAndOpen(this.collectionPath, schema);
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
   * store and upserts them into the zvec collection. A sentinel record is
   * written to the IDB store to prevent re-migration on future startups.
   * The original IDB embeddings are kept intact.
   * Returns the number of migrated embeddings (0 means already done or
   * nothing to migrate).
   */
  static async migrateFromIDB(
    db: IDBDatabase,
    zvecStore: ZvecEmbeddingStore
  ): Promise<number> {
    if (!db.objectStoreNames.contains(IDB_STORE_EMBEDDINGS)) {
      return 0;
    }

    const alreadyMigrated = await new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction([IDB_STORE_EMBEDDINGS], 'readonly');
      const store = transaction.objectStore(IDB_STORE_EMBEDDINGS);
      const request = store.get(MIGRATION_SENTINEL_ID);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () =>
        reject(new Error('Failed to check migration sentinel in IndexedDB'));
    });

    if (alreadyMigrated) {
      zvecStore.log(` Already migrated.`);
      return 0;
    }

    const allRecords = await new Promise<
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

    const embeddings = allRecords.filter(
      r => r.id !== MIGRATION_SENTINEL_ID && r.embedding?.length > 0
    );

    if (embeddings.length > 0) {
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
      zvecStore.log(`Migrated ${embeddings.length} embeddings from IndexedDB`);
    }

    // await new Promise<void>((resolve, reject) => {
    //   const transaction = db.transaction([IDB_STORE_EMBEDDINGS], 'readwrite');
    //   const store = transaction.objectStore(IDB_STORE_EMBEDDINGS);
    //   store.put({ id: MIGRATION_SENTINEL_ID, embedding: [] });
    //   transaction.oncomplete = () => resolve();
    //   transaction.onerror = () =>
    //     reject(new Error('Failed to write migration sentinel to IndexedDB'));
    // });

    return embeddings.length;
  }
}
