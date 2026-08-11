/**
 * Toasts and confirmation dialogs.
 *
 * Kept in a store rather than React context so any module — including the IPC
 * error path — can raise one without being inside a component tree.
 */

import { create } from 'zustand';

import { toAppError } from '../ipc';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Milliseconds; `0` keeps the toast until it is dismissed. */
  duration: number;
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Extra emphasis for actions that cannot be undone. */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shown as a checkbox the user must tick before confirming. */
  acknowledge?: string;
}

interface PendingConfirm extends ConfirmRequest {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface UiState {
  toasts: Toast[];
  confirm: PendingConfirm | null;

  notify: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number;
  success: (title: string, message?: string) => number;
  error: (title: string, err?: unknown) => number;
  warning: (title: string, message?: string) => number;
  info: (title: string, message?: string) => number;
  dismiss: (id: number) => void;

  /** Resolves true when the user confirms. Never throws. */
  requestConfirm: (request: ConfirmRequest) => Promise<boolean>;
  resolveConfirm: (confirmed: boolean) => void;
}

let nextId = 1;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  confirm: null,

  notify: ({ kind, title, message, action, duration }) => {
    const id = nextId++;
    // Errors stay until dismissed: a failure that vanishes after four seconds
    // is a failure the moderator may never have read.
    const ttl = duration ?? (kind === 'error' ? 0 : 4200);
    set((state) => ({
      toasts: [...state.toasts, { id, kind, title, message, action, duration: ttl }],
    }));
    if (ttl > 0) {
      window.setTimeout(() => get().dismiss(id), ttl);
    }
    return id;
  },

  success: (title, message) => get().notify({ kind: 'success', title, message }),

  error: (title, err) => {
    const detail = err === undefined ? undefined : toAppError(err);
    const message = detail
      ? detail.hint
        ? `${detail.message} ${detail.hint}`
        : detail.message
      : undefined;
    return get().notify({ kind: 'error', title, message });
  },

  warning: (title, message) => get().notify({ kind: 'warning', title, message }),
  info: (title, message) => get().notify({ kind: 'info', title, message }),

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  requestConfirm: (request) =>
    new Promise<boolean>((resolve) => {
      const existing = get().confirm;
      // A second request while one is open would strand the first promise.
      if (existing) existing.resolve(false);
      set({ confirm: { ...request, id: nextId++, resolve } });
    }),

  resolveConfirm: (confirmed) => {
    const pending = get().confirm;
    if (!pending) return;
    set({ confirm: null });
    pending.resolve(confirmed);
  },
}));

/** Non-hook access, for use outside components. */
export const ui = {
  notify: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) =>
    useUi.getState().notify(toast),
  success: (title: string, message?: string) => useUi.getState().success(title, message),
  error: (title: string, err?: unknown) => useUi.getState().error(title, err),
  warning: (title: string, message?: string) => useUi.getState().warning(title, message),
  info: (title: string, message?: string) => useUi.getState().info(title, message),
  confirm: (request: ConfirmRequest) => useUi.getState().requestConfirm(request),
};
