import { Notice } from 'obsidian';
import { confirmAction } from '../utils/obsidian-utils';
import { getState } from '../core/SonarState';
import type SonarPlugin from '../../main';

async function registerBenchmarkCommands(plugin: SonarPlugin): Promise<void> {
  const { registerRetrievalBenchmarkCommands } =
    await import('../../retrieval-bench/src/index');
  const {
    registerCragBenchmarkCommands,
    registerCragUnifiedBenchmarkCommands,
  } = await import('../../rag-bench/src/index');
  registerRetrievalBenchmarkCommands(plugin);
  registerCragBenchmarkCommands(plugin);
  registerCragUnifiedBenchmarkCommands(plugin);
}

export function registerCommands(plugin: SonarPlugin): void {
  plugin.addCommand({
    id: 'reinitialize-sonar',
    name: 'Reinitialize Sonar',
    callback: async () => {
      await plugin.reinitializeSonar();
    },
  });

  plugin.addCommand({
    id: 'sync-index',
    name: 'Sync search index with vault',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      await plugin.indexManager!.syncIndex();
    },
  });

  plugin.addCommand({
    id: 'clear-current-index',
    name: 'Clear current search index',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      const confirmed = await plugin.configManager.confirmClearCurrentIndex(
        plugin.app
      );
      if (!confirmed) return;
      await plugin.indexManager!.clearCurrentIndex();
      new Notice('Current index cleared');
    },
  });

  plugin.addCommand({
    id: 'show-failed-files',
    name: 'Show files that failed to index',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      const failedFiles = await plugin.metadataStore!.getAllFailedFiles();
      if (failedFiles.length === 0) {
        new Notice('No files have failed to index');
      } else {
        const message = [
          `Files that failed to index (${failedFiles.length}):`,
          '',
          ...failedFiles.map(
            f =>
              `- ${f.filePath} (failed at ${new Date(f.failedAt).toLocaleString()})`
          ),
        ].join('\n');
        plugin.log(message);
        new Notice(
          `${failedFiles.length} files failed to index - check console for details`,
          0
        );
      }
    },
  });

  plugin.addCommand({
    id: 'delete-vault-databases',
    name: 'Delete all search databases for this vault',
    callback: () => plugin.deleteAllVaultDatabases(),
  });

  plugin.addCommand({
    id: 'rebuild-index',
    name: 'Rebuild current search index',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      const confirmed = await plugin.configManager.confirmRebuildIndex(
        plugin.app
      );
      if (!confirmed) return;
      await plugin.indexManager!.rebuildIndex((current, total, filePath) => {
        plugin.log(`Rebuilding index: ${current}/${total} - ${filePath}`);
      });
    },
  });

  plugin.addCommand({
    id: 'index-current-file',
    name: 'Index current file',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      const activeFile = plugin.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice('No active file');
        return;
      }
      await plugin.indexManager!.indexFile(activeFile);
    },
  });

  plugin.addCommand({
    id: 'cancel-indexing',
    name: 'Cancel indexing',
    callback: async () => {
      const clickAction = getState().onStatusBarClick;
      if (!clickAction) {
        new Notice('No indexing operation in progress');
        return;
      }
      const confirmed = await confirmAction(
        plugin.app,
        clickAction.confirmTitle,
        clickAction.confirmMessage,
        clickAction.confirmButton
      );
      if (confirmed) {
        clickAction.action();
      }
    },
  });

  plugin.addCommand({
    id: 'open-related-notes',
    name: 'Open related notes view',
    callback: () => {
      plugin.activateRelatedNotesView();
    },
  });

  plugin.addCommand({
    id: 'open-semantic-note-finder',
    name: 'Open Semantic note finder',
    callback: () => {
      plugin.openSemanticNoteFinder();
    },
  });

  plugin.addCommand({
    id: 'open-chat',
    name: 'Open chat view',
    callback: () => {
      plugin.activateChatView();
    },
  });

  plugin.addCommand({
    id: 'show-indexable-files-stats',
    name: 'Show indexable files statistics',
    callback: async () => {
      if (!plugin.checkInitialized()) return;
      await plugin.indexManager!.showIndexableFilesStats();
    },
  });

  if (process.env.INCLUDE_BENCHMARK === 'true') {
    void registerBenchmarkCommands(plugin);
  }
}
