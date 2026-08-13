/**
 * History: SRCTools' own record of what this moderator did on this machine.
 *
 * This is deliberately *not* presented as a Speedrun.com moderation log.
 * Speedrun.com exposes no "actions by moderator" endpoint, so everything here is
 * what SRCTools itself performed and wrote down locally. Actions taken in the
 * browser, on another machine, or by another moderator will not appear, and the
 * page says so rather than letting the moderator assume the list is complete.
 *
 * Clearing the log is local only: a run that was rejected stays rejected on the
 * site. The confirmation says that in as many words.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  Funnel,
  Info,
  Layers,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import {
  Absent,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Segmented,
  Skeleton,
  Spinner,
  Tabs,
  Tooltip,
} from '../components/ui';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  plural,
  type Tone,
} from '../format';
import { useT, type Translate, type TranslationKey } from '../i18n';
import { errorText, records } from '../ipc';
import { copyToClipboard, openExternal, saveExport } from '../open';
import { useApp } from '../store/app';
import { useQueue } from '../store/queue';
import { ui } from '../store/ui';
import type {
  ActionOutcome,
  AuditEntry,
  HistoryEntry,
  HistoryQuery,
  ModerationActionName,
} from '../types';

/** Rows per request. The backend caps a page well above this. */
const PAGE = 100;

type ActionFilter = 'all' | ModerationActionName;
type OutcomeFilter = 'all' | ActionOutcome;
type HistoryTab = 'actions' | 'batches';

export function History() {
  const t = useT();
  const [tab, setTab] = useState<HistoryTab>('actions');

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">{t('history.title')}</h2>
          <p className="page__subtitle">{t('history.subtitle')}</p>
        </div>
        <div className="page__actions">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'actions', label: t('history.tab.actions') },
              { value: 'batches', label: t('history.tab.batches') },
            ]}
          />
        </div>
      </div>

      {tab === 'actions' ? <ActionLog /> : <BatchLog />}
    </div>
  );
}

/* ------------------------------------------------------------- action log */

