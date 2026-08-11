/**
 * Settings.
 *
 * Six sections behind tabs rather than one very long scroll, because the things
 * grouped here have nothing to do with each other: a credential, a colour
 * scheme and a cache are not neighbours.
 *
 * The rule that shapes the Account section: the API key is write-only from the
 * UI's point of view. It is sent once to be validated and stored in the Windows
 * credential vault, the field is emptied the moment it is accepted, and the only
 * thing ever displayed afterwards is the masked preview the backend produces.
 * Nothing here reads the key back, logs it or puts it in an export.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  Filter,
  FolderOpen,
  Gamepad2,
  Gauge,
  HardDrive,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  Lock,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Video,
  Volume2,
  Webhook,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';

import {
  Badge,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  KeyHint,
  Modal,
  Segmented,
  Skeleton,
  Spinner,
  Tabs,
} from '../components/ui';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  plural,
  ABSENT,
} from '../format';
import { useT, LANGUAGES, LANGUAGE_NAMES, type Language, type Translate } from '../i18n';
import { auth, errorText, prefs, sound as soundIpc } from '../ipc';
import { copyToClipboard, openExternal } from '../open';
import { SHORTCUT_DEFINITIONS, eventBinding, type ShortcutDefinition } from '../shortcuts';
import { dropCustom, loadCustomSound, playNotificationSound } from '../sound';
import { useLivePresence } from '../hooks/usePresence';
import { useDiscord, useWebhook } from '../store/integrations';
import { QUEUE_COLUMNS } from '../store/queue';
import {
  useSession,
  type Density,
  type Settings as SettingsValues,
  type ThemeName,
} from '../store/session';
import { ACCENT_COLOURS, ACCENT_NAMES, DENSITIES, THEMES } from '../theme';
import { ui } from '../store/ui';
import { useUpdate } from '../store/update';
import { useWatcher } from '../store/watcher';
import type { CacheStats, RejectionTemplate } from '../types';
import { CHECK_INTERVALS, isCheckInterval } from '../watcher/intervals';

const KEY_PAGE = 'https://www.speedrun.com/settings/api';
const TWITCH_CONSOLE = 'https://dev.twitch.tv/console/apps';
const DISCORD_PORTAL = 'https://discord.com/developers/applications';

/**
 * The Rich Presence artwork, as uploaded in the Developer Portal.
 *
 * Mirrors `LARGE_IMAGE` / `LARGE_TEXT` in `src-tauri/src/discord.rs`. Shown here
 * because the moderator has to type the key into Discord themselves, and a key
 * that differs by one character produces a presence with no image and no error.
 */
const DISCORD_ASSET_KEY = 'srclogo';
const DISCORD_LARGE_TEXT = 'SRCTools Moderator Toolkit';

/** What `webhook_test` posts. Mirrors `TEST_MESSAGE` in `src-tauri/src/webhook.rs`. */
const TEST_MESSAGE = '✅ SRCTools webhook connected';

type Section =
  | 'account'
  | 'interface'
  | 'moderation'
  | 'notifications'
  | 'discord'
  | 'templates'
  | 'keyboard'
  | 'data'
  | 'about';

/** Setting keys of each primitive type, so the row helpers stay type-safe. */
type BooleanKey = {
  [K in keyof SettingsValues]: SettingsValues[K] extends boolean ? K : never;
}[keyof SettingsValues];

type NumberKey = {
  [K in keyof SettingsValues]: SettingsValues[K] extends number ? K : never;
}[keyof SettingsValues];

export function Settings() {
  const [section, setSection] = useState<Section>('account');
  const t = useT();

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">Settings</h2>
          <p className="page__subtitle">
            Credentials, appearance, keyboard bindings and everything SRCTools keeps on this
            machine.
          </p>
        </div>
      </div>

      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { value: 'account', label: 'Account' },
          { value: 'interface', label: 'Interface' },
          { value: 'moderation', label: 'Moderation' },
          { value: 'notifications', label: 'Notifications' },
          { value: 'discord', label: 'Discord' },
          { value: 'templates', label: 'Templates' },
          { value: 'keyboard', label: 'Keyboard' },
          { value: 'data', label: 'Data' },
          { value: 'about', label: t('settings.about') },
        ]}
      />

      <div className="settings" style={{ marginTop: 16 }}>
        {section === 'account' && <AccountSection />}
        {section === 'interface' && <InterfaceSection />}
        {section === 'moderation' && <ModerationSection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'discord' && <DiscordSection />}
        {section === 'templates' && <TemplatesSection />}
        {section === 'keyboard' && <KeyboardSection />}
        {section === 'data' && <DataSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- rows */

function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__label">{label}</div>
        {hint !== undefined && <div className="setting-row__hint">{hint}</div>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

/** A boolean preference, written through as soon as it is flipped. */
function ToggleRow({
  setting,
  label,
  hint,
}: {
  setting: BooleanKey;
  label: string;
  hint: ReactNode;
}) {
  const value = useSession((state) => state.settings[setting]);
  const update = useSession((state) => state.updateSetting);

  return (
    <Row label={label} hint={hint}>
      <Checkbox checked={value} onChange={(next) => void update(setting, next)} />
    </Row>
  );
}

/**
 * A numeric preference.
 *
 * Held in local state while it is being typed: writing on every keystroke would
 * store the `2` of `20` and, for the rate limit, briefly apply it.
 */
function NumberRow({
  setting,
  label,
  hint,
  min,
  max,
  unit,
}: {
  setting: NumberKey;
  label: string;
  hint: ReactNode;
  min: number;
  max: number;
  unit: string;
}) {
  const value = useSession((state) => state.settings[setting]);
  const update = useSession((state) => state.updateSetting);
  const [draft, setDraft] = useState(String(value));

  // The stored value can change underneath the field — the backend clamps the
  // rate limit and reports back what it actually applied.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) void update(setting, clamped);
  };

  return (
    <Row label={label} hint={hint}>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        style={{ width: 88, textAlign: 'right' }}
      />
      <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
        {unit}
      </span>
    </Row>
  );
}

/* ---------------------------------------------------------------- account */

function AccountSection() {
  const profile = useSession((state) => state.profile);
  const connection = useSession((state) => state.connection);
  const hasApiKey = useSession((state) => state.hasApiKey);
  const startup = useSession((state) => state.startup);
  const setProfile = useSession((state) => state.setProfile);
  const refreshConnection = useSession((state) => state.refreshConnection);

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // The connection panel is the point of this section, so it is fetched on
  // arrival rather than waiting for the moderator to press a button.
  useEffect(() => {
    void refreshConnection();
  }, [refreshConnection]);

  const connect = async () => {
    const trimmed = key.trim();
    if (trimmed === '') {
      setKeyError('Paste your API key first.');
      return;
    }
    setSaving(true);
    setKeyError(null);
    try {
      const next = await auth.setApiKey(trimmed);
      // Emptied the instant it is accepted: there is no reason for the key to
      // stay in the webview once the vault has it.
      setKey('');
      setProfile(next);
      await refreshConnection();
      ui.success('Key saved', `Signed in as ${next.displayName}`);
    } catch (err) {
      setKeyError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const ok = await ui.confirm({
      title: 'Remove the stored API key?',
      message:
        'The key is deleted from the Windows credential vault. Your local history, statistics and settings are kept, but nothing that talks to Speedrun.com will work until you add a key again.',
      danger: true,
      confirmLabel: 'Remove key',
    });
    if (!ok) return;
    try {
      await auth.clearApiKey();
      setProfile(null);
      await refreshConnection();
      ui.success('Key removed');
    } catch (err) {
      ui.error('Could not remove the key', err);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await refreshConnection();
      const status = useSession.getState().connection;
      if (status?.connected === true) ui.success('Connected', status.message);
      else ui.warning('Not connected', status?.message ?? 'Speedrun.com did not answer.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="Speedrun.com connection" icon={<KeyRound size={13} />}>
        <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 4 }}>
          {connection === null ? (
            <Badge tone="unknown" small dot>
              Checking
            </Badge>
          ) : connection.connected ? (
            <Badge tone="ok" small dot>
              Connected
            </Badge>
          ) : (
            <Badge tone={hasApiKey ? 'danger' : 'unknown'} small dot>
              {hasApiKey ? 'Not working' : 'No key'}
            </Badge>
          )}
          <span className="dim" style={{ fontSize: 'var(--text-xs)', flex: 1, minWidth: 0 }}>
            {connection?.message ?? 'Asking Speedrun.com who this key belongs to…'}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : connection?.connected === true ? <Wifi size={13} /> : <WifiOff size={13} />}
            Test connection
          </button>
        </div>

        <Row
          label="Signed in as"
          hint={
            profile === null
              ? 'No account is attached yet.'
              : profile.signupDate === null
                ? 'Account resolved from the stored key.'
                : `Joined Speedrun.com on ${formatDate(profile.signupDate)}.`
          }
        >
          {profile === null ? (
            <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>
              Nobody
            </span>
          ) : (
            <>
              <span style={{ fontSize: 'var(--text-sm)' }}>{profile.displayName}</span>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                title="Open the profile on Speedrun.com"
                aria-label="Open the profile on Speedrun.com"
                onClick={() => void openExternal(profile.weblink)}
                disabled={profile.weblink === null}
              >
                <ExternalLink size={13} />
              </button>
            </>
          )}
        </Row>

        <Row
          label="Stored key"
          hint="Only this masked preview is ever shown. SRCTools cannot display the key back to you, and it is never written to a log or an export."
        >
          <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
            {connection?.maskedKey ?? '—'}
          </span>
          {hasApiKey && (
            <button type="button" className="btn btn--sm btn--danger" onClick={() => void disconnect()}>
              <Trash2 size={13} />
              Remove
            </button>
          )}
        </Row>

        <Row
          label={hasApiKey ? 'Replace the key' : 'Add a key'}
          hint={
            <>
              Paste a key from your{' '}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ display: 'inline-flex', height: 18, padding: '0 3px' }}
                onClick={() => void openExternal(KEY_PAGE)}
              >
                Speedrun.com API settings <ExternalLink size={10} />
              </button>
              . It is checked against your profile before anything is saved.
            </>
          }
        >
          <input
            className="input"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder="API key"
            aria-label="Speedrun.com API key"
            onChange={(event) => {
              setKey(event.currentTarget.value);
              setKeyError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void connect();
            }}
            style={{ width: 220 }}
          />
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void connect()}
            disabled={saving}
          >
            {saving ? <Spinner /> : <ShieldCheck size={13} />}
            Save
          </button>
        </Row>

        {keyError !== null && (
          <div className="notice notice--danger" style={{ marginTop: 12 }}>
            <ShieldAlert size={15} />
            <span data-selectable>{keyError}</span>
          </div>
        )}

        {startup !== null && startup.warnings.length > 0 && (
          <div className="notice notice--warn" style={{ marginTop: 12 }}>
            <TriangleAlert size={15} />
            <span>{startup.warnings.join(' ')}</span>
          </div>
        )}
      </Card>

      <TwitchCard configured={connection?.twitchConfigured ?? false} onChanged={refreshConnection} />
    </div>
  );
}

