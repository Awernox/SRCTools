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
  Switch,
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
import { useT, LANGUAGES, LANGUAGE_NAMES, type Language, type Translate, type TranslationKey } from '../i18n';
import { auth, errorText, prefs, sound as soundIpc } from '../ipc';
import { copyToClipboard, openExternal } from '../open';
import { SHORTCUT_DEFINITIONS, SHORTCUT_GROUPS, eventBinding, type ShortcutDefinition } from '../shortcuts';
import { dropCustom, loadCustomSound, playNotificationSound } from '../sound';
import { useLivePresence } from '../hooks/usePresence';
import { useApp } from '../store/app';
import { useDiscord, useWebhook } from '../store/integrations';
import { QUEUE_COLUMNS } from '../store/queue';
import {
  useSession,
  type Density,
  type Settings as SettingsValues,
  type SidebarPosition,
  type ThemeName,
} from '../store/session';
import { ACCENT_COLOURS, ACCENT_NAMES, DENSITIES, THEMES } from '../theme';
import { ui } from '../store/ui';
import { useUpdate } from '../store/update';
import { useWatcher, watcherWanted } from '../store/watcher';
import type { CacheStats, RejectionTemplate } from '../types';
import { CHECK_INTERVALS, isCheckInterval } from '../watcher/intervals';
import { displayTemplate } from '../templates';

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
const PROJECT_URL = 'https://github.com/Awernox/SRCTools';

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
    <div className="page settings-page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">{t('settings.title')}</h2>
          <p className="page__subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { value: 'account', label: t('settings.tab.account') },
          { value: 'interface', label: t('settings.tab.appearance') },
          { value: 'moderation', label: t('settings.tab.moderation') },
          { value: 'notifications', label: t('settings.tab.notifications') },
          { value: 'discord', label: t('settings.tab.discord') },
          { value: 'templates', label: t('settings.tab.templates') },
          { value: 'keyboard', label: t('settings.tab.keyboard') },
          { value: 'data', label: t('settings.tab.data') },
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
      <Switch checked={value} onChange={(next) => void update(setting, next)} label={label} />
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

  const t = useT();

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
      setKeyError(t('settings.account.pasteFirst'));
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
      ui.success(
        t('settings.account.keySaved'),
        t('settings.account.signedInAs', { name: next.displayName }),
      );
    } catch (err) {
      setKeyError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const ok = await ui.confirm({
      title: t('settings.account.removeTitle'),
      message: t('settings.account.removeMessage'),
      danger: true,
      confirmLabel: t('settings.account.removeKey'),
    });
    if (!ok) return;
    try {
      await auth.clearApiKey();
      setProfile(null);
      await refreshConnection();
      ui.success(t('settings.account.keyRemoved'));
    } catch (err) {
      ui.error(t('settings.account.removeFailed'), err);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await refreshConnection();
      const status = useSession.getState().connection;
      if (status?.connected === true) ui.success(t('settings.account.connected'), status.message);
      else
        ui.warning(
          t('settings.account.notConnected'),
          status?.message ?? t('settings.account.noAnswer'),
        );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={t('settings.account.connectionTitle')} icon={<KeyRound size={13} />}>
        <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 4 }}>
          {connection === null ? (
            <Badge tone="unknown" small dot>
              {t('settings.account.checking')}
            </Badge>
          ) : connection.connected ? (
            <Badge tone="ok" small dot>
              {t('settings.account.connected')}
            </Badge>
          ) : (
            <Badge tone={hasApiKey ? 'danger' : 'unknown'} small dot>
              {hasApiKey ? t('settings.account.notWorking') : t('settings.account.noKey')}
            </Badge>
          )}
          <span className="dim" style={{ fontSize: 'var(--text-xs)', flex: 1, minWidth: 0 }}>
            {connection?.message ?? t('settings.account.asking')}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void test()} disabled={testing}>
            {testing ? <Spinner /> : connection?.connected === true ? <Wifi size={13} /> : <WifiOff size={13} />}
            {t('settings.account.test')}
          </button>
        </div>

        <Row
          label={t('settings.account.signedIn')}
          hint={
            profile === null
              ? t('settings.account.noAccount')
              : profile.signupDate === null
                ? t('settings.account.fromKey')
                : t('settings.account.joined', { date: formatDate(profile.signupDate) })
          }
        >
          {profile === null ? (
            <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>
              {t('settings.account.nobody')}
            </span>
          ) : (
            <>
              <span style={{ fontSize: 'var(--text-sm)' }}>{profile.displayName}</span>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                title={t('settings.account.openProfile')}
                aria-label={t('settings.account.openProfile')}
                onClick={() => void openExternal(profile.weblink)}
                disabled={profile.weblink === null}
              >
                <ExternalLink size={13} />
              </button>
            </>
          )}
        </Row>

        <Row label={t('settings.account.stored')} hint={t('settings.account.storedHint')}>
          <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
            {connection?.maskedKey ?? ABSENT}
          </span>
          {hasApiKey && (
            <button type="button" className="btn btn--sm btn--danger" onClick={() => void disconnect()}>
              <Trash2 size={13} />
              {t('common.remove')}
            </button>
          )}
        </Row>

        <Row
          label={hasApiKey ? t('settings.account.replace') : t('settings.account.add')}
          hint={
            <>
              {t('settings.account.pasteHint')}{' '}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ display: 'inline-flex', height: 18, padding: '0 3px' }}
                onClick={() => void openExternal(KEY_PAGE)}
              >
                {t('settings.account.getKey')} <ExternalLink size={10} />
              </button>
            </>
          }
        >
          <input
            className="input"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.account.keyPlaceholder')}
            aria-label={t('settings.account.keyAria')}
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
            {t('common.save')}
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
  const t = useT();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (clientId.trim() === '' || clientSecret.trim() === '') {
      setError(t('settings.twitch.bothRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.setTwitchCredentials(clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      await onChanged();
      ui.success(t('settings.twitch.saved'), t('settings.twitch.savedHint'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const ok = await ui.confirm({
      title: t('settings.twitch.removeTitle'),
      message: t('settings.twitch.removeMessage'),
      confirmLabel: t('common.remove'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await auth.clearTwitchCredentials();
      await onChanged();
      ui.success(t('settings.twitch.removed'));
    } catch (err) {
      ui.error(t('settings.twitch.removeFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('settings.account.twitch')}
      icon={<Video size={13} />}
      actions={
        <Badge tone={configured ? 'ok' : 'unknown'} small dot>
          {configured ? t('settings.webhook.configured') : t('settings.webhook.notConfigured')}
        </Badge>
      }
    >
      <div className="notice notice--info" style={{ marginBottom: 6 }}>
        <Info size={15} />
        <span>{t('settings.twitch.intro')}</span>
      </div>

      <Row
        label={t('settings.twitch.clientId')}
        hint={
          <>
            {t('settings.twitch.clientIdHint')}{' '}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ display: 'inline-flex', height: 18, padding: '0 3px' }}
              onClick={() => void openExternal(TWITCH_CONSOLE)}
            >
              {t('settings.twitch.console')} <ExternalLink size={10} />
            </button>
          </>
        }
      >
        <input
          className="input"
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            configured ? t('settings.twitch.storedPlaceholder') : t('settings.twitch.clientId')
          }
          aria-label={t('settings.twitch.clientIdAria')}
          onChange={(event) => {
            setClientId(event.currentTarget.value);
            setError(null);
          }}
          style={{ width: 220 }}
        />
      </Row>

      <Row label={t('settings.twitch.clientSecret')} hint={t('settings.twitch.clientSecretHint')}>
        <input
          className="input"
          type="password"
          value={clientSecret}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            configured ? t('settings.twitch.storedPlaceholder') : t('settings.twitch.clientSecret')
          }
          aria-label={t('settings.twitch.clientSecretAria')}
          onChange={(event) => {
            setClientSecret(event.currentTarget.value);
            setError(null);
          }}
          style={{ width: 220 }}
        />
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : <ShieldCheck size={13} />}
          {t('common.save')}
        </button>
      </Row>

      {configured && (
        <Row label={t('settings.twitch.remove')} hint={t('settings.twitch.removeHint')}>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void clear()} disabled={busy}>
            <Trash2 size={13} />
            {t('common.remove')}
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
  const sidebarPosition = useSession((state) => state.settings.sidebarPosition);
  const sidebarCollapsed = useApp((state) => state.layout.sidebarCollapsed);
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
   *
   * Switching the labels back on is the exception, and it has to be: the
   * collapse control in the top bar hides them too, and while it is engaged this
   * checkbox would tick with nothing appearing in the sidebar. A setting that
   * reports success and changes nothing is the worse outcome, so turning labels
   * on expands the sidebar as well.
   */
  const setSidebar = (which: 'sidebarIcons' | 'sidebarText', next: boolean) => {
    const other = which === 'sidebarIcons' ? sidebarText : sidebarIcons;
    if (!next && !other) {
      ui.warning(t('settings.sidebar.bothOff'));
      return;
    }
    if (which === 'sidebarText' && next) {
      useApp.getState().setLayout({ sidebarCollapsed: false });
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
              checked={sidebarText && !sidebarCollapsed}
              label={t('settings.sidebar.text')}
              onChange={(next) => setSidebar('sidebarText', next)}
            />
          </div>
        </Row>

        <Row label={t('settings.sidebar.position')} hint={t('settings.sidebar.positionHint')}>
          <Segmented<SidebarPosition>
            value={sidebarPosition}
            onChange={(next) => void update('sidebarPosition', next)}
            options={[
              { value: 'left', label: t('settings.sidebar.left') },
              { value: 'right', label: t('settings.sidebar.right') },
            ]}
          />
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
              label={t(column.labelKey)}
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
  const t = useT();

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={t('settings.moderation.confirmations')} icon={<ShieldCheck size={13} />}>
        <ToggleRow
          setting="confirmVerify"
          label={t('settings.moderation.confirmVerify')}
          hint={t('settings.moderation.confirmVerifyHint')}
        />
      </Card>

      <Card title={t('settings.moderation.queue')} icon={<Layers size={13} />}>
        <ToggleRow
          setting="onlyMyGames"
          label={t('settings.moderation.onlyMyGames')}
          hint={t('settings.moderation.onlyMyGamesHint')}
        />
        <NumberRow
          setting="queueLimit"
          label={t('settings.moderation.queueLimit')}
          hint={t('settings.moderation.queueLimitHint')}
          min={25}
          max={2000}
          unit={t('settings.unit.runs')}
        />
        <ToggleRow
          setting="autoCheckVideos"
          label={t('settings.moderation.autoCheckVideos')}
          hint={t('settings.moderation.autoCheckVideosHint')}
        />
      </Card>

      <Card title={t('queue.fastReview')} icon={<Zap size={13} />}>
        <NumberRow
          setting="fastReviewDelay"
          label={t('settings.moderation.fastReviewDelay')}
          hint={t('settings.moderation.fastReviewDelayHint')}
          min={0}
          max={10}
          unit={t('settings.unit.seconds')}
        />
      </Card>

      <Card title={t('settings.moderation.budget')} icon={<Gauge size={13} />}>
        <NumberRow
          setting="rateLimit"
          label={t('settings.moderation.rateLimit')}
          hint={t('settings.moderation.rateLimitHint')}
          min={10}
          max={100}
          unit={t('settings.unit.reqPerMin')}
        />
        <RateLimitRow />
      </Card>
    </div>
  );
}

/** Live view of the budget, so the number above has visible consequences. */
function RateLimitRow() {
  const t = useT();
  const rateLimit = useSession((state) => state.rateLimit);
  const refresh = useSession((state) => state.refreshRateLimit);

  return (
    <Row label={t('settings.moderation.used')} hint={t('settings.moderation.usedHint')}>
      <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
        {formatNumber(rateLimit.used)} / {formatNumber(rateLimit.capacity)}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--ghost btn--icon"
        title={t('common.refresh')}
        aria-label={t('settings.moderation.refreshBudget')}
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
  const settings = useSession((state) => state.settings);
  const webhookReady = useWebhook((state) => state.status.configured);
  const hasApiKey = useSession((state) => state.hasApiKey);

  const running = useWatcher((state) => state.running);
  const failures = useWatcher((state) => state.failures);
  const delay = useWatcher((state) => state.delay);
  const lastCheck = useWatcher((state) => state.lastCheck);
  const lastError = useWatcher((state) => state.lastError);

  let state: string;
  // Asked of the same predicate the watcher itself uses, so this line cannot
  // claim the loop is off while it is polling for the webhook.
  if (!watcherWanted(settings, webhookReady)) state = t('settings.notify.watcherOff');
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
        <Switch
          checked={enabled}
          disabled={!status.configured}
          label={t('settings.webhook.enable')}
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
        <Switch
          checked={value}
          disabled={!enabled}
          label={label}
          onChange={(next) => void update(setting, next)}
        />
      </div>
    </div>
  );
}

/**
 * Which games the webhook posts about.
 *
 * Every switch means the same thing in both directions: green posts, gray does
 * not. That is why "all games" is its own switch rather than an empty
 * selection — with an empty list standing for *everything*, a column of gray
 * switches would say the opposite of what it did.
 *
 * The list is always visible when the filter is on. A filter that matches
 * nothing looks exactly like a broken webhook, so the state that causes it is
 * shown rather than folded away behind a button.
 */
function WebhookGamesRow() {
  const t = useT();
  const all = useSession((state) => state.settings.webhookAllGames);
  const selected = useSession((state) => state.settings.webhookGames);
  const enabled = useSession((state) => state.settings.webhookEnabled);
  const games = useSession((state) => state.games);
  const update = useSession((state) => state.updateSetting);

  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((g) => g !== id)
      : [...selected, id];
    void update('webhookGames', next);
  };

  const chosen = games.filter((game) => selected.includes(game.id));

  return (
    <>
      <div className="setting-row__label" style={{ marginTop: 12, marginBottom: 4 }}>
        {t('settings.webhook.games')}
      </div>

      <Row label={t('settings.webhook.games.allLabel')} hint={t('settings.webhook.games.all')}>
        <Switch
          checked={all}
          disabled={!enabled}
          label={t('settings.webhook.games.allLabel')}
          onChange={(next) => void update('webhookAllGames', next)}
        />
      </Row>

      {!all && (
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {games.length === 0 ? (
            <div className="setting-row__hint">{t('settings.webhook.games.none')}</div>
          ) : (
            games.map((game) => (
              <div className="setting-row" key={game.id}>
                <div className="setting-row__text">
                  <div className="setting-row__label">{game.name}</div>
                </div>
                <div className="setting-row__control">
                  <Switch
                    checked={selected.includes(game.id)}
                    disabled={!enabled}
                    label={game.name}
                    onChange={() => toggle(game.id)}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Nothing switched on is a webhook that posts nothing. Said plainly,
          because the symptom is silence and silence has many other causes. */}
      {!all && (
        <div
          className={chosen.length === 0 ? 'notice notice--warn' : 'setting-row__hint'}
          style={{ marginTop: 8 }}
        >
          {chosen.length === 0 ? (
            <>
              <ShieldAlert size={15} />
              <span>{t('settings.webhook.games.empty')}</span>
            </>
          ) : (
            t('settings.webhook.games.only', {
              games: chosen.map((game) => game.name).join(', '),
            })
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
  const t = useT();
  const templates = useSession((state) => state.templates);
  const refresh = useSession((state) => state.refreshTemplates);

  const [editing, setEditing] = useState<RejectionTemplate | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (template: RejectionTemplate) => {
    const ok = await ui.confirm({
      title: t('settings.templates.deleteTitle', { name: template.label }),
      message: t('settings.templates.deleteMessage'),
      danger: true,
      confirmLabel: t('settings.templates.deleteConfirm'),
    });
    if (!ok) return;
    try {
      await prefs.deleteTemplate(template.id);
      await refresh();
      ui.success(t('settings.templates.deleted'));
    } catch (err) {
      ui.error(t('settings.templates.deleteFailed'), err);
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
      ui.error(t('settings.templates.reorderFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await prefs.restoreTemplates();
      await refresh();
      ui.success(t('settings.templates.restored'), t('settings.templates.restoredHint'));
    } catch (err) {
      ui.error(t('settings.templates.restoreFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title={t('settings.templates.title')}
        icon={<Pencil size={13} />}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn--sm" onClick={() => void restore()} disabled={busy}>
              <Undo2 size={13} />
              {t('settings.templates.restore')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>
              <Plus size={13} />
              {t('settings.templates.new')}
            </button>
          </div>
        }
      >
        <p className="setting-row__hint" style={{ marginBottom: 12 }}>
          {t('settings.templates.intro')}
        </p>

        {templates.length === 0 ? (
          <EmptyState
            icon={<Pencil size={24} />}
            title={t('settings.templates.empty')}
            hint={t('settings.templates.emptyHint')}
            action={
              <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
                <Plus size={13} />
                {t('settings.templates.new')}
              </button>
            }
          />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {templates.map((stored, index) => {
              const template = displayTemplate(stored, t);
              return (
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
                        {t('settings.templates.builtin')}
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
                    title={t('settings.templates.moveUp')}
                    aria-label={t('settings.templates.moveUp')}
                    disabled={index === 0 || busy}
                    onClick={() => void move(index, -1)}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title={t('settings.templates.moveDown')}
                    aria-label={t('settings.templates.moveDown')}
                    disabled={index === templates.length - 1 || busy}
                    onClick={() => void move(index, 1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title={t('common.edit')}
                    aria-label={t('settings.templates.edit')}
                    onClick={() => setEditing(template)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title={t('settings.templates.copy')}
                    aria-label={t('settings.templates.copy')}
                    onClick={() => void copyToClipboard(template.body, t('settings.templates.copied'))}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    title={t('common.delete')}
                    aria-label={t('settings.templates.delete')}
                    onClick={() => void remove(template)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                </div>
              );
            })}
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
  const t = useT();
  const [label, setLabel] = useState(template?.label ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (label.trim() === '' || body.trim() === '') {
      setError(t('settings.templates.needBoth'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await prefs.saveTemplate(label.trim(), body.trim(), template?.id ?? null);
      ui.success(
        template === null ? t('settings.templates.added') : t('settings.templates.saved'),
      );
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={template === null ? t('settings.templates.newTitle') : t('settings.templates.editTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner /> : null}
            {t('settings.templates.saveButton')}
          </button>
        </>
      }
    >
      <label className="label" htmlFor="template-label">
        {t('settings.templates.name')}
      </label>
      <input
        id="template-label"
        className="input"
        value={label}
        placeholder={t('settings.templates.namePlaceholder')}
        onChange={(event) => {
          setLabel(event.currentTarget.value);
          setError(null);
        }}
        style={{ width: '100%', marginBottom: 12 }}
      />

      <label className="label" htmlFor="template-body">
        {t('settings.templates.body')}
      </label>
      <textarea
        id="template-body"
        className="textarea"
        rows={5}
        value={body}
        placeholder={t('settings.templates.bodyPlaceholder')}
        onChange={(event) => {
          setBody(event.currentTarget.value);
          setError(null);
        }}
        style={{ width: '100%' }}
      />
      <p className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 8, lineHeight: 1.55 }}>
        {t('settings.templates.bodyHint')}
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
  const t = useT();
  const shortcuts = useSession((state) => state.shortcuts);
  const setShortcut = useSession((state) => state.setShortcut);
  const resetShortcuts = useSession((state) => state.resetShortcuts);

  const [capturing, setCapturing] = useState<ShortcutDefinition | null>(null);

  const reset = async () => {
    const ok = await ui.confirm({
      title: t('settings.keyboard.resetTitle'),
      message: t('settings.keyboard.resetMessage'),
      confirmLabel: t('settings.keyboard.resetConfirm'),
    });
    if (!ok) return;
    try {
      await resetShortcuts();
      ui.success(t('settings.keyboard.reset'));
    } catch (err) {
      ui.error(t('settings.keyboard.resetFailed'), err);
    }
  };

  return (
    <>
      <div className="notice notice--info" style={{ marginBottom: 16 }}>
        <Info size={15} />
        <span>{t('settings.keyboard.intro')}</span>
      </div>

      <div className="col" style={{ gap: 16 }}>
        {SHORTCUT_GROUPS.map((group) => (
          <Card
            key={group}
            title={t(`settings.keyboard.group.${group}`)}
            icon={<Keyboard size={13} />}
            actions={
              group === 'application' ? (
                <button type="button" className="btn btn--sm" onClick={() => void reset()}>
                  <RotateCcw size={13} />
                  {t('settings.keyboard.resetAll')}
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
                    label={t(definition.labelKey)}
                    hint={t(definition.descriptionKey)}
                  >
                    {custom && (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost btn--icon"
                        title={t('settings.keyboard.restoreDefault', {
                          binding: definition.binding,
                        })}
                        aria-label={t('settings.keyboard.restoreDefaultAria')}
                        onClick={() => void setShortcut(definition.action, '')}
                      >
                        <Undo2 size={13} />
                      </button>
                    )}
                    <KeyHint binding={binding} />
                    {definition.fixed === true ? (
                      <span
                        className="dim"
                        title={t('settings.keyboard.fixedHint')}
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
                        {t('settings.keyboard.change')}
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
              ui.error(t('settings.keyboard.saveFailed'), err);
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
  const t = useT();
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
      title={t('settings.keyboard.rebindTitle', { action: t(definition.labelKey) })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={captured === null}
            onClick={() => {
              if (captured !== null) onCapture(captured);
            }}
          >
            {t('settings.keyboard.useKey')}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
        {t('settings.keyboard.captureHint')}
      </p>

      <div
        className="row"
        style={{ gap: 10, alignItems: 'center', justifyContent: 'center', padding: '18px 0' }}
      >
        {captured === null ? (
          <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            {t('settings.keyboard.waiting')} <KeyHint binding={current} />
          </span>
        ) : (
          <KeyHint binding={captured} />
        )}
      </div>

      {conflict !== null && (
        <div className="notice notice--warn">
          <TriangleAlert size={15} />
          <span>
            {t('settings.keyboard.conflictBody', { other: t(conflict.labelKey) })}
          </span>
        </div>
      )}

      <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.55, marginTop: 10 }}>
        {t('settings.keyboard.sequenceHint')}
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------------------- data */

function DataSection() {
  const t = useT();
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
        removed === 0
          ? t('settings.data.nothingExpired')
          : t('settings.data.pruned', { entries: plural(removed, 'expiredEntry') }),
      );
      setReload((n) => n + 1);
    } catch (err) {
      ui.error(t('settings.data.pruneFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const ok = await ui.confirm({
      title: t('settings.data.clearTitle'),
      message: t('settings.data.clearMessage'),
      confirmLabel: t('settings.data.clearConfirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const removed = await prefs.cacheClear();
      ui.success(
        t('settings.data.cleared'),
        t('settings.data.clearedHint', { entries: plural(removed, 'entry') }),
      );
      setReload((n) => n + 1);
    } catch (err) {
      ui.error(t('settings.data.clearFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Drops one kind of cached row.
   *
   * The label arrives as a catalogue key rather than finished text so the toast
   * can name what was dropped in the reader's language.
   */
  const invalidate = async (kind: string, labelKey: TranslationKey) => {
    setBusy(true);
    try {
      const removed = await prefs.cacheInvalidate(kind);
      ui.success(
        t('settings.data.refreshed', { what: t(labelKey) }),
        t('settings.data.refreshedHint', { entries: plural(removed, 'entry') }),
      );
      setReload((n) => n + 1);
    } catch (err) {
      ui.error(t('settings.data.refreshFailed', { what: t(labelKey) }), err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card
        title={t('settings.data.dbTitle')}
        icon={<Database size={13} />}
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setReload((n) => n + 1)}
            disabled={loading}
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            {t('common.refresh')}
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
            <Row label={t('settings.data.where')} hint={t('settings.data.whereHint')}>
              <span className="mono truncate" style={{ fontSize: 'var(--text-xs)', maxWidth: 260 }}>
                {stats.databasePath}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                title={t('settings.data.copyPath')}
                aria-label={t('settings.data.copyPath')}
                onClick={() =>
                  void copyToClipboard(stats.databasePath, t('settings.data.pathCopied'))
                }
              >
                <Copy size={13} />
              </button>
            </Row>

            <Row label={t('settings.data.size')} hint={t('settings.data.sizeHint')}>
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatBytes(stats.databaseBytes)}
              </span>
            </Row>

            <Row
              label={t('settings.data.cacheEntries')}
              hint={
                stats.oldestEntryAt === null
                  ? t('settings.data.nothingCached')
                  : t('settings.data.oldest', { when: formatDateTime(stats.oldestEntryAt) })
              }
            >
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatNumber(stats.cacheEntries)}
              </span>
              {stats.expiredEntries > 0 && (
                <Badge tone="unknown" small>
                  {t('settings.data.expired', { count: formatNumber(stats.expiredEntries) })}
                </Badge>
              )}
            </Row>

            <Row label={t('settings.data.videoChecks')} hint={t('settings.data.videoChecksHint')}>
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {formatNumber(stats.videoChecks)}
              </span>
            </Row>

            <Row label={t('settings.data.log')} hint={t('settings.data.logHint')}>
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

      <Card title={t('settings.data.maintenance')} icon={<HardDrive size={13} />}>
        <div className="notice notice--info" style={{ marginBottom: 6 }}>
          <Info size={15} />
          <span>{t('settings.data.maintenanceHint')}</span>
        </div>

        <Row label={t('settings.data.prune')} hint={t('settings.data.pruneHint')}>
          <button type="button" className="btn btn--sm" onClick={() => void prune()} disabled={busy}>
            {busy ? <Spinner /> : <Timer size={13} />}
            {t('settings.data.pruneButton')}
          </button>
        </Row>

        <Row
          label={t('settings.data.refreshGameData')}
          hint={t('settings.data.refreshGameDataHint')}
        >
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('categories', 'queue.col.category')}
            disabled={busy}
          >
            {t('settings.data.categories')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('game', 'settings.webhook.games')}
            disabled={busy}
          >
            {t('settings.webhook.games')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void invalidate('moderated_games', 'settings.data.moderatedGames')}
            disabled={busy}
          >
            {t('settings.data.myGames')}
          </button>
        </Row>

        <Row label={t('settings.data.clearCache')} hint={t('settings.data.clearCacheHint')}>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => void clear()}
            disabled={busy}
          >
            <Trash2 size={13} />
            {t('settings.data.clearConfirm')}
          </button>
        </Row>
      </Card>

      <Card title={t('settings.data.storedWhere')} icon={<Bell size={13} />}>
        <p className="setting-row__hint" style={{ lineHeight: 1.7 }}>
          {t('settings.data.storedWhereBody')}
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
  const result = useUpdate((state) => state.result);
  const checking = useUpdate((state) => state.checking);
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
        <Row label={t('update.current')}>
          <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
            1.1.0
          </span>
        </Row>

        <Row label={t('settings.about.developer')}>
          <span>Short</span>
        </Row>

        <Row label={t('settings.about.source')} hint={t('settings.about.sourceHint')}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void openExternal(PROJECT_URL)}
          >
            <ExternalLink size={13} />
            {t('settings.about.openGithub')}
          </button>
        </Row>

        <Row
          label={t('update.check')}
          hint={t('update.check.hint')}
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
