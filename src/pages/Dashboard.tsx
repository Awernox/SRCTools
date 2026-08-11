/**
 * Dashboard: what is waiting, and what the moderator has already done.
 *
 * Every number here is either a count the backend computed from data it has, or
 * an explicit "not known". `pendingIsPartial` in particular means the queue was
 * truncated, so the figure is a floor — shown as `120+`, never as a total.
 */

import { useEffect } from 'react';
import {
  AlertTriangle,
  CheckCheck,
  Clock,
  Gamepad2,
  Inbox,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  VideoOff,
} from 'lucide-react';

import { Card, EmptyState, ErrorState, Skeleton, Spinner, Tooltip } from '../components/ui';
import { formatNumber, formatRelative, plural, runStatusLabel } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store/app';
import { useDashboard } from '../store/dashboard';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import type { RunSummary } from '../types';

export function Dashboard() {
  const t = useT();
  const summary = useDashboard((state) => state.summary);
  const loading = useDashboard((state) => state.loading);
  const error = useDashboard((state) => state.error);
  const load = useDashboard((state) => state.load);

  const hasApiKey = useSession((state) => state.hasApiKey);
  const profile = useSession((state) => state.profile);
  const go = useApp((state) => state.go);
  const openDetail = useApp((state) => state.openDetail);

  useEffect(() => {
    if (hasApiKey) void load();
  }, [hasApiKey, load]);

  if (!hasApiKey) {
    return (
      <div className="page">
        <EmptyState
          icon={<ShieldAlert size={26} />}
          title={t('dashboard.notConnected')}
          hint={t('dashboard.notConnectedHint')}
          action={
            <button type="button" className="btn btn--primary" onClick={() => go('settings')}>
              {t('dashboard.openSettings')}
            </button>
          }
        />
      </div>
    );
  }

  const openQueue = () => go('queue');

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">
            {profile
              ? t('dashboard.welcome', { name: profile.displayName })
              : t('dashboard.title')}
          </h2>
          <p className="page__subtitle">
            {summary
              ? t('dashboard.updated', { when: formatRelative(summary.fetchedAt) })
              : t('dashboard.loadingOverview')}
          </p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn btn--sm" onClick={() => void load(true)} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={() => void load(true)} />}

      {!error && !summary && loading && (
        <div className="grid-cards">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <div className="stat-card" key={n}>
              <Skeleton width={90} height={10} />
              <Skeleton width={54} height={26} />
              <Skeleton width={120} height={9} />
            </div>
          ))}
        </div>
      )}

      {summary && (
        <>
          {summary.warnings.length > 0 && (
            <div className="col" style={{ marginBottom: 16 }}>
              {summary.warnings.map((warning) => (
                <div className="notice notice--unknown" key={warning}>
                  <AlertTriangle size={15} />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid-cards">
            <StatCard
              label={t('dashboard.pending')}
              icon={<Inbox size={12} />}
              value={
                summary.pendingIsPartial
                  ? `${formatNumber(summary.pendingCount)}+`
                  : formatNumber(summary.pendingCount)
              }
              sub={
                summary.pendingIsPartial
                  ? t('dashboard.pendingPartial')
                  : t('dashboard.pendingSub')
              }
              onClick={openQueue}
            />
            <StatCard
              label={t('dashboard.oldest')}
              icon={<Clock size={12} />}
              value={
                summary.oldestPendingDays === null
                  ? '—'
                  : plural(summary.oldestPendingDays, 'day')
              }
              sub={
                summary.oldestPendingDays === null
                  ? t('dashboard.oldestNone')
                  : t('dashboard.oldestSub')
              }
              onClick={openQueue}
            />
            <StatCard
              label={t('dashboard.videoProblems')}
              icon={<VideoOff size={12} />}
              value={formatNumber(summary.runsWithVideoProblems)}
              sub={t('dashboard.videoProblemsSub')}
              onClick={openQueue}
            />
            <StatCard
              label={t('dashboard.needsReview')}
              icon={<ListChecks size={12} />}
              value={formatNumber(summary.runsNeedingReview)}
              sub={t('dashboard.needsReviewSub')}
              onClick={openQueue}
            />
            <StatCard
              label={t('dashboard.actionsToday')}
              icon={<CheckCheck size={12} />}
              value={formatNumber(summary.actionsToday)}
              sub={t('dashboard.actionsWeekSub', {
                count: formatNumber(summary.actionsThisWeek),
              })}
              onClick={() => go('history')}
            />
            <StatCard
              label={t('dashboard.games')}
              icon={<Gamepad2 size={12} />}
              value={formatNumber(summary.gamesModerated)}
              sub={t('dashboard.gamesSub')}
              onClick={() => go('games')}
            />
          </div>

          <Card
            title={t('dashboard.recent')}
            icon={<Inbox size={13} />}
            style={{ marginTop: 16 }}
            actions={
              <button type="button" className="btn btn--ghost btn--sm" onClick={openQueue}>
                {t('dashboard.openQueue')}
              </button>
            }
          >
            {summary.recentRuns.length === 0 ? (
              <EmptyState
                title={t('dashboard.nothingWaiting')}
                hint={t('dashboard.nothingWaitingHint')}
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('queue.col.game')}</th>
                    <th>{t('queue.col.category')}</th>
                    <th>{t('queue.col.runner')}</th>
                    <th style={{ textAlign: 'right' }}>{t('queue.col.time')}</th>
                    <th>{t('queue.col.submitted')}</th>
                    <th>{t('queue.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recentRuns.map((run) => (
                    <RecentRow
                      key={run.id}
                      run={run}
                      onOpen={() => {
                        go('queue');
                        // The queue may not hold this run yet; the detail panel
                        // fetches by id, so opening it directly is safe.
                        useQueue.getState().focusRun(run.id);
                        openDetail(run.id);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="stat-card__label">
        {icon}
        {label}
      </span>
      <span className="stat-card__value">{value}</span>
      <span className="stat-card__sub">{sub}</span>
    </>
  );

  if (!onClick) return <div className="stat-card">{content}</div>;
  return (
    <button type="button" className="stat-card" data-clickable="true" onClick={onClick}>
      {content}
    </button>
  );
}

function RecentRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  const t = useT();
  return (
    <tr data-row-action="true" onClick={onOpen}>
      <td>{run.gameName ?? <span className="absent">—</span>}</td>
      <td>
        {run.categoryName ?? <span className="absent">—</span>}
        {run.levelName && <span className="dim"> · {run.levelName}</span>}
      </td>
      <td>{run.playerLabel}</td>
      <td style={{ textAlign: 'right' }} className="num">
        {run.primaryDisplay ?? '—'}
      </td>
      <td>
        <Tooltip label={run.submitted ?? t('queue.noSubmitDate')}>
          <span>{formatRelative(run.submitted)}</span>
        </Tooltip>
      </td>
      <td>{runStatusLabel(run.status)}</td>
    </tr>
  );
}
