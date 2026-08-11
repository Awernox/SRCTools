/**
 * The update check.
 *
 * Two entry points, deliberately different in how loud they are:
 *
 * - `checkOnStartup` runs once, shortly after launch, and only ever opens the
 *   dialog when there is genuinely a newer release. Silence is the correct
 *   outcome of a successful check, and a GitHub outage must not greet a
 *   moderator with an error they did not ask for — it is logged to the console
 *   and forgotten.
 * - `checkNow` is the Settings button, so it reports everything: up to date,
 *   not configured, or why it failed. A button that does nothing visible is
 *   indistinguishable from a broken one.
 *
 * `dismissed` lives in memory rather than in the settings table. Choosing
 * "Later" should quiet the dialog for this session, not permanently hide the
 * one release the moderator was about to install.
 */

import { create } from 'zustand';

import { errorText, updates, type UpdateCheck } from '../ipc';

/**
 * Delay before the automatic check.
 *
 * Long enough that startup — settings, identity, moderated games, the first
 * queue load — is done competing for the network, short enough that the dialog
 * arrives while the moderator is still looking at the window.
 */
const STARTUP_DELAY_MS = 4000;

interface UpdateState {
  result: UpdateCheck | null;
  checking: boolean;
  /** Why the last check failed; `null` when it succeeded or has not run. */
  error: string | null;
  /** True while the "new version" dialog is open. */
  open: boolean;
  /** Set by Later, so the dialog does not reappear this session. */
  dismissed: boolean;

  checkOnStartup: () => void;
  /** Runs a check and returns the result, or `null` when it failed. */
  checkNow: () => Promise<UpdateCheck | null>;
  close: () => void;
  reopen: () => void;
}

/** Guards the automatic check against a second mount. */
let started = false;

export const useUpdate = create<UpdateState>((set, get) => ({
  result: null,
  checking: false,
  error: null,
  open: false,
  dismissed: false,

  checkOnStartup: () => {
    // Once per launch. React remounts the shell in development, and the effect
    // that calls this would otherwise queue a second request.
    if (started) return;
    started = true;
    window.setTimeout(() => {
      void updates
        .check()
        .then((result) => {
          set({ result, error: null });
          if (result.available && !get().dismissed) set({ open: true });
        })
        .catch((err: unknown) => {
          // Startup is not the moment to interrupt anyone about GitHub being
          // unreachable. Settings → About can say so when asked.
          console.warn('update check failed', err);
        });
    }, STARTUP_DELAY_MS);
  },

  checkNow: async () => {
    if (get().checking) return null;
    set({ checking: true, error: null });
    try {
      const result = await updates.check();
      set({ result, checking: false, open: result.available });
      return result;
    } catch (err) {
      set({ checking: false, error: errorText(err) });
      return null;
    }
  },

  close: () => set({ open: false, dismissed: true }),
  reopen: () => set({ open: true }),
}));
