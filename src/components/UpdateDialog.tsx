/**
 * The "a new version is available" dialog.
 *
 * Shown only when GitHub actually has a newer release than the running build.
 * There is no "up to date" version of this dialog: a successful check with
 * nothing to report should be invisible.
 *
 * Download opens the release in the browser rather than fetching and running an
 * installer from inside the app. Downloading and executing a binary on the
 * moderator's behalf is a large amount of trust for a moderation tool to take,
 * and Windows' own SmartScreen prompt on a browser download is a check worth
 * keeping. The moderator needs no Git, Node or Rust either way — the release
 * page carries the built installer.
 */

import { Download, ExternalLink } from 'lucide-react';

import { Modal } from './ui';
import { useT } from '../i18n';
import { openExternal } from '../open';
import { useUpdate } from '../store/update';

export function UpdateDialog() {
  const t = useT();
  const open = useUpdate((state) => state.open);
  const result = useUpdate((state) => state.result);
  const close = useUpdate((state) => state.close);

  if (!open || !result?.available) return null;

  // The installer asset when the release has one, the release page otherwise.
  // Either way it is a plain https URL and goes through `openExternal`, which
  // refuses anything that is not http(s).
  const target = result.downloadUrl ?? result.releaseUrl;

  const download = () => {
    void openExternal(target);
    close();
  };

  return (
    <Modal
      title={t('update.available.title')}
      onClose={close}
      width={480}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={close}>
            {t('update.later')}
          </button>
          <button type="button" className="btn btn--primary" onClick={download}>
            <Download size={15} />
            {t('update.download')}
          </button>
        </>
      }
    >
      <div className="update-dialog">
        <p className="update-dialog__lead">{t('update.available.lead')}</p>

        <div className="update-dialog__versions">
          <div className="update-dialog__version">
            <span className="update-dialog__label">{t('update.current')}</span>
            <span className="update-dialog__value">{result.current}</span>
          </div>
          <div className="update-dialog__arrow" aria-hidden="true">
            →
          </div>
          <div className="update-dialog__version">
            <span className="update-dialog__label">{t('update.latest')}</span>
            <span className="update-dialog__value update-dialog__value--new">
              {result.latest}
            </span>
          </div>
        </div>

        {/* Release notes are GitHub markdown from a repository maintainer, so
            they are rendered as text — never as HTML. */}
        {result.notes && <pre className="update-dialog__notes">{result.notes}</pre>}

        {result.releaseUrl && (
          <button
            type="button"
            className="btn btn--ghost btn--sm update-dialog__link"
            onClick={() => void openExternal(result.releaseUrl)}
          >
            <ExternalLink size={14} />
            {t('update.viewRelease')}
          </button>
        )}
      </div>
    </Modal>
  );
}
