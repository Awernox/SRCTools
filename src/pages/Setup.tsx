/**
 * First-run setup: connect a Speedrun.com API key.
 *
 * The key is validated against `GET /profile` before it is stored, so a typo is
 * caught here rather than surfacing as a confusing failure three screens later.
 * It goes straight into the Windows credential vault; it is never held in a
 * store, never written to a log and never rendered back — the only thing shown
 * afterwards is a masked preview the backend produces.
 */

import { useState } from 'react';
import { ExternalLink, Key, ShieldAlert } from 'lucide-react';

import { BRAND_MARK } from '../components/Brand';
import { Spinner } from '../components/ui';
import { useT } from '../i18n';
import { auth, errorText } from '../ipc';
import { openExternal } from '../open';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';

const KEY_PAGE = 'https://www.speedrun.com/settings/api';

export function Setup({ onSkip }: { onSkip: () => void }) {
  const t = useT();
  const setProfile = useSession((state) => state.setProfile);
  const startup = useSession((state) => state.startup);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setError(t('setup.pasteFirst'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await auth.setApiKey(trimmed);
      // Clear the field the instant it is accepted: there is no reason for the
      // key to stay in the webview's memory once it is in the vault.
      setKey('');
      setProfile(profile);
      useUi
        .getState()
        .success(t('setup.connected'), t('setup.signedInAs', { name: profile.displayName }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup__box">
        <img className="setup__mark" src={BRAND_MARK} alt="SRCTools logo" />
        <div>
          <h1 className="h1">SRCTools</h1>
          <p className="page__subtitle" style={{ marginTop: 6 }}>
            {t('setup.tagline')}
          </p>
        </div>

        <div className="setup__steps">
          <div className="setup__step">
            <span className="setup__step-num">1</span>
            <span>
              {t('setup.step1Before')}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ display: 'inline-flex', height: 20, padding: '0 4px' }}
                onClick={() => void openExternal(KEY_PAGE)}
              >
                {t('setup.step1Link')} <ExternalLink size={11} />
              </button>
              {t('setup.step1After')}
            </span>
          </div>
          <div className="setup__step">
            <span className="setup__step-num">2</span>
            <span>{t('setup.step2')}</span>
          </div>
          <div className="setup__step">
            <span className="setup__step-num">3</span>
            <span>{t('setup.step3')}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('setup.placeholder')}
            aria-label={t('setup.placeholder')}
            onChange={(event) => {
              setKey(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void connect();
            }}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn--primary" onClick={() => void connect()} disabled={busy}>
            {busy ? <Spinner /> : <Key size={14} />}
            {t('setup.connect')}
          </button>
        </div>

        {error && (
          <div className="notice notice--danger" style={{ textAlign: 'left' }}>
            <ShieldAlert size={15} />
            <span data-selectable>{error}</span>
          </div>
        )}

        {startup && startup.warnings.length > 0 && (
          <div className="notice notice--warn" style={{ textAlign: 'left' }}>
            <ShieldAlert size={15} />
            <span>{startup.warnings.join(' ')}</span>
          </div>
        )}

        <button type="button" className="btn btn--ghost btn--sm" onClick={onSkip}>
          {t('setup.skip')}
        </button>
        <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
          {t('setup.skipHint')}
        </p>
      </div>
    </div>
  );
}
