/**
 * Keyboard shortcuts.
 *
 * Bindings are stored as a single normalised string (`ctrl+shift+k`, `a`,
 * `escape`) so a saved custom binding and a default are directly comparable.
 * The backend stores only the actions the user has rebound; the defaults below
 * are the base layer those overrides are merged onto.
 */

import type { TranslationKey } from './i18n';

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

/** Section a shortcut is listed under. Also a catalogue-key suffix. */
export type ShortcutGroup = 'moderation' | 'navigation' | 'selection' | 'application';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'moderation',
  'navigation',
  'selection',
  'application',
];

export interface ShortcutDefinition {
  action: ShortcutAction;
  binding: string;
  /**
   * Catalogue keys rather than finished text: the same definition is rendered
   * by the Settings list, the help window and the command palette, so a
   * literal here would leave all three in English.
   */
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  group: ShortcutGroup;
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
    labelKey: 'shortcut.approve',
    descriptionKey: 'shortcut.approve.desc',
    group: 'moderation',
  },
  {
    action: 'reject',
    binding: 'r',
    labelKey: 'shortcut.reject',
    descriptionKey: 'shortcut.reject.desc',
    group: 'moderation',
  },
  {
    action: 'openVideo',
    binding: 'v',
    labelKey: 'shortcut.openVideo',
    descriptionKey: 'shortcut.openVideo.desc',
    group: 'moderation',
  },
  {
    action: 'openRun',
    binding: 'o',
    labelKey: 'shortcut.openRun',
    descriptionKey: 'shortcut.openRun.desc',
    group: 'moderation',
  },
  {
    action: 'openDetail',
    binding: 'enter',
    labelKey: 'shortcut.openDetail',
    descriptionKey: 'shortcut.openDetail.desc',
    group: 'moderation',
  },
  {
    action: 'toggleSelect',
    binding: 'space',
    labelKey: 'shortcut.toggleSelect',
    descriptionKey: 'shortcut.toggleSelect.desc',
    group: 'selection',
  },
  {
    action: 'next',
    binding: 'n',
    labelKey: 'shortcut.next',
    descriptionKey: 'shortcut.next.desc',
    group: 'navigation',
  },
  {
    action: 'previous',
    binding: 'p',
    labelKey: 'shortcut.previous',
    descriptionKey: 'shortcut.previous.desc',
    group: 'navigation',
  },
  {
    action: 'fastReview',
    binding: 'f',
    labelKey: 'shortcut.fastReview',
    descriptionKey: 'shortcut.fastReview.desc',
    group: 'navigation',
  },
  {
    action: 'escape',
    binding: 'escape',
    labelKey: 'shortcut.escape',
    descriptionKey: 'shortcut.escape.desc',
    group: 'application',
    fixed: true,
  },
  {
    action: 'selectAll',
    binding: 'ctrl+a',
    labelKey: 'shortcut.selectAll',
    descriptionKey: 'shortcut.selectAll.desc',
    group: 'selection',
  },
  {
    action: 'clearSelection',
    binding: 'ctrl+shift+a',
    labelKey: 'shortcut.clearSelection',
    descriptionKey: 'shortcut.clearSelection.desc',
    group: 'selection',
  },
  {
    action: 'refresh',
    binding: 'ctrl+r',
    labelKey: 'shortcut.refresh',
    descriptionKey: 'shortcut.refresh.desc',
    group: 'application',
  },
  {
    action: 'search',
    binding: 'ctrl+f',
    labelKey: 'shortcut.search',
    descriptionKey: 'shortcut.search.desc',
    group: 'application',
  },
  {
    action: 'commandPalette',
    binding: 'ctrl+k',
    labelKey: 'shortcut.commandPalette',
    descriptionKey: 'shortcut.commandPalette.desc',
    group: 'application',
    fixed: true,
  },
  {
    action: 'help',
    binding: '?',
    labelKey: 'shortcut.help',
    descriptionKey: 'shortcut.help.desc',
    group: 'application',
  },
  {
    action: 'gotoDashboard',
    binding: 'g d',
    labelKey: 'shortcut.gotoDashboard',
    descriptionKey: 'shortcut.gotoDashboard.desc',
    group: 'navigation',
  },
  {
    action: 'gotoQueue',
    binding: 'g q',
    labelKey: 'shortcut.gotoQueue',
    descriptionKey: 'shortcut.gotoQueue.desc',
    group: 'navigation',
  },
  {
    action: 'gotoHistory',
    binding: 'g h',
    labelKey: 'shortcut.gotoHistory',
    descriptionKey: 'shortcut.gotoHistory.desc',
    group: 'navigation',
  },
  {
    action: 'gotoStats',
    binding: 'g s',
    labelKey: 'shortcut.gotoStats',
    descriptionKey: 'shortcut.gotoStats.desc',
    group: 'navigation',
  },
  {
    action: 'gotoSettings',
    binding: 'g ,',
    labelKey: 'shortcut.gotoSettings',
    descriptionKey: 'shortcut.gotoSettings.desc',
    group: 'navigation',
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
