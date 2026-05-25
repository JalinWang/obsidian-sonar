import { setTooltip } from 'obsidian';
import { ConfigManager } from '../config/ConfigManager';

export function formatStatusBarText(status: string): string {
  return `Sonar: ${status}`;
}

export function updateStatusBar(
  statusBarItem: HTMLElement,
  configManager: ConfigManager,
  text: string,
  tooltip?: string
): void {
  const maxLength = configManager.get('statusBarMaxLength');
  const fullText = formatStatusBarText(text);

  setTooltip(statusBarItem, tooltip ? formatStatusBarText(tooltip) : fullText, {
    placement: 'top',
    gap: 8,
  });

  let paddedText = text;
  if (maxLength > 0 && text.length > maxLength) {
    if (maxLength >= 4) {
      const halfLength = Math.floor((maxLength - 3) / 2);
      const prefix = text.slice(0, halfLength);
      const suffix = text.slice(-(maxLength - halfLength - 3));
      paddedText = prefix + '...' + suffix;
    } else {
      paddedText = text.slice(0, maxLength);
    }
  } else if (maxLength > 0) {
    paddedText = text.padEnd(maxLength);
  }
  statusBarItem.setText(formatStatusBarText(paddedText));
}
