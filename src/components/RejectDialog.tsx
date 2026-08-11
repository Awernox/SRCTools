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
import { useSession } from '../store/session';
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
  const templates = useSession((state) => state.templates);
  const refreshTemplates = useSession((state) => state.refreshTemplates);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (templates.length === 0) void refreshTemplates();
  }, [templates.length, refreshTemplates]);

  const trimmed = reason.trim();
  const many = runs.length > 1;
  const first = runs[0];

  const subject = many
    ? `${runs.length} runs`
    : first
      ? `${first.gameName ?? 'Unknown game'} — ${first.categoryName ?? 'Unknown category'} by ${first.playerLabel}`
      : 'this run';

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Ban size={15} /> Reject {many ? `${runs.length} runs` : 'run'}
        </span>
      }
      onClose={onCancel}
      width={540}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || trimmed.length === 0}
            onClick={() => onSubmit(trimmed)}
          >
            {many ? `Reject ${runs.length} runs` : 'Reject run'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6, marginBottom: 12 }}>
        {subject}. The reason below is sent to Speedrun.com and is visible to the
        runner, so write it as a message to them.
      </p>

      <textarea
        className="textarea"
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        rows={5}
        placeholder="Why is this run being rejected?"
        aria-label="Rejection reason"
        style={{ width: '100%' }}
      />

      {templates.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section__title">
            <Pencil size={12} /> Templates
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="btn btn--sm"
                title={template.body}
                onClick={() => setReason(template.body)}
              >
                {template.label}
              </button>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 8, lineHeight: 1.55 }}>
            Picking a template fills the box; edit it before sending. Manage the
            list under Settings → Templates.
          </div>
        </div>
      )}

      {trimmed.length === 0 && (
        <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 12 }}>
          A reason is required before a run can be rejected.
        </div>
      )}
    </Modal>
  );
}
