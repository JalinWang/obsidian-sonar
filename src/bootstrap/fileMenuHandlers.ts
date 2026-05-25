import { Notice, TFile } from 'obsidian';
import { isAudioExtension } from '../indexing/audio';
import type SonarPlugin from '../../main';

async function createTranscriptionNote(
  plugin: SonarPlugin,
  audioFile: TFile
): Promise<void> {
  if (!plugin.checkInitialized()) return;

  const chunks = await plugin.metadataStore!.getChunksByFile(audioFile.path);
  if (chunks.length === 0) {
    new Notice(
      `No transcription found for ${audioFile.name}.\n\n` +
        'Please index this file first.'
    );
    return;
  }

  chunks.sort((a, b) => a.id.localeCompare(b.id));
  const transcriptionText = chunks.map(c => c.content).join('\n\n');

  const audioFolder = audioFile.parent?.path || '';
  const noteName = audioFile.basename;
  const notePath = audioFolder
    ? `${audioFolder}/${noteName}.md`
    : `${noteName}.md`;

  const existingFile = plugin.app.vault.getAbstractFileByPath(notePath);
  if (existingFile) {
    new Notice(`Note already exists: ${notePath}`);
    const leaf = plugin.app.workspace.getLeaf();
    await leaf.openFile(existingFile as TFile);
    return;
  }

  const content = `[[${audioFile.name}]]\n\n${transcriptionText}`;
  const newFile = await plugin.app.vault.create(notePath, content);
  new Notice(`Created transcription note: ${notePath}`);

  const leaf = plugin.app.workspace.getLeaf();
  await leaf.openFile(newFile);
}

async function createPdfExtractNote(
  plugin: SonarPlugin,
  pdfFile: TFile
): Promise<void> {
  if (!plugin.checkInitialized()) return;

  const chunks = await plugin.metadataStore!.getChunksByFile(pdfFile.path);
  if (chunks.length === 0) {
    new Notice(
      `No extracted text found for ${pdfFile.name}.\n\n` +
        'Please index this file first.'
    );
    return;
  }

  chunks.sort((a, b) => a.id.localeCompare(b.id));
  const extractedText = chunks.map(c => c.content).join('\n\n');

  const pdfFolder = pdfFile.parent?.path || '';
  const noteName = pdfFile.basename;
  const notePath = pdfFolder ? `${pdfFolder}/${noteName}.md` : `${noteName}.md`;

  const existingFile = plugin.app.vault.getAbstractFileByPath(notePath);
  if (existingFile) {
    new Notice(`Note already exists: ${notePath}`);
    const leaf = plugin.app.workspace.getLeaf();
    await leaf.openFile(existingFile as TFile);
    return;
  }

  const content = `[[${pdfFile.name}]]\n\n${extractedText}`;
  const newFile = await plugin.app.vault.create(notePath, content);
  new Notice(`Created PDF extract note: ${notePath}`);

  const leaf = plugin.app.workspace.getLeaf();
  await leaf.openFile(newFile);
}

export function registerFileMenuHandlers(plugin: SonarPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile)) return;
      if (!file.extension) return;

      if (isAudioExtension(file.extension)) {
        menu.addItem(item => {
          item
            .setTitle('Create transcription note')
            .setIcon('file-text')
            .onClick(() => void createTranscriptionNote(plugin, file));
        });
      } else if (file.extension === 'pdf') {
        menu.addItem(item => {
          item
            .setTitle('Create PDF extract note')
            .setIcon('file-text')
            .onClick(() => void createPdfExtractNote(plugin, file));
        });
      }
    })
  );
}
