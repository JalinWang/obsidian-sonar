import { Notice } from 'obsidian';
import { SearchManager } from '../search/SearchManager';
import { EmbeddingSearch } from '../search/EmbeddingSearch';
import { BM25Store } from '../storage/BM25Store';
import { BM25Search } from '../search/BM25Search';
import { DEFAULT_SETTINGS } from '../config/config';
import { IndexManager } from '../indexing/IndexManager';
import { ConfigManager } from '../config/ConfigManager';
import { MetadataStore } from '../storage/MetadataStore';
import { EmbeddingStore } from '../storage/EmbeddingStore';
import {
  ZvecEmbeddingStore,
  configureZvecPluginDir,
} from '../storage/ZvecEmbeddingStore';
import type { Embedder } from '../core/Embedder';
import type { Reranker } from '../core/Reranker';
import { LlamaCppEmbedder } from '../backends/llamacpp/LlamaCppEmbedder';
import { LlamaCppReranker } from '../backends/llamacpp/LlamaCppReranker';
import { DashScopeEmbedder } from '../backends/dashscope/DashScopeEmbedder';
import { DashScopeReranker } from '../backends/dashscope/DashScopeReranker';
import { sonarState } from '../core/SonarState';
import { uint8ArrayToBase64 } from '../utils/utils';
import type SonarPlugin from '../../main';

export interface SonarServices {
  embedder: Embedder;
  reranker: Reranker;
  metadataStore: MetadataStore;
  zvecStore: ZvecEmbeddingStore;
  searchManager: SearchManager;
  indexManager: IndexManager;
}

export function getEmbedderModelIdentifier(
  configManager: ConfigManager
): string {
  const backend = configManager.get('embeddingBackend');
  if (backend === 'dashscope') {
    const model =
      configManager.get('dashscopeEmbeddingModel') ||
      DEFAULT_SETTINGS.dashscopeEmbeddingModel;
    const dimension =
      configManager.get('dashscopeEmbeddingDimension') ||
      DEFAULT_SETTINGS.dashscopeEmbeddingDimension;
    return `dashscope/${model}/${dimension}`;
  }
  const modelRepo =
    configManager.get('llamaEmbedderModelRepo') ||
    DEFAULT_SETTINGS.llamaEmbedderModelRepo;
  const modelFile =
    configManager.get('llamaEmbedderModelFile') ||
    DEFAULT_SETTINGS.llamaEmbedderModelFile;
  return `${modelRepo}/${modelFile}`;
}

function log(configManager: ConfigManager, msg: string): void {
  configManager.getLogger().log(`[Sonar.Plugin] ${msg}`);
}

function error(configManager: ConfigManager, msg: string): void {
  configManager.getLogger().error(`[Sonar.Plugin] ${msg}`);
}

function warn(configManager: ConfigManager, msg: string): void {
  configManager.getLogger().warn(`[Sonar.Plugin] ${msg}`);
}

function createConfirmDownload(
  plugin: SonarPlugin,
  modelType: string
): (modelId: string) => Promise<boolean> {
  return (modelId: string) => plugin.confirmModelDownload(modelType, modelId);
}

async function initializeEmbedder(
  configManager: ConfigManager,
  embedder: Embedder,
  backendName: string,
  modelDescription: string
): Promise<boolean> {
  try {
    await embedder.initialize();
    log(
      configManager,
      `${backendName} embedder initialized: ${modelDescription}`
    );
    return true;
  } catch (err) {
    error(
      configManager,
      `Failed to initialize ${backendName} embedder: ${err}`
    );
    new Notice(
      `Failed to initialize ${backendName} embedder.\n\n` +
        `Check console for details.\n\n` +
        `You can change settings and run "Sonar: Reinitialize Sonar" command to retry.`,
      0
    );
    await embedder.cleanup();
    return false;
  }
}

async function initializeReranker(
  configManager: ConfigManager,
  reranker: Reranker,
  modelDescription: string
): Promise<boolean> {
  try {
    await reranker.initialize();
    log(configManager, `Reranker initialized: ${modelDescription}`);
    return true;
  } catch (err) {
    warn(configManager, `Failed to initialize reranker: ${err}`);
    await reranker.cleanup();
    return false;
  }
}

