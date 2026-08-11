/**
 * Statistics: what this moderator has done, as recorded by SRCTools.
 *
 * Every figure comes from the local log, never from Speedrun.com — the site has
 * no per-moderator activity endpoint, so there is nothing to reconcile against.
 * The page states that plainly rather than presenting the numbers as a complete
 * moderation record, which they are not: work done in a browser or on another
 * machine was never seen by this application.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Ban,
  CalendarDays,
  ChartColumn,
  Check,
  Download,
  Gamepad2,
  Info,
  ListChecks,
  RefreshCw,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';

import { Card, EmptyState, ErrorState, Segmented, Skeleton, Spinner } from '../components/ui';
import { formatDate, formatDateTime, formatNumber, formatPercent, plural } from '../format';
import { activeLanguage, useT, t as translate, type TranslationKey } from '../i18n';
import { errorText, records } from '../ipc';
import { saveExport } from '../open';
import { useApp } from '../store/app';
import { ui } from '../store/ui';
import type { DailyCount, ModerationStats } from '../types';

/** How many day columns the chart draws before it starts dropping the oldest. */
const MAX_COLUMNS = 90;

type RangeKey = '7' | '30' | '90' | '365' | '0';

const RANGE_KEYS = ['7', '30', '90', '365', '0'] as const satisfies readonly RangeKey[];

