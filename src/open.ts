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

import { isSafeExternalUrl } from './format';
import { records } from './ipc';
import type { ExportPayload } from './types';
import { ui } from './store/ui';

/** Opens an http(s) URL in the default browser. Refuses anything else. */
export async function openExternal(url: string | null | undefined): Promise<void> {
  if (!url) {
    ui.warning('No link to open');
    return;
  }
  if (!isSafeExternalUrl(url)) {
    ui.warning(
      'That link was not opened',
      'It is not an http or https address, so SRCTools will not hand it to Windows. Copy it and inspect it yourself if you need to.',
    );
    return;
  }
  try {
    await openUrl(url);
  } catch (err) {
    ui.error('Could not open the link', err);
  }
}

export async function copyToClipboard(text: string, label = 'Copied'): Promise<void> {
  try {
    await writeText(text);
    ui.success(label);
  } catch (err) {
    ui.error('Could not copy that', err);
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
  const filterName =
    extension === 'csv' ? 'CSV spreadsheet' : extension === 'json' ? 'JSON document' : 'Text file';

  try {
    const path = await save({
      defaultPath: payload.filename,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!path) return false;

    await records.writeExport(path, payload.content);
    ui.success('Export saved', `${payload.rowCount} row${payload.rowCount === 1 ? '' : 's'}`);
    return true;
  } catch (err) {
    ui.error('Could not save the export', err);
    return false;
  }
}
