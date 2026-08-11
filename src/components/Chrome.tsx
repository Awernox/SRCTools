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
import { useApp, PAGE_TITLES } from '../store/app';
import { useDashboard } from '../store/dashboard';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import { KeyHint, Spinner, Tooltip } from './ui';

export function TopBar({ onRefresh }: { onRefresh: () => void }) {
  const page = useApp((state) => state.page);
  const togglePalette = useApp((state) => state.togglePalette);
  const setLayout = useApp((state) => state.setLayout);
  const collapsed = useApp((state) => state.layout.sidebarCollapsed);

  const binding = useSession((state) => state.binding);
  const queueLoading = useQueue((state) => state.loading);
  const dashLoading = useDashboard((state) => state.loading);
  const busy = queueLoading || dashLoading;

  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
        onClick={() => setLayout({ sidebarCollapsed: !collapsed })}
      >
        <PanelLeft size={14} />
      </button>

      <h1 className="topbar__title">{PAGE_TITLES[page]}</h1>

      <div className="topbar__spacer" />

      <button
        type="button"
        className="topbar__search"
        onClick={() => togglePalette(true)}
        title="Search games, runs and commands"
      >
        <Search size={13} />
        <span>Search…</span>
        <KeyHint binding={binding('commandPalette')} />
      </button>

      <Tooltip label="Refresh this page" detail="Reloads from Speedrun.com.">
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          onClick={onRefresh}
          disabled={busy}
          aria-label="Refresh"
        >
          {busy ? <Spinner /> : <RefreshCw size={14} />}
        </button>
      </Tooltip>
    </header>
  );
}

export function StatusBar() {
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
    ? 'No API key'
    : profile
      ? `Connected as ${profile.displayName}`
      : 'Key stored, identity not confirmed';

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={connectionLabel}>
        <span className={`statusbar__dot statusbar__dot--${connection}`} />
        {connectionLabel}
      </span>

      {runCount > 0 && (
        <span className="statusbar__item">
          {formatNumber(runCount)} loaded
          {selected > 0 && ` · ${formatNumber(selected)} selected`}
        </span>
      )}

      {queueChecking && (
        <span className="statusbar__item">
          <Spinner />
          Checking videos {checkProgress.done}/{checkProgress.total}
        </span>
      )}

      <span className="statusbar__spacer" />

      {fetchedAt && (
        <span className="statusbar__item" title={`Queue fetched ${fetchedAt}`}>
          Updated {formatRelative(fetchedAt)}
        </span>
      )}

      <Tooltip
        label={`API budget: ${rate.used} of ${rate.capacity} requests used`}
        detail="SRCTools paces its own requests so Speedrun.com never rate-limits you. Adjust this in Settings."
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
        <span className="statusbar__item dim" title={`Database: ${startup.databasePath}`}>
          v{startup.version}
        </span>
      )}
    </footer>
  );
}