export function Stats() {
  const t = useT();
  const openGame = useApp((state) => state.openGame);

  const [range, setRange] = useState<RangeKey>('30');
  const [stats, setStats] = useState<ModerationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reload, setReload] = useState(0);

  const days = Number(range);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void records
      .stats(days)
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
  }, [days, reload]);

  const columns = useMemo(
    () => (stats ? fillDays(stats.perDay, days) : []),
    [stats, days],
  );
  const shown = columns.length > MAX_COLUMNS ? columns.slice(-MAX_COLUMNS) : columns;
  const truncated = columns.length > MAX_COLUMNS;

  const rangeLabel = t(`stats.range.${range}` as TranslationKey);

  const exportReport = async () => {
    setExporting(true);
    try {
      await saveExport(await records.exportStats(days));
    } catch (err) {
      ui.error(t('stats.exportFailed'), err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">{t('stats.title')}</h2>
          <p className="page__subtitle">{t('stats.subtitle', { range: rangeLabel })}</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setReload((n) => n + 1)}
            disabled={loading}
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void exportReport()}
            disabled={exporting || loading}
          >
            {exporting ? <Spinner /> : <Download size={13} />}
            {t('stats.export')}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <span className="label">{t('stats.period')}</span>
        <Segmented<RangeKey>
          value={range}
          onChange={setRange}
          options={RANGE_KEYS.map((key) => ({
            value: key,
            label: t(`stats.range.${key}.short` as TranslationKey),
          }))}
        />
        <div className="toolbar__spacer" />
        {stats !== null && stats.lastActionAt !== null && (
          <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
            {t('stats.lastAction', { when: formatDateTime(stats.lastActionAt) })}
          </span>
        )}
      </div>

      <div className="notice notice--info" style={{ marginBottom: 16 }}>
        <Info size={15} />
        <span>{t('stats.localOnly')}</span>
      </div>

      {error !== null && <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />}

      {error === null && loading && (
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

      {error === null && !loading && stats !== null && stats.totalActions === 0 && (
        <EmptyState
          icon={<ChartColumn size={26} />}
          title={t('stats.emptyRange', { range: rangeLabel })}
          hint={t('stats.emptyRangeHint')}
        />
      )}

      {error === null && !loading && stats !== null && stats.totalActions > 0 && (
        <>
          <div className="grid-cards">
            <Figure
              label={t('stats.totalActions')}
              icon={<Activity size={12} />}
              value={formatNumber(stats.totalActions)}
              sub={t('stats.runsTouched', { count: plural(stats.distinctRuns, 'run') })}
            />
            <Figure
              label={t('stats.verified')}
              icon={<Check size={12} />}
              value={formatNumber(stats.verified)}
              sub={share(stats.verified, stats.totalActions)}
            />
            <Figure
              label={t('stats.rejected')}
              icon={<Ban size={12} />}
              value={formatNumber(stats.rejected)}
              sub={share(stats.rejected, stats.totalActions)}
            />
            <Figure
              label={t('stats.deleted')}
              icon={<Trash2 size={12} />}
              value={formatNumber(stats.deleted)}
              sub={share(stats.deleted, stats.totalActions)}
            />
            <Figure
              label={t('stats.failed')}
              icon={<TriangleAlert size={12} />}
              value={formatNumber(stats.failed)}
              sub={stats.failed === 0 ? t('stats.failedNone') : t('stats.failedSome')}
            />
            <Figure
              label={t('stats.activeSince')}
              icon={<CalendarDays size={12} />}
              value={stats.firstActionAt === null ? '—' : formatDate(stats.firstActionAt)}
              sub={
                stats.firstActionAt === null
                  ? t('stats.noDated')
                  : t('stats.firstActionIn', { range: rangeLabel })
              }
            />
          </div>

          <Card
            title={t('stats.activity')}
            icon={<TrendingUp size={13} />}
            style={{ marginTop: 16 }}
            actions={
              <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                {truncated
                  ? t('stats.recentDays', {
                      shown: MAX_COLUMNS,
                      total: plural(columns.length, 'day'),
                    })
                  : plural(shown.length, 'day')}
              </span>
            }
          >
            {shown.length === 0 ? (
              <EmptyState title={t('stats.noDatedActivity')} hint={t('stats.noDatedActivityHint')} />
            ) : (
              <DayChart days={shown} />
            )}
          </Card>

          <div className="col" style={{ gap: 16, marginTop: 16 }}>
            <Card title={t('stats.byGame')} icon={<Gamepad2 size={13} />}>
              {stats.perGame.length === 0 ? (
                <EmptyState title={t('stats.noGame')} hint={t('stats.noGameHint')} />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('queue.col.game')}</th>
                      <th style={{ width: '45%' }}>{t('stats.share')}</th>
                      <th style={{ textAlign: 'right' }}>{t('stats.actionsColumn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.perGame.map((game) => (
                      <tr
                        key={game.gameId ?? game.gameName}
                        data-row-action={game.gameId !== null ? 'true' : undefined}
                        onClick={game.gameId === null ? undefined : () => openGame(game.gameId)}
                      >
                        <td className="truncate">{game.gameName}</td>
                        <td>
                          <ShareBar value={game.count} max={stats.perGame[0]?.count ?? game.count} />
                        </td>
                        <td style={{ textAlign: 'right' }} className="num">
                          {formatNumber(game.count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title={t('stats.topReasons')} icon={<ListChecks size={13} />}>
              {stats.topReasons.length === 0 ? (
                <EmptyState title={t('stats.noReasons')} hint={t('stats.noReasonsHint')} />
              ) : (
                <div className="col" style={{ gap: 10 }}>
                  {stats.topReasons.map((reason) => (
                    <div key={reason.reason} className="col" style={{ gap: 4 }}>
                      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)' }} data-selectable>
                          {reason.reason}
                        </span>
                        <span className="num dim" style={{ fontSize: 'var(--text-xs)' }}>
                          {plural(reason.count, 'time')}
                        </span>
                      </div>
                      <ShareBar
                        value={reason.count}
                        max={stats.topReasons[0]?.count ?? reason.count}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div
            className="row"
            style={{
              gap: 8,
              marginTop: 16,
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
            }}
          >
            <Timer size={12} />
            {stats.firstActionAt === null || stats.lastActionAt === null
              ? t('stats.noTimestamps')
              : t('stats.fromTo', {
                  from: formatDateTime(stats.firstActionAt),
                  to: formatDateTime(stats.lastActionAt),
                })}
          </div>
        </>
      )}
    </div>
  );
}

/** "43% of all actions", or a plain dash when there is nothing to divide by. */
function share(value: number, total: number): string {
  if (total <= 0) return translate('stats.noActions');
  return translate('stats.shareOfActions', {
    percent: formatPercent((value / total) * 100, 0),
  });
}

/**
 * Fills the gaps in the daily series.
 *
 * The backend groups by day and therefore returns nothing at all for a day with
 * no activity. Drawing only the days that exist would compress a quiet week
 * into a single bar and make a burst look like steady work, so the missing days
 * are inserted as zeroes. All-time keeps the sparse series: the range could be
 * years, and there is no honest way to render that as one column per day.
 */
function fillDays(perDay: DailyCount[], days: number): DailyCount[] {
  if (days <= 0) return perDay;

  const byDay = new Map(perDay.map((entry) => [entry.day, entry]));
  const out: DailyCount[] = [];
  const todayMs = Date.now();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    // The backend groups on the UTC date prefix of the timestamp, so the key
    // has to be built in UTC too or every bar would land a day out.
    const key = new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, verified: 0, rejected: 0, deleted: 0, failed: 0 });
  }
  return out;
}

function DayChart({ days }: { days: DailyCount[] }) {
  const t = useT();
  const peak = days.reduce(
    (max, day) => Math.max(max, day.verified + day.rejected + day.deleted + day.failed),
    0,
  );
  const first = days[0];
  const last = days[days.length - 1];

  return (
    <>
      <div className="chart">
        {days.map((day) => {
          const total = day.verified + day.rejected + day.deleted + day.failed;
          return (
            // A native title rather than the Tooltip component: the columns are
            // flex children of `.chart`, and wrapping each one in the tooltip's
            // anchor span would break the widths.
            <div
              className="chart__col"
              key={day.day}
              title={
                total === 0
                  ? t('stats.dayNothing', { day: dayLabel(day.day) })
                  : t('stats.dayBreakdown', {
                      day: dayLabel(day.day),
                      verified: day.verified,
                      rejected: day.rejected,
                      deleted: day.deleted,
                      failed: day.failed,
                    })
              }
            >
              <Segment kind="verified" count={day.verified} peak={peak} />
              <Segment kind="rejected" count={day.rejected} peak={peak} />
              <Segment kind="deleted" count={day.deleted} peak={peak} />
              <Segment kind="failed" count={day.failed} peak={peak} />
            </div>
          );
        })}
      </div>

      <div className="chart__axis">
        <span>{first === undefined ? '' : dayLabel(first.day)}</span>
        <span>
          {peak === 0
            ? t('stats.noActivity')
            : t('stats.peak', { count: plural(peak, 'action') })}
        </span>
        <span>{last === undefined ? '' : dayLabel(last.day)}</span>
      </div>

      <div className="legend" style={{ marginTop: 10 }}>
        <LegendItem kind="verified" label={t('stats.verified')} />
        <LegendItem kind="rejected" label={t('stats.rejected')} />
        <LegendItem kind="deleted" label={t('stats.deleted')} />
        <LegendItem kind="failed" label={t('stats.failed')} />
      </div>
    </>
  );
}

/**
 * Formats a `YYYY-MM-DD` grouping key.
 *
 * Not `formatDate`: that parses the string as UTC midnight and then renders it
 * in local time, which shifts every bar back a day west of Greenwich. The parts
 * are read directly instead.
 */
function dayLabel(key: string): string {
  const parts = key.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return key;
  return new Date(year, month - 1, day).toLocaleDateString(activeLanguage(), {
    month: 'short',
    day: 'numeric',
  });
}

type SegmentKind = 'verified' | 'rejected' | 'deleted' | 'failed';

function Segment({ kind, count, peak }: { kind: SegmentKind; count: number; peak: number }) {
  if (count === 0 || peak === 0) return null;
  return (
    <span
      className={`chart__seg chart__seg--${kind}`}
      style={{ height: `${(count / peak) * 100}%` }}
    />
  );
}

function LegendItem({ kind, label }: { kind: SegmentKind; label: string }) {
  return (
    <span className="legend__item">
      <span className={`legend__swatch chart__seg--${kind}`} />
      {label}
    </span>
  );
}

/** A proportional bar for the "by game" and "top reasons" lists. */
function ShareBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <span
      style={{
        display: 'block',
        height: 6,
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-active)',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${pct}%`,
          background: 'var(--accent)',
        }}
      />
    </span>
  );
}

function Figure({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <span className="stat-card__label">
        {icon}
        {label}
      </span>
      <span className="stat-card__value">{value}</span>
      <span className="stat-card__sub">{sub}</span>
    </div>
  );
}
