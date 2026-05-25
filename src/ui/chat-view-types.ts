export function isSendShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.metaKey && e.ctrlKey && !e.isComposing;
}
