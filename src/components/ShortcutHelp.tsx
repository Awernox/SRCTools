/**
 * The `?` help window: every shortcut, grouped, with the current bindings.
 *
 * The rows read from the merged view in the session store, so a binding the
 * user has changed shows up here — and the column layout, with the binding at
 * the far edge, makes it readable without mouse hover.
 */

import { Keyboard } from 'lucide-react';

import { KeyHint, Modal } from './ui';
import { useT } from '../i18n';
import { SHORTCUT_DEFINITIONS, SHORTCUT_GROUPS } from '../shortcuts';
import { useApp } from '../store/app';
import { useSession } from '../store/session';

export function ShortcutHelp() {
  const t = useT();
  const open = useApp((state) => state.helpOpen);
  const close = useApp((state) => state.toggleHelp);
  const shortcuts = useSession((state) => state.shortcuts);

  if (!open) return null;

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Keyboard size={15} /> {t('settings.keyboard.title')}
        </span>
      }
      onClose={() => close(false)}
      width={560}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group}>
            <div className="section__title">{t(`settings.keyboard.group.${group}`)}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group).map(
                  (definition) => (
                    <tr key={definition.action}>
                      <td
                        style={{
                          padding: '5px 10px 5px 0',
                          fontSize: 'var(--text-sm)',
                          verticalAlign: 'baseline',
                        }}
                      >
                        {t(definition.labelKey)}
                        <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 1 }}>
                          {t(definition.descriptionKey)}
                        </div>
                      </td>
                      <td style={{ padding: '5px 0', textAlign: 'right', verticalAlign: 'middle' }}>
                        <KeyHint binding={shortcuts[definition.action] ?? definition.binding} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
        <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6, marginTop: 2 }}>
          {t('shortcutHelp.footer')}
        </p>
      </div>
    </Modal>
  );
}
