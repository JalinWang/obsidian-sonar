import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS } from './src/config/config';
import {
  RelatedNotesView,
  RELATED_NOTES_VIEW_TYPE,
} from './src/ui/RelatedNotesView';
import {
  SemanticNoteFinder,
  SEMANTIC_NOTE_FINDER_SOURCE,
} from './src/ui/SemanticNoteFinder';
import { IndexManager } from './src/indexing/IndexManager';
import { ConfigManager } from './src/config/ConfigManager';
import { SettingTab } from './src/ui/SettingTab';
import { getDBName, MetadataStore } from './src/storage/MetadataStore';
import { ZvecEmbeddingStore } from './src/storage/ZvecEmbeddingStore';
import type { Embedder } from './src/core/Embedder';
import type { Reranker } from './src/core/Reranker';
import { SearchManager } from './src/search/SearchManager';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/ChatView';
import { confirmAction } from './src/utils/obsidian-utils';
import {
  sonarState,
  getState,
  checkSearchReady,
  checkHasFailure,
} from './src/core/SonarState';
import {
  getEmbedderModelIdentifier,
  initializeSonar,
} from './src/bootstrap/initializer';
import { registerCommands } from './src/bootstrap/commands';
import { registerFileMenuHandlers } from './src/bootstrap/fileMenuHandlers';
import { updateStatusBar as renderStatusBar } from './src/bootstrap/statusBar';

export default class SonarPlugin extends Plugin {
  configManager!: ConfigManager;
  statusBarItem!: HTMLElement;
  searchManager: SearchManager | null = null;
  indexManager: IndexManager | null = null;
  metadataStore: MetadataStore | null = null;
  embedder: Embedder | null = null;
  reranker: Reranker | null = null;
  private zvecStore: ZvecEmbeddingStore | null = null;
  private semanticNoteFinder: SemanticNoteFinder | null = null;
  private reinitializing = false;
  private indexUpdateUnsubscribe: (() => void) | null = null;

  log(msg: string): void {
    this.configManager.getLogger().log(`[Sonar.Plugin] ${msg}`);
  }

  private error(msg: string): void {
    this.configManager.getLogger().error(`[Sonar.Plugin] ${msg}`);
  }

  private warn(msg: string): void {
    this.configManager.getLogger().warn(`[Sonar.Plugin] ${msg}`);
  }

  updateStatusBar(text: string, tooltip?: string): void {
    renderStatusBar(this.statusBarItem, this.configManager, text, tooltip);
  }

  confirmModelDownload(modelType: string, modelId: string): Promise<boolean> {
    return confirmAction(
      this.app,
      `Download ${modelType} model?`,
      `The ${modelType} model is not cached and needs to be downloaded:\n\n` +
        `\`${modelId}\`\n\n` +
        `If you want to use a different model, select **Cancel** and change ` +
        `the model settings in **Settings → Sonar**, then reinitialize.`,
      'Download'
    );
  }

  async reinitializeSonar(): Promise<void> {
    if (this.reinitializing) {
      this.warn('Sonar reinitialization already in progress');
      return;
    }

    this.reinitializing = true;
    sonarState.setStatusBarText('Reinitializing...');

    try {
      this.log('Reinitializing Sonar...');

      if (this.indexUpdateUnsubscribe) {
        this.indexUpdateUnsubscribe();
        this.indexUpdateUnsubscribe = null;
      }
      this.semanticNoteFinder = null;

      if (this.indexManager) {
        this.indexManager.cleanup();
        this.indexManager = null;
      }
      this.searchManager = null;

      if (this.zvecStore) {
        this.log('Closing zvec store...');
        this.zvecStore.close();
        this.zvecStore = null;
      }

      if (this.embedder) {
        this.log('Cleaning up old embedder...');
        await this.embedder.cleanup();
        this.embedder = null;
      }

      if (this.reranker) {
        this.log('Cleaning up old reranker...');
        await this.reranker.cleanup();
        this.reranker = null;
      }

      if (this.metadataStore) {
        this.log('Closing old database...');
        await this.metadataStore.close();
        this.metadataStore = null;
      }

      sonarState.reset();

      const success = await this.initializeAsync();
      if (!success) return;

      this.log('Sonar reinitialized successfully');
      new Notice('Sonar reinitialized successfully');
    } catch (error) {
      this.error(`Failed to reinitialize Sonar: ${error}`);
      new Notice('Failed to reinitialize Sonar - check console');
    } finally {
      this.reinitializing = false;
    }
  }

