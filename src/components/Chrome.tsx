/**
 * Top bar and status bar.
 *
 * The status bar carries the two facts a moderator needs continuously: whether
 * SRCTools is talking to Speedrun.com, and how much of the self-imposed request
 * budget is left. Both are read-only indicators; nothing here takes an action.
 */

import { useEffect } from 'react';
import { PanelLeft, RefreshCw, Search } from 'lucide-react';

import { formatRelative, formatNumber } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store/app';
import { useDashboard } from '../store/dashboard';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import { KeyHint, Spinner, Tooltip } from './ui';

export function TopBar({ onRefresh }: { onRefresh: () => void }) {
  const t = useT();
  const page = useApp((state) => state.page);
  const togglePalette = useApp((state) => state.togglePalette);
  const setLayout = useApp((state) => state.setLayout);
  const collapsed = useApp((state) => state.layout.sidebarCollapsed);

  const binding = useSession((state) => state.binding);
  const showText = useSession((state) => state.settings.sidebarText);
  const updateSetting = useSession((state) => state.updateSetting);
  const queueLoading = useQueue((state) => state.loading);
  const dashLoading = useDashboard((state) => state.loading);
  const busy = queueLoading || dashLoading;

  // Labels are hidden by either this control or the Settings preference, so the
  // button reads and acts on the combination. Expanding turns the preference
  // back on as well: otherwise pressing it while labels are off in Settings
  // would move nothing, and a button that does nothing is a broken button.
  const narrow = collapsed || !showText;
  const toggleSidebar = () => {
    if (!narrow) {
      setLayout({ sidebarCollapsed: true });
      return;
    }
    setLayout({ sidebarCollapsed: false });
    if (!showText) void updateSetting('sidebarText', true);
  };

  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        title={narrow ? t('nav.expand') : t('nav.collapse')}
        aria-label={narrow ? t('nav.expand') : t('nav.collapse')}
        onClick={toggleSidebar}
      >
        <PanelLeft size={14} />
      </button>

      <h1 className="topbar__title">{t(`nav.${page}`)}</h1>

      <div className="topbar__spacer" />

      <button
        type="button"
        className="topbar__search"
        onClick={() => togglePalette(true)}
        title={t('chrome.searchHint')}
      >
        <Search size={13} />
        <span>{t('chrome.searchPlaceholder')}</span>
        <KeyHint binding={binding('commandPalette')} />
      </button>

      <Tooltip label={t('chrome.refresh')} detail={t('chrome.refresh.hint')}>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          onClick={onRefresh}
          disabled={busy}
          aria-label={t('common.refresh')}
        >
          {busy ? <Spinner /> : <RefreshCw size={14} />}
        </button>
      </Tooltip>
    </header>
  );
}

export function StatusBar() {
  const t = useT();
  const profile = useSession((state) => state.profile);
  const hasApiKey = useSession((state) => state.hasApiKey);
  const rate = useSession((state) => state.rateLimit);
  const refreshRateLimit = useSession((state) => state.refreshRateLimit);
  const startup = useSession((state) => state.startup);

  const queueChecking = useQueue((state) => state.checking);
  const checkProgress = useQueue((state) => state.checkProgress);
  const fetchedAt = useQueue((state) => state.fetchedAt);
  const runCount = useQueue((state) => state.runs.length);
  const selected = useQueue((state) => state.selected.size);

  // The window is a sliding one on the backend, so a periodic read is the only
  // way the bar reflects requests draining out of it.
  useEffect(() => {
    const timer = window.setInterval(() => void refreshRateLimit(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshRateLimit]);

  const ratio = rate.capacity > 0 ? rate.used / rate.capacity : 0;
  const meterClass =
    ratio >= 0.9 ? 'meter__fill--danger' : ratio >= 0.65 ? 'meter__fill--warn' : '';

  const connection = !hasApiKey ? 'idle' : profile ? 'ok' : 'warn';
  const connectionLabel = !hasApiKey
    ? t('chrome.status.noKey')
    : profile
      ? t('chrome.status.connected', { name: profile.displayName })
      : t('chrome.status.unconfirmed');

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={connectionLabel}>
        <span className={`statusbar__dot statusbar__dot--${connection}`} />
        {connectionLabel}
      </span>

      {runCount > 0 && (
        <span className="statusbar__item">
          {t('chrome.status.loaded', { count: formatNumber(runCount) })}
          {selected > 0 &&
            ` · ${t('chrome.status.selected', { count: formatNumber(selected) })}`}
        </span>
      )}

      {queueChecking && (
        <span className="statusbar__item">
          <Spinner />
          {t('chrome.status.checking', {
            done: checkProgress.done,
            total: checkProgress.total,
          })}
        </span>
      )}

      <span className="statusbar__spacer" />

      {fetchedAt && (
        <span className="statusbar__item" title={t('chrome.status.fetched', { when: fetchedAt })}>
          {t('chrome.status.updated', { when: formatRelative(fetchedAt) })}
        </span>
      )}

      <Tooltip
        label={t('chrome.status.budget', { used: rate.used, capacity: rate.capacity })}
        detail={t('chrome.status.budget.hint')}
      >
        <span className="statusbar__item">
          <span className="meter">
            <span
              className={`meter__fill ${meterClass}`}
              style={{ width: `${Math.min(100, ratio * 100)}%` }}
            />
          </span>
          {rate.used}/{rate.capacity}
        </span>
      </Tooltip>

      {startup && (
        <span className="statusbar__item dim" title={t('chrome.status.database', { path: startup.databasePath })}>
          v{startup.version}
        </span>
      )}
    </footer>
  );
}