function ActionLog() {
  const t = useT();
  const openDetail = useApp((state) => state.openDetail);
  const go = useApp((state) => state.go);

  /**
   * Opens the inspection panel for a logged run.
   *
   * The panel lives on the queue, and the run may well have left it — it was
   * verified or rejected, after all — so the queue is asked to focus it and the
   * detail is fetched by id rather than read from the table.
   */
  const inspect = (runId: string) => {
    go('queue');
    useQueue.getState().focusRun(runId);
    openDetail(runId);
  };

  const [action, setAction] = useState<ActionFilter>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [appending, setAppending] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [reload, setReload] = useState(0);

  // Typing in the filter box should not fire a query per keystroke; the log can
  // hold tens of thousands of rows.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo<HistoryQuery>(
    () => ({
      action: action === 'all' ? null : action,
      outcome: outcome === 'all' ? null : outcome,
      search: debounced.trim() === '' ? null : debounced.trim(),
      // `acted_at` is a full ISO timestamp, so an inclusive upper bound has to
      // reach the end of the chosen day rather than its midnight.
      since: since === '' ? null : since,
      until: until === '' ? null : `${until}T23:59:59.999Z`,
    }),
    [action, outcome, debounced, since, until],
  );

  const filtered =
    action !== 'all' || outcome !== 'all' || debounced.trim() !== '' || since !== '' || until !== '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void records
      .history({ ...query, limit: PAGE, offset: 0 })
      .then((page) => {
        if (cancelled) return;
        setRows(page);
        setMore(page.length === PAGE);
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
  }, [query, reload]);

  // The unfiltered total, so "12 of 3,400" is honest about what is being shown.
  useEffect(() => {
    let cancelled = false;
    void records
      .historyCount()
      .then((count) => {
        if (!cancelled) setTotal(count);
      })
      .catch(() => {
        if (!cancelled) setTotal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const loadMore = async () => {
    setAppending(true);
    try {
      const page = await records.history({ ...query, limit: PAGE, offset: rows.length });
      setRows((current) => [...current, ...page]);
      setMore(page.length === PAGE);
    } catch (err) {
      ui.error(t('history.loadMoreFailed'), err);
    } finally {
      setAppending(false);
    }
  };

  const exportAs = async (format: 'csv' | 'json') => {
    setExporting(format);
    try {
      // Exports follow the filters on screen, so what is saved matches what the
      // moderator is looking at.
      const payload = await records.exportHistory(format, query);
      if (payload.rowCount === 0) {
        ui.warning(t('history.nothingToExport'), t('history.nothingToExportHint'));
        return;
      }
      await saveExport(payload);
    } catch (err) {
      ui.error(t('queue.exportFailed'), err);
    } finally {
      setExporting(null);
    }
  };

  const clearAll = async () => {
    const confirmed = await ui.confirm({
      title: t('history.clearTitle'),
      message: t('history.clearMessage'),
      danger: true,
      confirmLabel: t('history.clearConfirm'),
      acknowledge: t('history.clearAcknowledge'),
    });
    if (!confirmed) return;

    try {
      const removed = await records.clearHistory(true);
      ui.success(
        t('history.cleared'),
        t('history.clearedHint', { entries: plural(removed, 'entry') }),
      );
      setReload((n) => n + 1);
    } catch (err) {
      ui.error(t('history.clearFailed'), err);
    }
  };

  const resetFilters = () => {
    setAction('all');
    setOutcome('all');
    setSearch('');
    setSince('');
    setUntil('');
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar__group" style={{ flex: 1, minWidth: 0 }}>
          <Search size={14} style={{ color: 'var(--text-tertiary)' }} />
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder={t('history.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>

        <div className="toolbar__divider" />

        <Segmented<ActionFilter>
          value={action}
          onChange={setAction}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'verify', label: t('history.action.verify') },
            { value: 'reject', label: t('history.action.reject') },
            { value: 'delete', label: t('history.action.delete') },
          ]}
        />

        <Segmented<OutcomeFilter>
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: t('history.outcome.any') },
            { value: 'success', label: t('history.outcome.success') },
            { value: 'failed', label: t('history.outcome.failed') },
          ]}
        />
      </div>

      <div className="toolbar">
        <div className="toolbar__group">
          <span className="label">{t('history.from')}</span>
          <input
            className="input"
            type="date"
            value={since}
            max={until === '' ? undefined : until}
            onChange={(event) => setSince(event.currentTarget.value)}
          />
        </div>
        <div className="toolbar__group">
          <span className="label">{t('history.to')}</span>
          <input
            className="input"
            type="date"
            value={until}
            min={since === '' ? undefined : since}
            onChange={(event) => setUntil(event.currentTarget.value)}
          />
        </div>

        {filtered && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={resetFilters}>
            <Funnel size={13} />
            {t('queue.clearFilters')}
          </button>
        )}

        <div className="toolbar__spacer" />

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
          onClick={() => void exportAs('csv')}
          disabled={exporting !== null}
        >
          {exporting === 'csv' ? <Spinner /> : <Download size={13} />}
          CSV
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void exportAs('json')}
          disabled={exporting !== null}
        >
          {exporting === 'json' ? <Spinner /> : <Download size={13} />}
          JSON
        </button>
        <button type="button" className="btn btn--sm btn--danger" onClick={() => void clearAll()}>
          <Trash2 size={13} />
          {t('history.clear')}
        </button>
      </div>

      <div className="notice notice--info" style={{ marginBottom: 12 }}>
        <Info size={15} />
        <span>{t('history.notice')}</span>
      </div>

      {error !== null && <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />}

      {error === null && loading && (
        <div className="col" style={{ gap: 6 }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <Skeleton key={n} height={34} radius={6} />
          ))}
        </div>
      )}

      {error === null && !loading && rows.length === 0 && (
        <EmptyState
          icon={<ClipboardList size={26} />}
          title={filtered ? t('history.noMatch') : t('history.empty')}
          hint={filtered ? t('history.noMatchHint') : t('history.emptyHint')}
          action={
            filtered ? (
              <button type="button" className="btn" onClick={resetFilters}>
                {t('queue.clearFilters')}
              </button>
            ) : undefined
          }
        />
      )}

      {error === null && !loading && rows.length > 0 && (
        <>
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
              marginBottom: 6,
            }}
          >
            <span>{countLabel(rows.length, total, filtered, t)}</span>
            {more && <span>{t('history.olderBelow')}</span>}
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>{t('history.col.when')}</th>
                <th>{t('history.col.action')}</th>
                <th>{t('queue.col.game')}</th>
                <th>{t('queue.col.category')}</th>
                <th>{t('queue.col.runner')}</th>
                <th style={{ textAlign: 'right' }}>{t('queue.col.time')}</th>
                <th>{t('history.col.reason')}</th>
                <th aria-label={t('history.tab.actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} onInspect={() => inspect(entry.runId)} />
              ))}
            </tbody>
          </table>

          {more && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                onClick={() => void loadMore()}
                disabled={appending}
              >
                {appending ? <Spinner /> : null}
                {t('history.loadMore', { count: PAGE })}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

const ACTION_COPY: Record<ModerationActionName, { labelKey: TranslationKey; tone: Tone }> = {
  verify: { labelKey: 'history.action.verify', tone: 'ok' },
  reject: { labelKey: 'history.action.reject', tone: 'danger' },
  delete: { labelKey: 'history.action.delete', tone: 'warn' },
};

/**
 * "Showing 12 of 3,400", in one of its three shapes.
 *
 * Assembled as whole sentences rather than a stem plus suffixes, because the
 * numbers do not sit in the same order in every language.
 */
function countLabel(shown: number, total: number | null, filtered: boolean, t: Translate): string {
  const shownText = formatNumber(shown);
  if (total === null) return t('history.showing', { shown: shownText });
  if (filtered) {
    return t('history.showingMatching', { shown: shownText, total: formatNumber(total) });
  }
  return t('history.showingOf', { shown: shownText, total: formatNumber(total) });
}

/**
 * Label for an audited operation.
 *
 * The backend writes machine names (`bulk_verify`, `delete_run`). Anything not
 * listed is shown as its identifier rather than guessed at, so an operation
 * added later reads as unfamiliar instead of as the wrong action.
 */
const OPERATION_KEYS: Record<string, TranslationKey> = {
  bulk_verify: 'history.op.bulkVerify',
  bulk_reject: 'history.op.bulkReject',
  bulk_delete: 'history.op.bulkDelete',
  delete_run: 'history.op.deleteRun',
};

function HistoryRow({ entry, onInspect }: { entry: HistoryEntry; onInspect: () => void }) {
  const t = useT();
  const copy = ACTION_COPY[entry.action];
  const label = t(copy.labelKey);
  const failed = entry.outcome === 'failed';

  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Tooltip label={formatDateTime(entry.actedAt)}>
          <span>{formatRelative(entry.actedAt)}</span>
        </Tooltip>
      </td>
      <td>
        <span className="row" style={{ gap: 6 }}>
          {/* A failed attempt is not the action having happened, so the tone
              never says "verified" in green when Speedrun.com refused it. */}
          <Badge tone={failed ? 'unknown' : copy.tone} small>
            {failed ? t('history.actionFailed', { action: label }) : label}
          </Badge>
        </span>
      </td>
      <td className="truncate">{entry.gameName ?? <Absent />}</td>
      <td className="truncate">{entry.categoryName ?? <Absent />}</td>
      <td className="truncate">{entry.playerNames ?? <Absent />}</td>
      <td style={{ textAlign: 'right' }} className="num">
        {formatDuration(entry.runTime)}
      </td>
      <td style={{ maxWidth: 320 }}>
        {failed ? (
          <span className="row" style={{ gap: 6, color: 'var(--danger-text)' }}>
            <TriangleAlert size={12} />
            <span data-selectable>{entry.errorMessage ?? t('history.requestFailed')}</span>
          </span>
        ) : entry.reason !== null && entry.reason.trim() !== '' ? (
          <span data-selectable>{entry.reason}</span>
        ) : (
          <span className="dim">{t('history.noReason')}</span>
        )}
        {entry.batchId !== null && (
          <span className="dim" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
            {t('history.partOfBatch')}
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={onInspect}
          title={t('history.inspect')}
          aria-label={t('history.inspect')}
        >
          <Search size={12} />
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void copyToClipboard(entry.runId, t('queue.row.idCopied'))}
          title={t('history.copyRunIdTitle', { id: entry.runId })}
          aria-label={t('queue.row.copyId')}
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void openExternal(entry.runWeblink)}
          disabled={entry.runWeblink === null}
          title={t('action.openOnSrc')}
          aria-label={t('action.openOnSrc')}
        >
          <ExternalLink size={12} />
        </button>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------- batch log */

/**
 * The audit trail for bulk and destructive operations.
 *
 * Recorded per batch with the counts the spec asks for — how many were
 * attempted, how many succeeded, how many failed — so a partially failed bulk
 * action leaves a trace even after the toast has gone.
 */
function BatchLog() {
  const t = useT();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void records
      .audit(200)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
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

  return (
    <>
      <div className="toolbar">
        <span className="label">
          {loading
            ? t('common.loading')
            : t('history.batchesRecorded', {
                operations: plural(entries.length, 'operation'),
              })}
        </span>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
        >
          {loading ? <Spinner /> : <RefreshCw size={13} />}
          {t('common.refresh')}
        </button>
      </div>

      {error !== null && <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />}

      {error === null && loading && (
        <div className="col" style={{ gap: 8 }}>
          {[0, 1, 2, 3].map((n) => (
            <Skeleton key={n} height={64} radius={8} />
          ))}
        </div>
      )}

      {error === null && !loading && entries.length === 0 && (
        <EmptyState
          icon={<Layers size={26} />}
          title={t('history.noBatches')}
          hint={t('history.noBatchesHint')}
        />
      )}

      {error === null && !loading && entries.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          {entries.map((entry) => (
            <BatchCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}

function BatchCard({ entry }: { entry: AuditEntry }) {
  const t = useT();
  const partial = entry.failed > 0 && entry.succeeded > 0;
  const tone: Tone = entry.failed === 0 ? 'ok' : partial ? 'warn' : 'danger';
  const operationKey = OPERATION_KEYS[entry.operation];

  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          <span>{operationKey === undefined ? entry.operation : t(operationKey)}</span>
          <Badge tone={tone} small dot>
            {entry.failed === 0
              ? t('history.batch.allSucceeded')
              : partial
                ? t('history.batch.partlyFailed')
                : t('history.batch.failed')}
          </Badge>
        </span>
      }
      icon={<Layers size={13} />}
      actions={
        <Tooltip
          label={formatDateTime(entry.startedAt)}
          detail={t('history.batch.finished', { when: formatDateTime(entry.finishedAt) })}
        >
          <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
            {formatRelative(entry.startedAt)}
          </span>
        </Tooltip>
      }
    >
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <BatchFigure label={t('history.batch.attempted')} value={entry.total} />
        <BatchFigure label={t('history.outcome.success')} value={entry.succeeded} tone="ok" />
        <BatchFigure
          label={t('history.batch.failed')}
          value={entry.failed}
          tone={entry.failed > 0 ? 'danger' : undefined}
        />
      </div>

      {entry.detail !== null && entry.detail.trim() !== '' && (
        <div
          className="dim"
          style={{ fontSize: 'var(--text-xs)', marginTop: 10, lineHeight: 1.5 }}
          data-selectable
        >
          {entry.detail}
        </div>
      )}

      <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
        {t('history.batch.id', { id: entry.batchId })}
      </div>
    </Card>
  );
}

function BatchFigure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'danger';
}) {
  const colour = tone === 'ok' ? 'var(--ok)' : tone === 'danger' ? 'var(--danger-text)' : undefined;
  return (
    <span className="col" style={{ gap: 2 }}>
      <span className="label">{label}</span>
      <span className="num" style={{ fontSize: 'var(--text-xl)', color: colour }}>
        {formatNumber(value)}
      </span>
    </span>
  );
}