  async onload() {
    this.configManager = await ConfigManager.initialize(
      () => this.loadData(),
      data => this.saveData(data),
      DEFAULT_SETTINGS
    );

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('mod-clickable');
    this.statusBarItem.onClickEvent(async (evt: MouseEvent) => {
      const state = getState();

      if (evt.metaKey || evt.ctrlKey) {
        const modifierAction = state.onStatusBarModifierClick;
        if (!modifierAction) return;
        const confirmed = await confirmAction(
          this.app,
          modifierAction.confirmTitle,
          modifierAction.confirmMessage,
          modifierAction.confirmButton
        );
        if (confirmed) {
          modifierAction.action();
        }
        return;
      }

      const clickAction = state.onStatusBarClick;
      if (!clickAction) return;
      const confirmed = await confirmAction(
        this.app,
        clickAction.confirmTitle,
        clickAction.confirmMessage,
        clickAction.confirmButton
      );
      if (confirmed) {
        clickAction.action();
      }
    });

    const unsubscribe = sonarState.subscribe(state => {
      if (checkHasFailure(state)) {
        this.updateStatusBar('Initialization failed');
        return;
      }
      if (checkSearchReady(state)) {
        // IndexManager takes over status bar updates once ready
      }
      let tooltip = state.statusBarTooltip;
      if (state.onStatusBarClick) {
        const base = tooltip ?? state.statusBarText;
        const clickHint = `click to ${state.onStatusBarClick.actionName}`;
        const modifierHint = state.onStatusBarModifierClick
          ? `, cmd/ctrl+click to ${state.onStatusBarModifierClick.actionName}`
          : '';
        tooltip = `${base} (${clickHint}${modifierHint})`;
      }
      this.updateStatusBar(state.statusBarText, tooltip);
    });
    this.register(() => unsubscribe());

    registerCommands(this);
    registerFileMenuHandlers(this);
    const settingTab = new SettingTab(this.app, this);
    this.addSettingTab(settingTab);

    this.registerViews();

    this.registerEvent(
      this.app.workspace.on('quit', () => {
        this.log('Quit event triggered, performing cleanup...');
        this.performCleanup().catch(error => {
          this.error(`Cleanup during quit failed: ${error}`);
        });
      })
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.configManager.get('autoOpenRelatedNotes')) {
        this.activateRelatedNotesView();
      }
      void this.initializeAsync();
    });
  }

  private async initializeAsync(): Promise<boolean> {
    const services = await initializeSonar(this, this.configManager);
    if (!services) return false;

    this.embedder = services.embedder;
    this.reranker = services.reranker;
    this.metadataStore = services.metadataStore;
    this.zvecStore = services.zvecStore;
    this.searchManager = services.searchManager;
    this.indexManager = services.indexManager;

    this.indexUpdateUnsubscribe = this.indexManager.onIndexUpdated(() => {
      this.semanticNoteFinder?.invalidateCache();
    });

    return true;
  }

  private isInitialized(): boolean {
    return this.indexManager !== null;
  }

  checkInitialized(): boolean {
    if (!this.isInitialized()) {
      const state = getState();
      if (state.embedder === 'failed') {
        new Notice(
          'Embedder initialization failed.\n\n' +
            'Check llama.cpp configuration in Settings → Sonar, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (state.metadataStore === 'failed') {
        new Notice(
          'Metadata store initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (state.bm25Store === 'failed') {
        new Notice(
          'BM25 store initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      } else if (
        state.embedder !== 'ready' ||
        state.metadataStore !== 'ready' ||
        state.bm25Store !== 'ready'
      ) {
        new Notice('Sonar is still initializing. Please wait...');
      } else {
        new Notice(
          'Sonar initialization failed.\n\n' +
            'Check the console for details, ' +
            'then run "Reinitialize Sonar".'
        );
      }
      return false;
    }
    return true;
  }

  private registerViews(): void {
    this.registerView(RELATED_NOTES_VIEW_TYPE, leaf => {
      return new RelatedNotesView(leaf, this, this.configManager);
    });
    this.registerView(CHAT_VIEW_TYPE, leaf => {
      return new ChatView(leaf, this, this.configManager);
    });
    this.registerHoverLinkSource(SEMANTIC_NOTE_FINDER_SOURCE, {
      display: 'Sonar: Semantic note finder',
      defaultMod: true,
    });
    this.registerHoverLinkSource(RELATED_NOTES_VIEW_TYPE, {
      display: 'Sonar: Related notes',
      defaultMod: true,
    });
    this.registerHoverLinkSource(CHAT_VIEW_TYPE, {
      display: 'Sonar: Chat',
      defaultMod: true,
    });
  }

  async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;

    const leaves = workspace.getLeavesOfType(viewType);
    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]);
      return;
    }

    const rightLeaf = workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({ type: viewType, active: true });
      workspace.revealLeaf(rightLeaf);
    }
  }

  async activateRelatedNotesView() {
    await this.activateView(RELATED_NOTES_VIEW_TYPE);
  }

  openSemanticNoteFinder(): void {
    if (!this.checkInitialized()) return;
    (this.semanticNoteFinder ??= new SemanticNoteFinder(
      this.app,
      this.searchManager!,
      this.configManager
    )).open();
  }

  async activateChatView(): Promise<void> {
    await this.activateView(CHAT_VIEW_TYPE);
  }

  async deleteAllVaultDatabases(): Promise<void> {
    const vaultName = this.app.vault.getName();
    const databases = await MetadataStore.listDatabasesForVault(vaultName);

    if (databases.length === 0) {
      new Notice(`No indices found for vault: ${vaultName}`);
      return;
    }

    this.log(
      `Found ${databases.length} database(s) for vault ${vaultName}: ${databases.join(', ')}`
    );

    const confirmed = await this.configManager.confirmDeleteAllVaultDatabases(
      this.app,
      vaultName,
      databases
    );
    if (!confirmed) {
      return;
    }

    if (this.metadataStore) {
      const backend = this.configManager.get('embeddingBackend');
      const modelIdentifier = getEmbedderModelIdentifier(this.configManager);
      const currentDbName = getDBName(vaultName, backend, modelIdentifier);

      if (databases.includes(currentDbName)) {
        this.log(`Closing current database before deletion: ${currentDbName}`);
        await this.metadataStore.close();
        this.metadataStore = null;
        if (this.indexManager) {
          this.indexManager.cleanup();
          this.indexManager = null;
        }
      }
    }

    let deletedCount = 0;
    for (const dbName of databases) {
      try {
        await MetadataStore.deleteDatabase(dbName);
        deletedCount++;
        this.log(`Deleted database: ${dbName}`);
      } catch (error) {
        this.error(`Failed to delete database ${dbName}: ${error}`);
      }
    }

    if (deletedCount > 0) {
      new Notice(`Deleted ${deletedCount} database(s).`, 0);
      this.log(`Deleted ${deletedCount} database(s) for vault ${vaultName}`);
    } else {
      new Notice('Failed to delete any databases - check console');
    }

    this.reinitializeSonar();
  }

  private async performCleanup(): Promise<void> {
    if (this.indexUpdateUnsubscribe) {
      this.indexUpdateUnsubscribe();
      this.indexUpdateUnsubscribe = null;
    }
    this.semanticNoteFinder = null;
    if (this.indexManager) {
      this.indexManager.cleanup();
    }
    if (this.zvecStore) {
      this.zvecStore.close();
      this.zvecStore = null;
    }
    if (this.metadataStore) {
      await this.metadataStore.close();
    }
    await Promise.all([this.embedder?.cleanup(), this.reranker?.cleanup()]);
  }

  async onunload() {
    this.log('Obsidian Sonar plugin unloaded');
    await this.performCleanup();
  }
}
