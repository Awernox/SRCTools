/**
 * The notification sound.
 *
 * The bundled file is imported rather than read from disk, so Vite hashes it into
 * the bundle and it ships inside the executable. There is no path to get wrong on
 * a user's machine and nothing for an installer to copy.
 *
 * A moderator may put their own file in front of it. That one arrives as bytes
 * over IPC — the asset protocol is disabled app-wide, so the webview cannot read
 * a local file itself — and becomes a blob URL. The bundled sound stays the
 * fallback whenever no custom file is stored or the stored one fails to decode,
 * so the app is never left silent with the sound switched on.
 *
 * One element is reused for every play. A fresh `Audio` per notification would
 * leak a decoder each time the watcher fires, which at a one-second poll adds up
 * quickly.
 */

import bundledUrl from './assets/sounds/notification.mp3';
import { sound as soundIpc } from './ipc';

/** The custom sound as a blob URL, or `null` while the bundled one is in use. */
let customUrl: string | null = null;
let element: HTMLAudioElement | null = null;
/** Which URL `element` was built for, so a source change rebuilds it. */
let elementUrl: string | null = null;
/** Set once a block has been reported, so the hint is shown once per session. */
let blockReported = false;

function activeUrl(): string {
  return customUrl ?? bundledUrl;
}

function audio(): HTMLAudioElement {
  const url = activeUrl();
  if (!element || elementUrl !== url) {
    element = new Audio(url);
    element.preload = 'auto';
    elementUrl = url;
  }
  return element;
}

/**
 * Decodes base64 without going through a data URL.
 *
 * Returns the buffer rather than the view: a `Uint8Array` may be backed by a
 * `SharedArrayBuffer`, which `Blob` will not take, so the allocation is made
 * here where its type is known.
 */
function bytesFrom(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/**
 * Loads the stored custom sound, if there is one.
 *
 * Returns true when a custom sound is now in use. Safe to call repeatedly: the
 * previous blob URL is revoked first, so re-importing does not accumulate them.
 *
 * A failure here is not surfaced as an error. The consequence is that the
 * bundled sound plays instead, which is the correct outcome and needs no
 * decision from the moderator.
 */
export async function loadCustomSound(): Promise<boolean> {
  try {
    const base64 = await soundIpc.load();
    dropCustom();
    if (base64 === null || base64 === '') return false;
    // The type is deliberately generic: the extension was validated on the Rust
    // side, and the audio element sniffs the container regardless of what we
    // claim here.
    customUrl = URL.createObjectURL(new Blob([bytesFrom(base64)], { type: 'audio/mpeg' }));
    return true;
  } catch {
    dropCustom();
    return false;
  }
}

/** Revokes the blob URL and falls back to the bundled sound. */
export function dropCustom(): void {
  if (customUrl !== null) URL.revokeObjectURL(customUrl);
  customUrl = null;
  // Force a rebuild rather than leave an element pointed at a revoked URL.
  if (elementUrl !== bundledUrl) {
    element = null;
    elementUrl = null;
  }
}

/** True when a custom sound is loaded and in use. */
export function usingCustomSound(): boolean {
  return customUrl !== null;
}

/**
 * Plays the notification sound at `volume` (0..1).
 *
 * Resolves to `false` when the webview blocked playback. A window that has never
 * been interacted with refuses to make noise, so a moderator who enabled the
 * sound could otherwise sit in silence with nothing to explain it.
 */
export async function playNotificationSound(volume: number): Promise<boolean> {
  const clamped = Math.min(1, Math.max(0, volume));
  if (clamped === 0) return true;

  const el = audio();
  el.volume = clamped;
  // Restart rather than ignore: two runs arriving together should be audible as
  // one prompt sound, not one sound and one silent no-op.
  el.currentTime = 0;

  try {
    await el.play();
    blockReported = false;
    return true;
  } catch {
    // A custom file the element cannot decode would fail every time. Drop back
    // to the bundled sound and try once, so the alert is still audible.
    if (customUrl !== null) {
      dropCustom();
      try {
        const fallback = audio();
        fallback.volume = clamped;
        fallback.currentTime = 0;
        await fallback.play();
        blockReported = false;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Plays the sound once at the moderator's request, for the preview button.
 *
 * Separate from `playNotificationSound` only in name: the preview has to make
 * noise even when notifications are switched off, so it never consults settings.
 */
export function previewNotificationSound(volume: number): Promise<boolean> {
  return playNotificationSound(volume);
}

/**
 * True the first time playback is blocked, false afterwards.
 *
 * Keeps the watcher from stacking the same warning on every poll while the
 * window stays untouched.
 */
export function claimBlockWarning(): boolean {
  if (blockReported) return false;
  blockReported = true;
  return true;
}
