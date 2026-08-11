/**
 * Global keyboard handling.
 *
 * One listener on `window` in capture phase, rather than handlers scattered
 * across components. That keeps the precedence rules in one place: a text field
 * swallows everything except Escape and the command palette, and an action only
 * fires when the page currently mounted supplied a handler for it.
 */

import { useEffect, useMemo, useRef } from 'react';

import {
  ALWAYS_ACTIVE,
  DEFAULT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  eventBinding,
  isSequence,
  isTypingTarget,
  type ShortcutAction,
} from '../shortcuts';
import { useSession } from '../store/session';

export type ShortcutHandlers = Partial<Record<ShortcutAction, (event: KeyboardEvent) => void>>;

/** How long the first key of a `g d` style sequence stays armed. */
const SEQUENCE_WINDOW_MS = 900;

/**
 * Binding → action, built from the defaults with the user's overrides applied.
 *
 * A rebound key must not keep firing its old action, so this is derived from the
 * merged view rather than consulting the two layers separately. When two actions
 * end up on the same binding the earlier definition wins, which matches the
 * order the help window lists them in.
 */
function buildLookup(custom: Record<string, string>): Map<string, ShortcutAction> {
  const lookup = new Map<string, ShortcutAction>();
  for (const definition of SHORTCUT_DEFINITIONS) {
    const binding = custom[definition.action] ?? DEFAULT_BINDINGS[definition.action];
    if (!binding) continue;
    if (!lookup.has(binding)) lookup.set(binding, definition.action);
  }
  return lookup;
}

export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const shortcuts = useSession((state) => state.shortcuts);
  const lookup = useMemo(() => buildLookup(shortcuts), [shortcuts]);

  // Held in refs so the listener installs once and still sees fresh values;
  // re-binding on every render would drop keystrokes mid-press.
  const latest = useRef(handlers);
  latest.current = handlers;
  const table = useRef(lookup);
  table.current = lookup;

  const pending = useRef<{ prefix: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      const key = eventBinding(event);
      if (!key) return;

      const typing = isTypingTarget(event.target);

      const fire = (action: ShortcutAction): boolean => {
        if (typing && !ALWAYS_ACTIVE.has(action)) return false;
        const handler = latest.current[action];
        if (!handler) return false;
        event.preventDefault();
        event.stopPropagation();
        handler(event);
        return true;
      };

      // A pending prefix takes priority: after `g`, the next key belongs to that
      // sequence rather than to a shortcut of its own.
      const armed = pending.current;
      pending.current = null;
      if (armed && Date.now() - armed.at < SEQUENCE_WINDOW_MS) {
        const action = table.current.get(`${armed.prefix} ${key}`);
        if (action && fire(action)) return;
      }

      const action = table.current.get(key);
      if (action) {
        if (fire(action)) return;
        // A bound key with no handler on this page is still consumed when it is
        // a chord, so Ctrl+F never reaches the webview's own find bar.
        if (key.includes('+')) event.preventDefault();
        return;
      }

      if (!typing && startsSequence(key, table.current)) {
        pending.current = { prefix: key, at: Date.now() };
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}

/** True when some binding is a sequence beginning with this key. */
function startsSequence(key: string, lookup: Map<string, ShortcutAction>): boolean {
  const prefix = `${key} `;
  for (const binding of lookup.keys()) {
    if (isSequence(binding) && binding.startsWith(prefix)) return true;
  }
  return false;
}
