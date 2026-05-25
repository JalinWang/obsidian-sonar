export type RelatedNotesStatus =
  | 'initializing'
  | 'initialization-failed'
  | 'no-active-note'
  | 'processing'
  | 'unable-to-determine-position'
  | 'ready'
  | 'no-content'
  | 'error';

export const STATUS_DISPLAY_TEXT: Record<RelatedNotesStatus, string> = {
  initializing: 'Initializing...',
  'initialization-failed': 'Initialization failed',
  'no-active-note': 'No active note',
  processing: 'Processing...',
  'unable-to-determine-position': 'Unable to determine position',
  ready: 'Ready to search',
  'no-content': 'No content to search',
  error: 'Failed to search',
};

export type QueryMode = 'default' | 'editing';
