/**
 * Keyboard shortcuts.
 *
 * Bindings are stored as a single normalised string (`ctrl+shift+k`, `a`,
 * `escape`) so a saved custom binding and a default are directly comparable.
 * The backend stores only the actions the user has rebound; the defaults below
 * are the base layer those overrides are merged onto.
 */

export type ShortcutAction =
  | 'approve'
  | 'reject'
  | 'openVideo'
  | 'openRun'
  | 'openDetail'
  | 'toggleSelect'
  | 'next'
  | 'previous'
  | 'fastReview'
  | 'escape'
  | 'refresh'
  | 'search'
  | 'commandPalette'
  | 'help'
  | 'selectAll'
  | 'clearSelection'
  | 'gotoDashboard'
  | 'gotoQueue'
  | 'gotoHistory'
  | 'gotoStats'
  | 'gotoSettings';

export interface ShortcutDefinition {
  action: ShortcutAction;
  binding: string;
  label: string;
  description: string;
  group: 'Moderation' | 'Navigation' | 'Selection' | 'Application';
  /** True when rebinding would break a platform convention. */
  fixed?: boolean;
}

/**
 * Defaults, in the order the help window lists them.
 *
 * The single-letter moderation keys match the spec: A approve, R reject,
 * V video, O open, Enter detail, Space select, N/P next/previous, F fast
 * review, Escape close.
 */
export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    action: 'approve',
    binding: 'a',
    label: 'Verify run',
    description: 'Verify the focused run. Asks for confirmation unless you turn that off.',
    group: 'Moderation',
  },
  {
    action: 'reject',
    binding: 'r',
    label: 'Reject run',
    description: 'Open the rejection dialog for the focused run. A reason is required.',
    group: 'Moderation',
  },
  {
    action: 'openVideo',
    binding: 'v',
    label: 'Open video',
    description: 'Open the run’s first video link in your browser.',
    group: 'Moderation',
  },
  {
    action: 'openRun',
    binding: 'o',
    label: 'Open on Speedrun.com',
    description: 'Open the focused run’s page in your browser.',
    group: 'Moderation',
  },
  {
    action: 'openDetail',
    binding: 'enter',
    label: 'Inspect run',
    description: 'Open the detail panel for the focused run.',
    group: 'Moderation',
  },
  {
    action: 'toggleSelect',
    binding: 'space',
    label: 'Select run',
    description: 'Add or remove the focused run from the bulk selection.',
    group: 'Selection',
  },
  {
    action: 'next',
    binding: 'n',
    label: 'Next run',
    description: 'Move focus to the next run.',
    group: 'Navigation',
  },
  {
    action: 'previous',
    binding: 'p',
    label: 'Previous run',
    description: 'Move focus to the previous run.',
    group: 'Navigation',
  },
  {
    action: 'fastReview',
    binding: 'f',
    label: 'Fast Review',
    description: 'Enter Fast Review, which advances automatically after each action.',
    group: 'Navigation',
  },
  {
    action: 'escape',
    binding: 'escape',
    label: 'Close / cancel',
    description: 'Close the open panel, dialog or menu.',
    group: 'Application',
    fixed: true,
  },
  {
    action: 'selectAll',
    binding: 'ctrl+a',
    label: 'Select all',
    description: 'Select every run currently shown.',
    group: 'Selection',
  },
  {
    action: 'clearSelection',
    binding: 'ctrl+shift+a',
    label: 'Clear selection',
    description: 'Deselect every run.',
    group: 'Selection',
  },
  {
    action: 'refresh',
    binding: 'ctrl+r',
    label: 'Refresh',
    description: 'Reload the current view from Speedrun.com.',
    group: 'Application',
  },
  {
    action: 'search',
    binding: 'ctrl+f',
    label: 'Filter runs',
    description: 'Focus the filter box in the queue toolbar.',
    group: 'Application',
  },
  {
    action: 'commandPalette',
    binding: 'ctrl+k',
    label: 'Command palette',
    description: 'Search games, runs, pages and commands.',
    group: 'Application',
    fixed: true,
  },
  {
    action: 'help',
    binding: '?',
    label: 'Keyboard shortcuts',
    description: 'Show this window.',
    group: 'Application',
  },
  {
    action: 'gotoDashboard',
    binding: 'g d',
    label: 'Go to Dashboard',
    description: 'Press G then D.',
    group: 'Navigation',
  },
  {
    action: 'gotoQueue',
    binding: 'g q',
    label: 'Go to Queue',
    description: 'Press G then Q.',
    group: 'Navigation',
  },
  {
    action: 'gotoHistory',
    binding: 'g h',
    label: 'Go to History',
    description: 'Press G then H.',
    group: 'Navigation',
  },
  {
    action: 'gotoStats',
    binding: 'g s',
    label: 'Go to Statistics',
    description: 'Press G then S.',
    group: 'Navigation',
  },
  {
    action: 'gotoSettings',
    binding: 'g ,',
    label: 'Go to Settings',
    description: 'Press G then comma.',
    group: 'Navigation',
  },
];

export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = SHORTCUT_DEFINITIONS.reduce(
  (acc, def) => {
    acc[def.action] = def.binding;
    return acc;
  },
  {} as Record<ShortcutAction, string>,
);

/** Normalises a keyboard event into the stored binding form. */
export function eventBinding(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  let key = event.key;
  if (key === ' ') key = 'space';
  else if (key === 'Escape') key = 'escape';
  else if (key === 'Enter') key = 'enter';
  else if (key.length === 1) key = key.toLowerCase();
  else key = key.toLowerCase();

  // A bare modifier press is not a binding.
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return '';

  parts.push(key);
  return parts.join('+');
}

/** Human-readable form of a binding, for the help window and menus. */
export function bindingKeys(binding: string): string[] {
  if (!binding) return [];
  // Sequence bindings ("g d") are two presses, not a chord.
  if (binding.includes(' ')) return binding.split(' ').map(prettyKey);
  return binding.split('+').map(prettyKey);
}

function prettyKey(part: string): string {
  switch (part) {
    case 'ctrl':
      return 'Ctrl';
    case 'shift':
      return 'Shift';
    case 'alt':
      return 'Alt';
    case 'space':
      return 'Space';
    case 'enter':
      return 'Enter';
    case 'escape':
      return 'Esc';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    case ',':
      return ',';
    default:
      return part.length === 1 ? part.toUpperCase() : part;
  }
}

/** True when the binding is a two-key sequence such as `g d`. */
export function isSequence(binding: string): boolean {
  return binding.includes(' ');
}

/**
 * Whether a keystroke should be ignored because the user is typing.
 *
 * Without this, pressing `r` in the rejection reason box would try to reject
 * another run.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/** Actions that must still fire while a text field has focus. */
export const ALWAYS_ACTIVE: ReadonlySet<ShortcutAction> = new Set([
  'escape',
  'commandPalette',
]);
