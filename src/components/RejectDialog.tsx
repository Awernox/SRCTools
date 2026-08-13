/**
 * The rejection dialog.
 *
 * Rejection is the one action Speedrun.com shows back to the runner, so the
 * reason is mandatory and is never pre-filled with a guess. Templates are a
 * starting point the moderator can edit; picking one fills the box rather than
 * submitting, so nothing is ever sent that the moderator has not read.
 */

import { useEffect, useState } from 'react';
import { Ban, Pencil } from 'lucide-react';

import { Modal } from './ui';
import { plural } from '../format';
import { useT } from '../i18n';
import { runLine } from '../store/moderation';
import { useSession } from '../store/session';
import { displayTemplate } from '../templates';
import type { RunSummary } from '../types';

export function RejectDialog({
  runs,
  busy = false,
  onCancel,
  onSubmit,
}: {
  /** One run, or the whole bulk selection. */
  runs: RunSummary[];
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const t = useT();
  const templates = useSession((state) => state.templates);
  const refreshTemplates = useSession((state) => state.refreshTemplates);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (templates.length === 0) void refreshTemplates();
  }, [templates.length, refreshTemplates]);

  const trimmed = reason.trim();
  const many = runs.length > 1;
  const first = runs[0];

  // What is being rejected, named the same way the confirmation dialogs name it.
  const subject = many
    ? plural(runs.length, 'run')
    : first
      ? runLine(first)
      : t('dialog.reject.thisRun');

  // The heading and the confirm button say the same thing on purpose: the button
  // is the last thing read before an action the runner will see.
  const heading = many
    ? t('dialog.reject.titleMany', { runs: plural(runs.length, 'run') })
    : t('dialog.reject.title');

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Ban size={15} /> {heading}
        </span>
      }
      onClose={onCancel}
      width={540}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || trimmed.length === 0}
            onClick={() => onSubmit(trimmed)}
          >
            {heading}
          </button>
        </>
      }
    >
      <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6, marginBottom: 12 }}>
        {t('dialog.reject.hint', { subject })}
      </p>

      <textarea
        className="textarea"
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        rows={5}
        placeholder={t('dialog.reject.placeholder')}
        aria-label={t('dialog.reject.reasonAria')}
        style={{ width: '100%' }}
      />

      {templates.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section__title">
            <Pencil size={12} /> {t('dialog.reject.templates')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {templates.map((stored) => {
              const template = displayTemplate(stored, t);
              return (
              <button
                key={template.id}
                type="button"
                className="btn btn--sm"
                title={template.body}
                onClick={() => setReason(template.body)}
              >
                {template.label}
              </button>
              );
            })}
          </div>
          <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 8, lineHeight: 1.55 }}>
            {t('dialog.reject.templatesHint')}
          </div>
        </div>
      )}

      {trimmed.length === 0 && (
        <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 12 }}>
          {t('dialog.reject.required')}
        </div>
      )}
    </Modal>
  );
}