export async function initializeSonar(
  plugin: SonarPlugin,
  configManager: ConfigManager
): Promise<SonarServices | null> {
  const embeddingBackend = configManager.get('embeddingBackend');
  const rerankBackend = configManager.get('rerankBackend');

  let embedder: Embedder;
  let embedderModelIdentifier: string;

  if (embeddingBackend === 'dashscope') {
    const apiKey = configManager.get('dashscopeApiKey');
    const baseUrl =
      configManager.get('dashscopeBaseUrl') ||
      DEFAULT_SETTINGS.dashscopeBaseUrl;
    const model =
      configManager.get('dashscopeEmbeddingModel') ||
      DEFAULT_SETTINGS.dashscopeEmbeddingModel;
    const dimension =
      configManager.get('dashscopeEmbeddingDimension') ||
      DEFAULT_SETTINGS.dashscopeEmbeddingDimension;
    embedderModelIdentifier = `dashscope/${model}/${dimension}`;
    const multimodal = configManager.get('embeddingMultimodal');
    embedder = new DashScopeEmbedder(
      apiKey,
      baseUrl,
      model,
      dimension,
      configManager,
      status => sonarState.setEmbedderStatus(status),
      multimodal
    );
  } else {
    const serverPath = configManager.get('llamacppServerPath');
    const embedderModelRepo =
      configManager.get('llamaEmbedderModelRepo') ||
      DEFAULT_SETTINGS.llamaEmbedderModelRepo;
    const embedderModelFile =
      configManager.get('llamaEmbedderModelFile') ||
      DEFAULT_SETTINGS.llamaEmbedderModelFile;
    embedderModelIdentifier = `${embedderModelRepo}/${embedderModelFile}`;
    embedder = new LlamaCppEmbedder(
      serverPath,
      embedderModelRepo,
      embedderModelFile,
      configManager,
      status => sonarState.setEmbedderStatus(status),
      (msg, duration) => new Notice(msg, duration),
      createConfirmDownload(plugin, 'embedder')
    );
  }

  let reranker: Reranker;
  let rerankerModelIdentifier: string;

  if (rerankBackend === 'dashscope') {
    const apiKey = configManager.get('dashscopeApiKey');
    const baseUrl =
      configManager.get('dashscopeBaseUrl') ||
      DEFAULT_SETTINGS.dashscopeBaseUrl;
    const model =
      configManager.get('dashscopeRerankModel') ||
      DEFAULT_SETTINGS.dashscopeRerankModel;
    rerankerModelIdentifier = `dashscope/${model}`;
    const rerankMultimodal = configManager.get('rerankMultimodal');
    reranker = new DashScopeReranker(
      apiKey,
      baseUrl,
      model,
      configManager,
      status => sonarState.setRerankerStatus(status),
      rerankMultimodal
    );
  } else {
    const serverPath = configManager.get('llamacppServerPath');
    const rerankerModelRepo =
      configManager.get('llamaRerankerModelRepo') ||
      DEFAULT_SETTINGS.llamaRerankerModelRepo;
    const rerankerModelFile =
      configManager.get('llamaRerankerModelFile') ||
      DEFAULT_SETTINGS.llamaRerankerModelFile;
    rerankerModelIdentifier = `${rerankerModelRepo}/${rerankerModelFile}`;
    reranker = new LlamaCppReranker(
      serverPath,
      rerankerModelRepo,
      rerankerModelFile,
      configManager,
      status => sonarState.setRerankerStatus(status),
      (msg, duration) => new Notice(msg, duration),
      createConfirmDownload(plugin, 'reranker')
    );
  }

  const [embedderInitialized] = await Promise.all([
    initializeEmbedder(
      configManager,
      embedder,
      embeddingBackend,
      embedderModelIdentifier
    ),
    initializeReranker(configManager, reranker, rerankerModelIdentifier),
  ]);
  if (!embedderInitialized) return null;

  sonarState.setMetadataStoreStatus('initializing');
  sonarState.setStatusBarText('Loading metadata store...');
  let metadataStore: MetadataStore;
  try {
    metadataStore = await MetadataStore.initialize(
      plugin.app.vault.getName(),
      embeddingBackend,
      embedderModelIdentifier,
      configManager
    );
  } catch (err) {
    sonarState.setMetadataStoreStatus('failed');
    error(configManager, `Failed to initialize metadata store: ${err}`);
    new Notice(
      'Failed to initialize metadata store.\n\n' +
        'Check console for details.\n\n' +
        'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
      0
    );
    return null;
  }

  sonarState.setMetadataStoreStatus('ready');

  const db = metadataStore.getDB();

  const basePath = (
    plugin.app.vault.adapter as { getBasePath?: () => string }
  ).getBasePath?.();
  if (!basePath) {
    error(configManager, 'Failed to get vault base path for zvec store');
    new Notice(
      'Failed to initialize vector store: vault base path unavailable.\n\n' +
        'Check console for details.',
      0
    );
    return null;
  }

  const sanitizeForPath = (str: string): string =>
    str.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();

  const pluginDir = `${basePath}/${plugin.manifest.dir}`;
  configureZvecPluginDir(pluginDir);

  const zvecCollectionPath = `${basePath}/.obsidian/plugins/obsidian-sonar/zvec/${sanitizeForPath(embedderModelIdentifier)}`;

  sonarState.setStatusBarText('Loading vector store...');
  let zvecStore: ZvecEmbeddingStore;
  try {
    zvecStore = await ZvecEmbeddingStore.initialize(
      zvecCollectionPath,
      embedder.dimension,
      configManager
    );
  } catch (err) {
    error(configManager, `Failed to initialize vector store: ${err}`);
    new Notice(
      'Failed to initialize vector store.\n\n' +
        'Check console for details.\n\n' +
        'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
      0
    );
    return null;
  }

  const migratedCount = await ZvecEmbeddingStore.migrateFromIDB(db, zvecStore);
  if (migratedCount > 0) {
    log(
      configManager,
      `Migrated ${migratedCount} embeddings from IndexedDB to zvec`
    );
  }

  let bm25Store: BM25Store;
  sonarState.setBm25StoreStatus('initializing');
  sonarState.setStatusBarText('Loading BM25 store...');
  try {
    bm25Store = await BM25Store.initialize(db, configManager);
  } catch (err) {
    sonarState.setBm25StoreStatus('failed');
    error(configManager, `Failed to initialize BM25 store: ${err}`);
    new Notice(
      'Failed to initialize BM25 store.\n\n' +
        'Check console for details.\n\n' +
        'You can change settings and run "Sonar: Reinitialize Sonar" command to retry.',
      0
    );
    return null;
  }
  sonarState.setBm25StoreStatus('ready');

  const bm25Search = new BM25Search(bm25Store, metadataStore, configManager);

  const idbEmbeddingStore = new EmbeddingStore(db, configManager);

  const embeddingSearch = new EmbeddingSearch(
    metadataStore,
    zvecStore,
    idbEmbeddingStore,
    embedder,
    configManager
  );

  const searchManager = new SearchManager(
    embeddingSearch,
    bm25Search,
    reranker,
    configManager,
    async (filePath: string) => {
      const file = plugin.app.vault.getFileByPath(filePath);
      if (!file) return null;
      const buffer = await plugin.app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      const mimeType = `image/${file.extension}`;
      return `data:${mimeType};base64,${uint8ArrayToBase64(bytes)}`;
    }
  );

  const indexManager = new IndexManager(
    metadataStore,
    idbEmbeddingStore,
    zvecStore,
    bm25Store,
    embedder,
    plugin.app.vault,
    plugin.app.workspace,
    configManager
  );

  try {
    await indexManager.onLayoutReady();
  } catch (err) {
    error(configManager, `Failed to initialize Sonar: ${err}`);
    new Notice(
      'Failed to initialize Sonar.\n\n' +
        'Check console for details.\n\n' +
        'You can change settings and run "Reinitialize Sonar" action/command to retry.',
      0
    );
    return null;
  }

  return {
    embedder,
    reranker,
    metadataStore,
    zvecStore,
    searchManager,
    indexManager,
  };
}