/**
 * Twitch application credentials.
 *
 * Optional, and the copy says why: without them a Twitch link can still be
 * opened and watched, it just cannot be checked automatically, which SRCTools
 * reports as "could not check" rather than as a problem with the run.
 */
function TwitchCard({
  configured,
  onChanged,
}: {
  configured: boolean;
  onChanged: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (clientId.trim() === '' || clientSecret.trim() === '') {
      setError('Both the Client ID and the Client Secret are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.setTwitchCredentials(clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      await onChanged();
      ui.success('Twitch credentials saved', 'Twitch links can now be checked automatically.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const ok = await ui.confirm({
      title: 'Remove the Twitch credentials?',
      message:
        'Twitch links will still open normally, but SRCTools will report them as "could not check" instead of confirming whether the video exists.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await auth.clearTwitchCredentials();
      await onChanged();
      ui.success('Twitch credentials removed');
    } catch (err) {
      ui.error('Could not remove them', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Twitch video checks"
      icon={<Video size={13} />}
      actions={
        <Badge tone={configured ? 'ok' : 'unknown'} small dot>
          {configured ? 'Configured' : 'Not configured'}
        </Badge>
      }
    >
      <div className="notice notice--info" style={{ marginBottom: 6 }}>
        <Info size={15} />
        <span>
          Optional. Twitch requires an application of its own to answer questions about a video.
          Without one, SRCTools marks Twitch links “could not check” — never as deleted, because
          it genuinely does not know.
        </span>
      </div>

      <Row
        label="Client ID"
        hint={
          <>
            Create an application in the{' '}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ display: 'inline-flex', height: 18, padding: '0 3px' }}
              onClick={() => void openExternal(TWITCH_CONSOLE)}
            >
              Twitch developer console <ExternalLink size={10} />
            </button>
            . Both values are stored in the Windows credential vault.
          </>
        }
      >
        <input
          className="input"
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? 'Stored — enter to replace' : 'Client ID'}
          aria-label="Twitch Client ID"
          onChange={(event) => {
            setClientId(event.currentTarget.value);
            setError(null);
          }}
          style={{ width: 220 }}
        />
      </Row>

      <Row label="Client Secret" hint="Never displayed back, exported or logged.">
        <input
          className="input"
          type="password"
          value={clientSecret}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? 'Stored — enter to replace' : 'Client Secret'}
          aria-label="Twitch Client Secret"
          onChange={(event) => {
            setClientSecret(event.currentTarget.value);
            setError(null);
          }}
          style={{ width: 220 }}
        />
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : <ShieldCheck size={13} />}
          Save
        </button>
      </Row>

      {configured && (
        <Row label="Remove credentials" hint="Twitch checks stop; nothing else changes.">
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void clear()} disabled={busy}>
            <Trash2 size={13} />
            Remove
          </button>
        </Row>
      )}

      {error !== null && (
        <div className="notice notice--danger" style={{ marginTop: 12 }}>
          <ShieldAlert size={15} />
          <span data-selectable>{error}</span>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- interface */

function InterfaceSection() {
  const t = useT();
  const language = useSession((state) => state.settings.language);
  const theme = useSession((state) => state.settings.theme);
  const accent = useSession((state) => state.settings.accent);
  const customAccent = useSession((state) => state.settings.customAccent);
  const density = useSession((state) => state.settings.density);
  const sidebarIcons = useSession((state) => state.settings.sidebarIcons);
  const sidebarText = useSession((state) => state.settings.sidebarText);
  const hidden = useSession((state) => state.settings.hiddenColumns);
  const update = useSession((state) => state.updateSetting);

  const toggleColumn = (id: string, visible: boolean) => {
    const next = visible ? hidden.filter((entry) => entry !== id) : [...hidden, id];
    void update('hiddenColumns', next);
  };

  /**
   * Turning both sidebar options off would leave an unusable strip of nothing,
   * so the last one on refuses rather than silently re-enabling the other —
   * a switch that flips a different switch is worse than one that says no.
   */
  const setSidebar = (which: 'sidebarIcons' | 'sidebarText', next: boolean) => {
    const other = which === 'sidebarIcons' ? sidebarText : sidebarIcons;
    if (!next && !other) {
      ui.warning(t('settings.sidebar.bothOff'));
      return;
    }
    void update(which, next);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={t('settings.language')} icon={<Languages size={13} />}>
        <Row label={t('settings.language')} hint={t('settings.language.hint')}>
          {/* Names stay in their own language: someone who has landed in a
              language they cannot read needs to recognise their own by sight. */}
          <Segmented<Language>
            value={language}
            onChange={(next) => void update('language', next)}
            options={LANGUAGES.map((code) => ({
              value: code,
              label: LANGUAGE_NAMES[code],
            }))}
          />
        </Row>
      </Card>

      <Card title={t('settings.appearance')} icon={<Palette size={13} />}>
        <Row label={t('settings.theme')} hint={t('settings.theme.hint')}>
          <Segmented<ThemeName>
            value={theme}
            onChange={(next) => void update('theme', next)}
            options={THEMES.map((name) => ({
              value: name,
              label: t(`settings.theme.${name}`),
            }))}
          />
        </Row>

        <Row label={t('settings.accent')} hint={t('settings.accent.customHint')}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {ACCENT_NAMES.filter((name) => name !== 'custom').map((name) => (
              <button
                key={name}
                type="button"
                className="swatch"
                data-active={accent === name}
                title={t(`settings.accent.${name}`)}
                aria-label={t(`settings.accent.${name}`)}
                aria-pressed={accent === name}
                style={{ background: ACCENT_COLOURS[name as keyof typeof ACCENT_COLOURS] }}
                onClick={() => void update('accent', name)}
              />
            ))}
            {/* The picker doubles as the selector: choosing a colour is what a
                moderator means by "custom", so it does not need a second click. */}
            <input
              type="color"
              className="swatch swatch--custom"
              data-active={accent === 'custom'}
              title={t('settings.accent.custom')}
              aria-label={t('settings.accent.custom')}
              value={customAccent}
              onChange={(event) => {
                void update('customAccent', event.target.value);
                if (accent !== 'custom') void update('accent', 'custom');
              }}
            />
          </div>
        </Row>

        <Row label={t('settings.density')} hint={t('settings.density.hint')}>
          <Segmented<Density>
            value={density}
            onChange={(next) => void update('density', next)}
            options={DENSITIES.map((name) => ({
              value: name,
              label: t(`settings.density.${name}`),
            }))}
          />
        </Row>

        <Row label={t('settings.sidebar')} hint={t('settings.sidebar.hint')}>
          <div className="row" style={{ gap: 12 }}>
            <Checkbox
              checked={sidebarIcons}
              label={t('settings.sidebar.icons')}
              onChange={(next) => setSidebar('sidebarIcons', next)}
            />
            <Checkbox
              checked={sidebarText}
              label={t('settings.sidebar.text')}
              onChange={(next) => setSidebar('sidebarText', next)}
            />
          </div>
        </Row>

        <ToggleRow
          setting="expandAnalysis"
          label={t('settings.expandAnalysis')}
          hint={t('settings.expandAnalysis.hint')}
        />
      </Card>

      <Card title={t('settings.columns')} icon={<Layers size={13} />}>
        <p className="setting-row__hint" style={{ marginBottom: 10 }}>
          {t('settings.columns.hint')}
        </p>
        <div className="col" style={{ gap: 8 }}>
          {QUEUE_COLUMNS.map((column) => (
            <Checkbox
              key={column.id}
              checked={!hidden.includes(column.id)}
              label={column.label}
              onChange={(visible) => toggleColumn(column.id, visible)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- moderation */

function ModerationSection() {
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="Confirmations" icon={<ShieldCheck size={13} />}>
        <ToggleRow
          setting="confirmVerify"
          label="Ask before verifying a run"
          hint="Rejection and deletion always ask, whatever this is set to — they are visible to the runner or cannot be undone."
        />
      </Card>

      <Card title="Queue" icon={<Layers size={13} />}>
        <ToggleRow
          setting="onlyMyGames"
          label="Only show games I moderate"
          hint="Off widens the queue to every pending run Speedrun.com will return, including games where you cannot act."
        />
        <NumberRow
          setting="queueLimit"
          label="Runs per refresh"
          hint="How many runs one refresh fetches. Higher means fewer round trips but a longer wait before anything appears. The backend caps this at 2000."
          min={25}
          max={2000}
          unit="runs"
        />
        <ToggleRow
          setting="autoCheckVideos"
          label="Check videos when the queue loads"
          hint="Verifies each run’s video links in the background. Turn it off on a slow connection — a check that fails is reported as “could not check”, never as a missing video."
        />
      </Card>

      <Card title="Fast Review" icon={<Zap size={13} />}>
        <NumberRow
          setting="fastReviewDelay"
          label="Pause after each decision"
          hint="Seconds the outcome stays on screen before the next run appears. Zero advances immediately; a second or two makes a mistyped key obvious while it still means something."
          min={0}
          max={10}
          unit="seconds"
        />
      </Card>

      <Card title="Request budget" icon={<Gauge size={13} />}>
        <NumberRow
          setting="rateLimit"
          label="Requests per minute"
          hint="A self-imposed ceiling on how fast SRCTools talks to Speedrun.com, kept below their published limit. Between 10 and 100; the backend clamps anything outside that and reports back what it applied."
          min={10}
          max={100}
          unit="req/min"
        />
        <RateLimitRow />
      </Card>
    </div>
  );
}

/** Live view of the budget, so the number above has visible consequences. */
function RateLimitRow() {
  const rateLimit = useSession((state) => state.rateLimit);
  const refresh = useSession((state) => state.refreshRateLimit);

  return (
    <Row
      label="Currently used"
      hint="Requests issued in the last sliding minute. When the budget is full, SRCTools waits rather than letting Speedrun.com refuse the request."
    >
      <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
        {formatNumber(rateLimit.used)} / {formatNumber(rateLimit.capacity)}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--ghost btn--icon"
        title="Refresh"
        aria-label="Refresh the request budget"
        onClick={() => void refresh()}
      >
        <RefreshCw size={13} />
      </button>
    </Row>
  );
}

/* ----------------------------------------------------------- notifications */

/**
 * Human label for a poll interval.
 *
 * Minutes only when the value divides evenly into them.
 */
function intervalLabel(seconds: number, t: Translate): string {
  return seconds >= 60 && seconds % 60 === 0
    ? t('common.minutes', { count: seconds / 60 })
    : t('common.seconds', { count: seconds });
}

function NotificationsSection() {
  const t = useT();
  const notifyNewRuns = useSession((state) => state.settings.notifyNewRuns);
  const soundEnabled = useSession((state) => state.settings.soundEnabled);
  const soundVolume = useSession((state) => state.settings.soundVolume);
  const checkInterval = useSession((state) => state.settings.checkInterval);
  const customSoundName = useSession((state) => state.settings.customSoundName);
  const update = useSession((state) => state.updateSetting);

  /** True while a file is being copied, so the two buttons cannot race. */
  const [importing, setImporting] = useState(false);

  // Dragging writes on every frame otherwise, and each write is a database
  // round trip. The slider follows the pointer from local state and the
  // preference is stored once, when the drag ends.
  const [volumeDraft, setVolumeDraft] = useState(soundVolume);
  useEffect(() => {
    setVolumeDraft(soundVolume);
  }, [soundVolume]);

  /**
   * Plays the sound at whatever the slider currently shows.
   *
   * Also serves a second purpose: a Chromium webview refuses to play audio
   * until the user has interacted with the page, so this click is what makes
   * the first real notification audible.
   */
  const test = async () => {
    const played = await playNotificationSound(volumeDraft);
    if (!played) {
      ui.warning(t('toast.soundBlocked'), t('toast.soundBlockedHint'));
    }
  };

  /**
   * Picks a file, copies it into the profile and plays it once.
   *
   * The preview is not a flourish: it is the only way to find out that a file
   * the webview cannot decode was chosen, and it happens while the moderator is
   * still looking at the setting rather than at three in the morning when a run
   * arrives.
   */
  const chooseSound = async () => {
    setImporting(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: t('settings.notify.customSoundChoose'),
        filters: [{ name: t('settings.notify.customSound'), extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
      });
      // `null` is a cancelled dialog, which is not an error and needs no toast.
      if (typeof picked !== 'string') return;

      const stored = await soundIpc.import(picked);
      await update('customSoundName', stored.name);
      const loaded = await loadCustomSound();
      if (!loaded) {
        // The file was copied but could not be turned into something playable.
        // Say so rather than leave a name on screen that nothing will ever play.
        await soundIpc.clear();
        await update('customSoundName', '');
        ui.error(t('toast.soundImportFailed'), t('toast.soundImportFailedHint'));
        return;
      }
      ui.success(t('toast.soundImported'), stored.name);
      await test();
    } catch (err) {
      ui.error(t('toast.soundImportFailed'), errorText(err));
    } finally {
      setImporting(false);
    }
  };

  const resetSound = async () => {
    setImporting(true);
    try {
      await soundIpc.clear();
      dropCustom();
      await update('customSoundName', '');
      ui.success(t('toast.soundReset'), t('settings.notify.customSoundBundled'));
    } catch (err) {
      ui.error(t('toast.soundResetFailed'), errorText(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={t('settings.notify.title')} icon={<Bell size={13} />}>
        <ToggleRow
          setting="notifyNewRuns"
          label={t('settings.notify.newRuns')}
          hint={t('settings.notify.newRunsHint')}
        />
        <ToggleRow
          setting="notifyVideoProblems"
          label={t('settings.notify.videoProblems')}
          hint={t('settings.notify.videoProblemsHint')}
        />
        <ToggleRow
          setting="notifyApiErrors"
          label={t('settings.notify.apiErrors')}
          hint={t('settings.notify.apiErrorsHint')}
        />
        <ToggleRow
          setting="notifyOnBulkComplete"
          label={t('settings.notify.bulkComplete')}
          hint={t('settings.notify.bulkCompleteHint')}
        />
      </Card>

      <Card title={t('settings.notify.sound')} icon={<Volume2 size={13} />}>
        <ToggleRow
          setting="soundEnabled"
          label={t('settings.notify.sound')}
          hint={t('settings.notify.soundHint')}
        />

        <Row
          label={t('settings.notify.volume')}
          hint={`${Math.round(volumeDraft * 100)}%`}
        >
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(volumeDraft * 100)}
            disabled={!soundEnabled}
            aria-label={t('settings.notify.volume')}
            onChange={(event) => setVolumeDraft(Number(event.currentTarget.value) / 100)}
            onPointerUp={() => void update('soundVolume', volumeDraft)}
            onKeyUp={() => void update('soundVolume', volumeDraft)}
            onBlur={() => void update('soundVolume', volumeDraft)}
          />
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={!soundEnabled}
            onClick={() => void test()}
          >
            <Play size={12} />
            {t('settings.notify.test')}
          </button>
        </Row>

        <Row
          label={t('settings.notify.customSound')}
          hint={
            customSoundName === ''
              ? t('settings.notify.customSoundBundled')
              : t('settings.notify.customSoundUsing', { name: customSoundName })
          }
        >
          <button
            type="button"
            className="btn btn--sm"
            disabled={importing}
            onClick={() => void chooseSound()}
          >
            {importing ? <Spinner /> : <FolderOpen size={12} />}
            {t('settings.notify.customSoundChoose')}
          </button>
          {customSoundName !== '' && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={importing}
              onClick={() => void resetSound()}
            >
              <RotateCcw size={12} />
              {t('settings.notify.customSoundReset')}
            </button>
          )}
        </Row>
      </Card>

      <Card title={t('settings.notify.interval')} icon={<Timer size={13} />}>
        <Row label={t('settings.notify.interval')} hint={t('settings.notify.intervalHint')}>
          <select
            className="select"
            value={checkInterval}
            disabled={!notifyNewRuns}
            aria-label={t('settings.notify.interval')}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (isCheckInterval(next)) void update('checkInterval', next);
            }}
            style={{ width: 140 }}
          >
            {CHECK_INTERVALS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {intervalLabel(seconds, t)}
              </option>
            ))}
          </select>
        </Row>

        <WatcherStateRow />
      </Card>

      <WebhookCard />
    </div>
  );
}

/**
 * What the watcher is doing right now.
 *
 * Without this the interval control is a claim rather than a setting: the
 * moderator has no way to tell that polling is happening, or that it has backed
 * off because Speedrun.com is failing.
 */
function WatcherStateRow() {
  const t = useT();
  const notifyNewRuns = useSession((state) => state.settings.notifyNewRuns);
  const hasApiKey = useSession((state) => state.hasApiKey);

  const running = useWatcher((state) => state.running);
  const failures = useWatcher((state) => state.failures);
  const delay = useWatcher((state) => state.delay);
  const lastCheck = useWatcher((state) => state.lastCheck);
  const lastError = useWatcher((state) => state.lastError);

  let state: string;
  if (!notifyNewRuns) state = t('settings.notify.watcherOff');
  else if (!hasApiKey || !running) state = t('settings.notify.watcherIdle');
  else if (failures > 0) {
    state = t('settings.notify.watcherBackoff', {
      count: failures,
      interval: intervalLabel(delay, t),
    });
  } else state = t('settings.notify.watcherRunning', { interval: intervalLabel(delay, t) });

  const hint = (
    <>
      {state}
      {lastCheck && ` ${t('settings.notify.watcherLast', { when: formatRelative(lastCheck) })}`}
      {/* The reason a poll failed belongs here rather than in a toast: it is a
          standing condition, not an event, and the moderator is already looking
          at the control that caused it. */}
      {lastError && <span style={{ display: 'block', marginTop: 2 }}>{lastError}</span>}
    </>
  );

  return (
    <Row label={t('settings.notify.watcherState')} hint={hint}>
      <Badge tone={running ? (failures > 0 ? 'warn' : 'ok') : 'neutral'} dot>
        {running
          ? failures > 0
            ? t('settings.notify.watcherBadgeBackoff')
            : t('settings.notify.watcherBadgeRunning')
          : t('settings.notify.watcherBadgeStopped')}
      </Badge>
      <button
        type="button"
        className="btn btn--sm btn--ghost btn--icon"
        title={t('settings.notify.checkNow')}
        aria-label={t('settings.notify.checkNow')}
        disabled={!running}
        onClick={() => void useWatcher.getState().poll()}
      >
        <RefreshCw size={13} />
      </button>
    </Row>
  );
}

/* ------------------------------------------------------------------ webhook */

/**
 * The Discord channel webhook.
 *
 * The URL is treated as a credential throughout: typed into a password field,
 * sent once to be validated and stored in the Windows credential vault, and
 * never read back — the only thing displayed afterwards is the masked preview
 * the backend produces. Nothing here logs it or puts it in an export.
 */
function WebhookCard() {
  const t = useT();
  const status = useWebhook((state) => state.status);
  const load = useWebhook((state) => state.load);
  const enabled = useSession((state) => state.settings.webhookEnabled);
  const update = useSession((state) => state.updateSetting);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const url = draft.trim();
    if (url === '') {
      setError(t('settings.webhook.urlMissing'));
      return;
    }
    setBusy('save');
    setError(null);
    try {
      await useWebhook.getState().save(url);
      setDraft('');
      // Saving a URL is the moment the moderator means to use it; leaving the
      // master switch off would make the next question "why is nothing posted".
      if (!enabled) await update('webhookEnabled', true);
      // The masked preview is the receipt: it shows which webhook was stored
      // without putting the URL back on screen.
      ui.success(
        t('settings.webhook.saved'),
        useWebhook.getState().status.preview ?? undefined,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      await useWebhook.getState().test();
      ui.success(t('settings.webhook.tested'));
    } catch (err) {
      setError(t('settings.webhook.testFailed', { error: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await ui.confirm({
      title: t('settings.webhook.removeTitle'),
      message: t('settings.webhook.removeMessage'),
      danger: true,
      confirmLabel: t('settings.webhook.remove'),
    });
    if (!ok) return;
    setBusy('remove');
    setError(null);
    try {
      await useWebhook.getState().clear();
      // The switch follows the URL out: an enabled webhook with nothing to post
      // to would fail on the next run and report it as a Discord problem.
      if (enabled) await update('webhookEnabled', false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={t('settings.webhook.title')}
      icon={<Webhook size={13} />}
      actions={
        <Badge tone={status.configured ? 'ok' : 'unknown'} small dot>
          {status.configured
            ? t('settings.webhook.configured')
            : t('settings.webhook.notConfigured')}
        </Badge>
      }
    >
      <Row
        label={t('settings.webhook.url')}
        hint={t('settings.webhook.urlHint', {
          preview: status.preview ?? t('settings.webhook.placeholder'),
        })}
      >
        <input
          className="input"
          type="password"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            status.configured
              ? t('settings.webhook.stored')
              : t('settings.webhook.placeholder')
          }
          aria-label={t('settings.webhook.url')}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
          style={{ width: 240 }}
        />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => void save()}
          disabled={busy !== null}
        >
          {busy === 'save' ? <Spinner /> : <ShieldCheck size={13} />}
          {t('settings.webhook.save')}
        </button>
      </Row>

      <Row label={t('settings.webhook.enable')} hint={t('settings.webhook.eventsHint')}>
        <Checkbox
          checked={enabled}
          disabled={!status.configured}
          onChange={(next) => void update('webhookEnabled', next)}
        />
      </Row>

      {status.configured && (
        <>
          <Row label={t('settings.webhook.test')} hint={TEST_MESSAGE}>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void test()}
              disabled={busy !== null}
            >
              {busy === 'test' ? <Spinner /> : <Send size={13} />}
              {t('settings.webhook.test')}
            </button>
          </Row>

          <Row
            label={t('settings.webhook.remove')}
            hint={t('settings.webhook.removeMessage')}
          >
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => void remove()}
              disabled={busy !== null}
            >
              {busy === 'remove' ? <Spinner /> : <Trash2 size={13} />}
              {t('settings.webhook.remove')}
            </button>
          </Row>
        </>
      )}

      <div className="setting-row__label" style={{ marginTop: 12, marginBottom: 4 }}>
        {t('settings.webhook.events')}
      </div>
      <WebhookEventRow setting="webhookNewRuns" label={t('settings.webhook.events.newRuns')} />
      <WebhookEventRow setting="webhookApproved" label={t('settings.webhook.events.approved')} />
      <WebhookEventRow setting="webhookRejected" label={t('settings.webhook.events.rejected')} />
      <WebhookEventRow
        setting="webhookDeletedVideos"
        label={t('settings.webhook.events.deletedVideos')}
      />
      <WebhookEventRow
        setting="webhookVideoProblems"
        label={t('settings.webhook.events.videoProblems')}
      />

      <WebhookGamesRow />

      {error !== null && (
        <div className="notice notice--danger" style={{ marginTop: 12 }}>
          <ShieldAlert size={15} />
          <span data-selectable>{error}</span>
        </div>
      )}
    </Card>
  );
}

/**
 * One event toggle.
 *
 * Disabled rather than hidden while the webhook is off: the choice is still
 * worth seeing, and a control that vanishes is harder to find again than one
 * that is visibly waiting on the switch above it.
 */
function WebhookEventRow({ setting, label }: { setting: BooleanKey; label: string }) {
  const value = useSession((state) => state.settings[setting]);
  const enabled = useSession((state) => state.settings.webhookEnabled);
  const update = useSession((state) => state.updateSetting);

  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__label">{label}</div>
      </div>
      <div className="setting-row__control">
        <Checkbox
          checked={value}
          disabled={!enabled}
          onChange={(next) => void update(setting, next)}
        />
      </div>
    </div>
  );
}

/**
 * Which games the webhook posts about.
 *
 * No selection means every game, which is what an untouched install does. The
 * count is stated in words rather than left as a row of ticks, because "posts
 * about 2 of your 36 games" is the part that is easy to forget and expensive to
 * get wrong — a filter that silently matches nothing looks exactly like a
 * broken webhook.
 */
function WebhookGamesRow() {
  const t = useT();
  const selected = useSession((state) => state.settings.webhookGames);
  const enabled = useSession((state) => state.settings.webhookEnabled);
  const games = useSession((state) => state.games);
  const update = useSession((state) => state.updateSetting);
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((g) => g !== id)
      : [...selected, id];
    void update('webhookGames', next);
  };

  const hint =
    selected.length === 0
      ? t('settings.webhook.games.all')
      : t('settings.webhook.games.some', { count: selected.length, total: games.length });

  return (
    <>
      <Row label={t('settings.webhook.games')} hint={hint}>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={!enabled}
          onClick={() => setOpen((v) => !v)}
        >
          <Filter size={13} />
          {open ? t('settings.webhook.games.hide') : t('settings.webhook.games.choose')}
        </button>
      </Row>

      {open && enabled && (
        <div style={{ maxHeight: 220, overflowY: 'auto', paddingLeft: 4, marginBottom: 8 }}>
          {games.length === 0 && (
            <div className="setting-row__hint">{t('settings.webhook.games.none')}</div>
          )}
          {games.map((game) => (
            <div className="setting-row" key={game.id}>
              <div className="setting-row__text">
                <div className="setting-row__label">{game.name}</div>
              </div>
              <div className="setting-row__control">
                <Checkbox
                  checked={selected.includes(game.id)}
                  onChange={() => toggle(game.id)}
                />
              </div>
            </div>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void update('webhookGames', [])}
            >
              {t('settings.webhook.games.clear')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ discord */

/**
 * Rich Presence.
 *
 * The artwork is the application's, not SRCTools': Discord will only show an
 * image an application actually owns, so the moderator has to create one and
 * upload the asset under the key named here. Until then the presence still
 * works, it simply appears without a picture — which is why the copy says so
 * instead of pretending the setting failed.
 */
function DiscordSection() {
  const t = useT();
  const status = useDiscord((state) => state.status);
  const enabled = useSession((state) => state.settings.discordEnabled);
  const appId = useSession((state) => state.settings.discordAppId);
  const update = useSession((state) => state.updateSetting);

  const [draft, setDraft] = useState(appId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useDiscord.getState().load();
  }, []);

  useEffect(() => {
    setDraft(appId);
  }, [appId]);

  const commitAppId = () => {
    const next = draft.trim();
    if (next === appId) return;
    setError(null);
    void update('discordAppId', next);
  };

  const toggle = (next: boolean) => {
    if (next && appId.trim() === '' && draft.trim() === '') {
      setError(t('settings.discord.appIdMissing'));
      return;
    }
    setError(null);
    // A pending edit in the field is what the moderator means by "on".
    if (draft.trim() !== appId) void update('discordAppId', draft.trim());
    void update('discordEnabled', next);
  };

  let connectionHint: string;
  if (!enabled) connectionHint = t('settings.discord.disabled');
  else if (status.connected) connectionHint = t('settings.discord.connected');
  else connectionHint = status.lastError ?? t('settings.discord.notRunning');

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card
        title={t('settings.discord.title')}
        icon={<Gamepad2 size={13} />}
        actions={
          <Badge tone={status.connected ? 'ok' : enabled ? 'warn' : 'unknown'} small dot>
            {status.connected
              ? t('settings.discord.badgeConnected')
              : enabled
                ? t('settings.discord.badgeWaiting')
                : t('settings.discord.badgeOff')}
          </Badge>
        }
      >
        <Row label={t('settings.discord.enable')} hint={t('settings.discord.appIdHint')}>
          <Checkbox checked={enabled} onChange={toggle} />
        </Row>

        <Row
          label={t('settings.discord.appId')}
          hint={
            <>
              {t('settings.discord.appIdHint')}{' '}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ display: 'inline-flex', height: 18, padding: '0 3px' }}
                onClick={() => void openExternal(DISCORD_PORTAL)}
              >
                discord.com/developers <ExternalLink size={10} />
              </button>
            </>
          }
        >
          <input
            className="input"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            placeholder="000000000000000000"
            aria-label={t('settings.discord.appId')}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
            onBlur={commitAppId}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            style={{ width: 240 }}
          />
        </Row>

        <Row label={t('settings.discord.assets')} hint={t('settings.discord.assetsHint')}>
          <code className="mono" data-selectable style={{ fontSize: 'var(--text-xs)' }}>
            {DISCORD_ASSET_KEY}
          </code>
        </Row>

        <Row label={t('settings.discord.status')} hint={connectionHint}>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={!enabled}
            onClick={() => void useDiscord.getState().reconnect()}
          >
            <RefreshCw size={13} />
            {t('settings.discord.reconnect')}
          </button>
        </Row>

        {error !== null && (
          <div className="notice notice--danger" style={{ marginTop: 12 }}>
            <ShieldAlert size={15} />
            <span data-selectable>{error}</span>
          </div>
        )}
      </Card>

      <Card title={t('settings.discord.show')} icon={<Eye size={13} />}>
        <ToggleRow
          setting="discordShowPage"
          label={t('settings.discord.showPage')}
          hint={t('discord.page.queue')}
        />
        <ToggleRow
          setting="discordShowPending"
          label={t('settings.discord.showPending')}
          hint={t('discord.presence.pending', { count: 4 })}
        />
        <ToggleRow
          setting="discordShowGame"
          label={t('settings.discord.showGame')}
          hint={t('discord.presence.reviewing', { game: 'Half-Life 2' })}
        />
        <ToggleRow
          setting="discordShowModerator"
          label={t('settings.discord.showModerator')}
          hint={t('discord.presence.moderator', { name: 'you' })}
        />
        <DiscordPreviewRow />
      </Card>
    </div>
  );
}

/**
 * Exactly what Discord is being sent right now.
 *
 * Built from the same function the shell publishes with, so this is the
 * presence rather than a mock-up of one.
 */
function DiscordPreviewRow() {
  const t = useT();
  const presence = useLivePresence();

  return (
    <Row label={t('settings.discord.preview')} hint={DISCORD_LARGE_TEXT}>
      <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>SRCTools</strong>
        <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
          {presence.details ?? ABSENT}
        </span>
        <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
          {presence.state ?? ABSENT}
        </span>
      </div>
    </Row>
  );
}

/* -------------------------------------------------------------- templates */

function TemplatesSection() {
  const templates = useSession((state) => state.templates);
  const refresh = useSession((state) => state.refreshTemplates);

  const [editing, setEditing] = useState<RejectionTemplate | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (template: RejectionTemplate) => {
    const ok = await ui.confirm({
      title: `Delete “${template.label}”?`,
      message:
        'The template is removed from the rejection dialog. Rejections you have already sent are unaffected.',
      danger: true,
      confirmLabel: 'Delete template',
    });
    if (!ok) return;
    try {
      await prefs.deleteTemplate(template.id);
      await refresh();
      ui.success('Template deleted');
    } catch (err) {
      ui.error('Could not delete the template', err);
    }
  };

  /** Moves a template one place, then writes the whole order back. */
  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= templates.length) return;
    const order = templates.map((template) => template.id);
    const moved = order[index];
    const displaced = order[target];
    if (moved === undefined || displaced === undefined) return;
    order[index] = displaced;
    order[target] = moved;
    setBusy(true);
    try {
      await prefs.reorderTemplates(order);
      await refresh();
    } catch (err) {
      ui.error('Could not reorder the templates', err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await prefs.restoreTemplates();
      await refresh();
      ui.success('Built-in templates restored', 'Your own templates were left alone.');
    } catch (err) {
      ui.error('Could not restore them', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Rejection templates"
        icon={<Pencil size={13} />}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn--sm" onClick={() => void restore()} disabled={busy}>
              <Undo2 size={13} />
              Restore built-ins
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>
              <Plus size={13} />
              New template
            </button>
          </div>
        }
      >
        <p className="setting-row__hint" style={{ marginBottom: 12 }}>
          Picking a template in the rejection dialog fills the reason box — it never sends anything
          on its own, so every rejection is still text you have read. The runner sees exactly what
          is in that box.
        </p>

        {templates.length === 0 ? (
          <EmptyState
            icon={<Pencil size={24} />}
            title="No templates"
            hint="Add one for a reason you write often, or restore the built-in set."
            action={
              <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                <Plus size={13} />
                New template
              </button>
            }
          />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {templates.map((template, index) => (
              <div
                key={template.id}
                className="card"
                style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'flex-start' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                      {template.label}
                    </span>
                    {template.builtin && (
                      <Badge tone="neutral" small outline>
                        Built-in
                      </Badge>
                    )}
                  </div>
                  <div className="setting-row__hint" data-selectable>
                    {template.body}
                  </div>
                </div>

                <div className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title="Move up"
                    aria-label="Move up"
                    disabled={index === 0 || busy}
                    onClick={() => void move(index, -1)}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title="Move down"
                    aria-label="Move down"
                    disabled={index === templates.length - 1 || busy}
                    onClick={() => void move(index, 1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title="Edit"
                    aria-label="Edit template"
                    onClick={() => setEditing(template)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title="Copy the text"
                    aria-label="Copy the template text"
                    onClick={() => void copyToClipboard(template.body, 'Template copied')}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title="Delete"
                    aria-label="Delete template"
                    onClick={() => void remove(template)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing !== null && (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function TemplateDialog({
  template,
  onClose,
  onSaved,
}: {
  template: RejectionTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(template?.label ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (label.trim() === '' || body.trim() === '') {
      setError('A template needs both a name and a body.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await prefs.saveTemplate(label.trim(), body.trim(), template?.id ?? null);
      ui.success(template === null ? 'Template added' : 'Template saved');
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={template === null ? 'New rejection template' : 'Edit template'}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner /> : null}
            Save template
          </button>
        </>
      }
    >
      <label className="label" htmlFor="template-label">
        Name
      </label>
      <input
        id="template-label"
        className="input"
        value={label}
        placeholder="Video unavailable"
        onChange={(event) => {
          setLabel(event.currentTarget.value);
          setError(null);
        }}
        style={{ width: '100%', marginBottom: 12 }}
      />

      <label className="label" htmlFor="template-body">
        Message to the runner
      </label>
      <textarea
        id="template-body"
        className="textarea"
        rows={5}
        value={body}
        placeholder="The video link on this run cannot be viewed. Please resubmit with a working link."
        onChange={(event) => {
          setBody(event.currentTarget.value);
          setError(null);
        }}
        style={{ width: '100%' }}
      />
      <p className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 8, lineHeight: 1.55 }}>
        This text is sent to Speedrun.com as the rejection reason and is visible to the runner, so
        write it as a message to them. You can still edit it before sending.
      </p>

      {error !== null && (
        <div className="notice notice--danger" style={{ marginTop: 12 }}>
          <ShieldAlert size={15} />
          <span data-selectable>{error}</span>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- keyboard */

function KeyboardSection() {
  const shortcuts = useSession((state) => state.shortcuts);
  const setShortcut = useSession((state) => state.setShortcut);
  const resetShortcuts = useSession((state) => state.resetShortcuts);

  const [capturing, setCapturing] = useState<ShortcutDefinition | null>(null);

  const reset = async () => {
    const ok = await ui.confirm({
      title: 'Reset every shortcut?',
      message: 'All bindings go back to their defaults. Nothing else changes.',
      confirmLabel: 'Reset shortcuts',
    });
    if (!ok) return;
    try {
      await resetShortcuts();
      ui.success('Shortcuts reset');
    } catch (err) {
      ui.error('Could not reset the shortcuts', err);
    }
  };

  const groups: ShortcutDefinition['group'][] = [
    'Moderation',
    'Navigation',
    'Selection',
    'Application',
  ];

  return (
    <>
      <div className="notice notice--info" style={{ marginBottom: 16 }}>
        <Info size={15} />
        <span>
          Press <KeyHint binding="?" /> anywhere to see this list as a quick reference. Sequences
          such as <KeyHint binding="g d" /> are two presses in a row, not a chord.
        </span>
      </div>

      <div className="col" style={{ gap: 16 }}>
        {groups.map((group) => (
          <Card
            key={group}
            title={group}
            icon={<Keyboard size={13} />}
            actions={
              group === 'Application' ? (
                <button type="button" className="btn btn--sm" onClick={() => void reset()}>
                  <RotateCcw size={13} />
                  Reset all
                </button>
              ) : undefined
            }
          >
            {SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group).map(
              (definition) => {
                const binding = shortcuts[definition.action] ?? definition.binding;
                const custom = binding !== definition.binding;
                return (
                  <Row
                    key={definition.action}
                    label={definition.label}
                    hint={definition.description}
                  >
                    {custom && (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost btn--icon"
                        title={`Restore the default (${definition.binding})`}
                        aria-label="Restore the default binding"
                        onClick={() => void setShortcut(definition.action, '')}
                      >
                        <Undo2 size={13} />
                      </button>
                    )}
                    <KeyHint binding={binding} />
                    {definition.fixed === true ? (
                      <span
                        className="dim"
                        title="This binding is a convention the app depends on and cannot be changed."
                        style={{ display: 'inline-flex', alignItems: 'center', padding: '0 4px' }}
                      >
                        <Lock size={13} />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setCapturing(definition)}
                      >
                        Change
                      </button>
                    )}
                  </Row>
                );
              },
            )}
          </Card>
        ))}
      </div>

      {capturing !== null && (
        <CaptureDialog
          definition={capturing}
          current={shortcuts[capturing.action] ?? capturing.binding}
          onClose={() => setCapturing(null)}
          onCapture={(binding) => {
            setCapturing(null);
            void setShortcut(capturing.action, binding).catch((err: unknown) => {
              ui.error('Could not save the binding', err);
            });
          }}
        />
      )}
    </>
  );
}

/**
 * Captures the next keystroke as a binding.
 *
 * The listener is on the dialog itself in capture phase, so the global shortcut
 * handler never sees the keystroke — otherwise rebinding `r` would open the
 * rejection dialog on the way past.
 */
function CaptureDialog({
  definition,
  current,
  onClose,
  onCapture,
}: {
  definition: ShortcutDefinition;
  current: string;
  onClose: () => void;
  onCapture: (binding: string) => void;
}) {
  const shortcuts = useSession((state) => state.shortcuts);
  const [captured, setCaptured] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return; // Escape closes; it is never a binding.
      const binding = eventBinding(event);
      if (!binding) return; // A bare modifier press.
      event.preventDefault();
      event.stopPropagation();
      setCaptured(binding);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Compared against the bindings actually in force, not the defaults — a key
  // freed up by an earlier rebind is not a conflict.
  const conflict =
    captured === null
      ? null
      : (SHORTCUT_DEFINITIONS.find(
          (other) =>
            other.action !== definition.action &&
            (shortcuts[other.action] ?? other.binding) === captured,
        ) ?? null);

  return (
    <Modal
      title={`Rebind “${definition.label}”`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={captured === null}
            onClick={() => {
              if (captured !== null) onCapture(captured);
            }}
          >
            Use this key
          </button>
        </>
      }
    >
      <p style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
        Press the key or combination you want. Escape closes this window without changing
        anything.
      </p>

      <div
        className="row"
        style={{ gap: 10, alignItems: 'center', justifyContent: 'center', padding: '18px 0' }}
      >
        {captured === null ? (
          <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            Waiting for a keystroke… currently <KeyHint binding={current} />
          </span>
        ) : (
          <KeyHint binding={captured} />
        )}
      </div>

      {conflict !== null && (
        <div className="notice notice--warn">
          <TriangleAlert size={15} />
          <span>
            “{conflict.label}” already uses this key. Both will fire on it until you rebind that
            one too.
          </span>
        </div>
      )}

      <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.55, marginTop: 10 }}>
        Two-key sequences such as <KeyHint binding="g d" /> cannot be recorded here; they are set
        by the defaults.
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------------------- data */

function DataSection() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void prefs
      .cacheStats()
      .then((result) => {
        if (cancelled) return;
        setStats(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorText(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reload]);

  const prune = async () => {
    setBusy(true);
    try {
      const removed = await prefs.cachePrune();
      ui.success(
        removed === 0 ? 'Nothing had expired' : `Removed ${plural(removed, 'expiredEntry')}`,
      );
      setReload((n) => n + 1);
    } catch (err) {
      ui.error('Could not prune the cache', err);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const ok = await ui.confirm({
      title: 'Empty the cache?',
      message:
        'Everything in the cache came from Speedrun.com and can be fetched again, so nothing is lost — but the next few screens will be slower and will spend API requests. Your history, statistics and settings are not touched.',
      confirmLabel: 'Empty cache',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const removed = await prefs.cacheClear();
      ui.success(`Cache emptied`, `${plural(removed, 'entry')} removed.`);
      setReload((n) => n + 1);
    } catch (err) {
      ui.error('Could not empty the cache', err);
    } finally {
      setBusy(false);
    }
  };

  const invalidate = async (kind: string, label: string) => {
    setBusy(true);
    try {
      const removed = await prefs.cacheInvalidate(kind);
      ui.success(`${label} refreshed`, `${plural(removed, 'entry')} dropped.`);
      setReload((n) => n + 1);
    } catch (err) {
      ui.error(`Could not drop the ${label.toLowerCase()} cache`, err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card
        title="Local database"
        icon={<Database size={13} />}
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setReload((n) => n + 1)}
            disabled={loading}
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            Refresh
          </button>
        }
      >
        {error !== null ? (
          <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
        ) : loading && stats === null ? (
          <div className="col" style={{ gap: 10 }}>
            <Skeleton height={14} />
            <Skeleton height={14} />
            <Skeleton height={14} />
          </div>
        ) : stats === null ? null : (
          <>
            <Row
              label="Where it lives"
              hint="One SQLite file. It holds the cache, your local history and your settings — never a credential; those are in the Windows vault."
            >
              <span className="mono truncate" style={{ fontSize: 'var(--text-xs)', maxWidth: 260 }}>
                {stats.databasePath}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                title="Copy the path"
                aria-label="Copy the database path"
                onClick={() => void copyToClipboard(stats.databasePath, 'Path copied')}
              >
                <Copy size={13} />
              </button>
            </Row>

            <Row label="File size" hint="Includes free space SQLite has reserved for reuse.">
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatBytes(stats.databaseBytes)}
              </span>
            </Row>

            <Row
              label="Cached API responses"
              hint={
                stats.oldestEntryAt === null
                  ? 'Nothing cached yet.'
                  : `Oldest fetched ${formatDateTime(stats.oldestEntryAt)}.`
              }
            >
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatNumber(stats.cacheEntries)}
              </span>
              {stats.expiredEntries > 0 && (
                <Badge tone="unknown" small>
                  {formatNumber(stats.expiredEntries)} expired
                </Badge>
              )}
            </Row>

            <Row
              label="Video verdicts"
              hint="Each remembered check, so re-opening a run does not ask the provider again."
            >
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatNumber(stats.videoChecks)}
              </span>
            </Row>

            <Row label="Moderation log" hint="Actions SRCTools recorded on this machine.">
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatNumber(stats.historyEntries)}
              </span>
              <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                + {plural(stats.auditEntries, 'batch')}
              </span>
            </Row>
          </>
        )}
      </Card>

      <Card title="Cache maintenance" icon={<HardDrive size={13} />}>
        <div className="notice notice--info" style={{ marginBottom: 6 }}>
          <Info size={15} />
          <span>
            Everything below is safe: the cache is a copy of data Speedrun.com will hand over
            again. Clearing it costs API requests and time, never records.
          </span>
        </div>

        <Row
          label="Remove expired entries"
          hint="Drops rows past their expiry and reclaims the disk space."
        >
          <button type="button" className="btn btn--sm" onClick={() => void prune()} disabled={busy}>
            {busy ? <Spinner /> : <Timer size={13} />}
            Prune
          </button>
        </Row>

        <Row
          label="Refresh game data"
          hint="Drops cached games, categories, levels and variables. Use this when a game’s rules have changed on the site but SRCTools still shows the old text."
        >
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('categories', 'Categories')}
            disabled={busy}
          >
            Categories
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('game', 'Games')}
            disabled={busy}
          >
            Games
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('moderated_games', 'Moderated games')}
            disabled={busy}
          >
            My games
          </button>
        </Row>

        <Row label="Empty the whole cache" hint="Leaves history, statistics and settings intact.">
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => void clear()}
            disabled={busy}
          >
            <Trash2 size={13} />
            Empty cache
          </button>
        </Row>
      </Card>

      <Card title="What is stored where" icon={<Bell size={13} />}>
        <p className="setting-row__hint" style={{ lineHeight: 1.7 }}>
          Your Speedrun.com API key and any Twitch credentials live in the Windows Credential
          Manager, encrypted by Windows against your user account. They are never written to the
          database, never included in an export and never printed to a log. Everything else —
          cached API responses, your local moderation history and these settings — is in the SQLite
          file above and never leaves this machine. To clear the local history, use the{' '}
          <strong>Clear</strong> button on the History page; it is kept separate from the cache
          because it is the one thing here that cannot be fetched again.
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ about */

/**
 * Version and updates.
 *
 * The version is `startup.version`, which the backend reads from
 * `CARGO_PKG_VERSION` — there is one copy of it in the project and this is a
 * view of it, not a second declaration.
 *
 * The check reports all four of its outcomes, because a button that sometimes
 * does nothing visible is indistinguishable from a broken one: an update, being
 * up to date, GitHub being unreachable, and no repository configured yet.
 */
function AboutSection() {
  const t = useT();
  const startup = useSession((state) => state.startup);
  const result = useUpdate((state) => state.result);
  const checking = useUpdate((state) => state.checking);
  const error = useUpdate((state) => state.error);
  const checkNow = useUpdate((state) => state.checkNow);
  const reopen = useUpdate((state) => state.reopen);

  const check = async () => {
    const check = await checkNow();
    if (!check) return;
    if (!check.configured) {
      ui.info(t('update.notConfigured'), t('update.notConfigured.hint'));
    } else if (check.available) {
      // The dialog is already open — `checkNow` sets that. Nothing to add.
    } else {
      ui.success(t('update.upToDate'), t('update.upToDate.hint', { version: check.current }));
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={t('settings.about')} icon={<Info size={13} />}>
        <Row label={t('update.current')} hint={t('settings.about.versionHint')}>
          <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
            {startup?.version ?? '—'}
          </span>
        </Row>

        <Row
          label={t('update.check')}
          hint={
            error !== null
              ? error
              : result === null
                ? t('update.check.hint')
                : !result.configured
                  ? t('update.notConfigured.hint')
                  : result.available
                    ? t('update.available.lead')
                    : result.latest === null
                      ? t('update.noReleases')
                      : t('update.upToDate.hint', { version: result.current })
          }
        >
          {result?.available === true && (
            <button type="button" className="btn btn--sm btn--primary" onClick={reopen}>
              <Download size={13} />
              {t('update.download')}
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={() => void check()} disabled={checking}>
            {checking ? <Spinner /> : <RefreshCw size={13} />}
            {t('update.check')}
          </button>
        </Row>
      </Card>

      <Card title={t('settings.about.updates')} icon={<Download size={13} />}>
        <p className="setting-row__hint" style={{ lineHeight: 1.7 }}>
          {t('settings.about.updatesBody')}
        </p>
      </Card>
    </div>
  );
}
