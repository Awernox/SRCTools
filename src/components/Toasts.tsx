/**
 * Toast viewport and the confirmation dialog.
 *
 * Both read from the `ui` store rather than taking props, so any module can
 * raise one — including code far from the component tree, such as the IPC error
 * path.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

import { Modal } from './ui';
import { useUi, type ToastKind } from '../store/ui';

const ICONS: Record<ToastKind, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" role="region" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <Icon size={15} className="toast__icon" />
            <div className="toast__body">
              <div className="toast__title">{toast.title}</div>
              {toast.message && (
                <div className="toast__msg" data-selectable>
                  {toast.message}
                </div>
              )}
              {toast.action && (
                <button
                  type="button"
                  className="btn btn--sm"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    dismiss(toast.id);
                    toast.action?.run();
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmDialog() {
  const confirm = useUi((state) => state.confirm);
  const resolve = useUi((state) => state.resolveConfirm);
  const [acknowledged, setAcknowledged] = useState(false);

  // Each new request starts unacknowledged; carrying the tick over would let a
  // second deletion through on one click.
  useEffect(() => setAcknowledged(false), [confirm?.id]);

  if (!confirm) return null;

  const blocked = confirm.acknowledge !== undefined && !acknowledged;

  return (
    <Modal
      title={confirm.title}
      onClose={() => resolve(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => resolve(false)}>
            {confirm.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`btn ${confirm.danger ? 'btn--danger' : 'btn--primary'}`}
            disabled={blocked}
            onClick={() => resolve(true)}
          >
            {confirm.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <p style={{ lineHeight: 1.6 }}>{confirm.message}</p>
      {confirm.acknowledge !== undefined && (
        <label
          style={{
            display: 'flex',
            gap: 9,
            alignItems: 'flex-start',
            marginTop: 14,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            className="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            style={{ marginTop: 2 }}
          />
          <span style={{ color: 'var(--text)' }}>{confirm.acknowledge}</span>
        </label>
      )}
    </Modal>
  );
}
