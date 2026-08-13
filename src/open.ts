/**
 * Opening things outside the app: browser links, the clipboard, file saves.
 *
 * Every URL passes `isSafeExternalUrl` first. Video links and weblinks come from
 * Speedrun.com submissions, which means they are attacker-controlled text; a
 * `file:` or custom-scheme URL must never reach the OS handler on a moderator's
 * machine.
 */

import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import { isSafeExternalUrl, plural } from './format';
import { t } from './i18n';
import { records } from './ipc';
import type { ExportPayload } from './types';
import { ui } from './store/ui';

/** Opens an http(s) URL in the default browser. Refuses anything else. */
export async function openExternal(url: string | null | undefined): Promise<void> {
  if (!url) {
    ui.warning(t('open.noLink'));
    return;
  }
  if (!isSafeExternalUrl(url)) {
    ui.warning(t('open.refused'), t('open.refusedHint'));
    return;
  }
  try {
    await openUrl(url);
  } catch (err) {
    ui.error(t('open.failed'), err);
  }
}

/**
 * Copies text and says so.
 *
 * The default label is resolved inside the function rather than in the parameter
 * list: a default value is evaluated once at module load, which would freeze it
 * in whichever language happened to be active then.
 */
export async function copyToClipboard(text: string, label?: string): Promise<void> {
  try {
    await writeText(text);
    ui.success(label ?? t('common.copied'));
  } catch (err) {
    ui.error(t('open.copyFailed'), err);
  }
}

/**
 * Writes an export to a file the user picks.
 *
 * The path always comes from the native dialog and the bytes are written by the
 * backend, so the webview never holds a filesystem capability of its own.
 */
export async function saveExport(payload: ExportPayload): Promise<boolean> {
  const extension = payload.filename.split('.').pop() ?? 'txt';
  const filterName = t(
    extension === 'csv'
      ? 'open.filter.csv'
      : extension === 'json'
        ? 'open.filter.json'
        : 'open.filter.text',
  );

  try {
    const path = await save({
      defaultPath: payload.filename,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!path) return false;

    await records.writeExport(path, payload.content);
    ui.success(t('open.exportSaved'), plural(payload.rowCount, 'row'));
    return true;
  } catch (err) {
    ui.error(t('open.exportFailed'), err);
    return false;
  }
}
