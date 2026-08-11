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
  const [tab, setTab] = useState<HistoryTab>('actions');

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">History</h2>
          <p className="page__subtitle">
            Everything SRCTools has done from this machine, kept locally.
          </p>
        </div>
        <div className="page__actions">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'actions', label: 'Actions' },
              { value: 'batches', label: 'Bulk operations' },
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
      ui.error('Could not load more history', err);
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
        ui.warning('Nothing to export', 'No history entries match the current filters.');
        return;
      }
      await saveExport(payload);
    } catch (err) {
      ui.error('Could not build the export', err);
    } finally {
      setExporting(null);
    }
  };

  const clearAll = async () => {
    const confirmed = await ui.confirm({
      title: 'Clear the local history?',
      message:
        'This erases SRCTools’ own record of what you have done on this machine, including the bulk operation log. It changes nothing on Speedrun.com: runs you verified stay verified, and runs you rejected stay rejected.',
      danger: true,
      confirmLabel: 'Clear history',
      acknowledge: 'I understand this cannot be undone',
    });
    if (!confirmed) return;

    try {
      const removed = await records.clearHistory(true);
      ui.success('History cleared', `${plural(removed, 'entry')} removed from this machine.`);
      setReload((n) => n + 1);
    } catch (err) {
      ui.error('Could not clear the history', err);
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
            placeholder="Search game, category, runner, reason or run id"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>

        <div className="toolbar__divider" />

        <Segmented<ActionFilter>
          value={action}
          onChange={setAction}
          options={[
            { value: 'all', label: 'All' },
            { value: 'verify', label: 'Verified' },
            { value: 'reject', label: 'Rejected' },
            { value: 'delete', label: 'Deleted' },
          ]}
        />

        <Segmented<OutcomeFilter>
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: 'Any result' },
            { value: 'success', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      <div className="toolbar">
        <div className="toolbar__group">
          <span className="label">From</span>
          <input
            className="input"
            type="date"
            value={since}
            max={until === '' ? undefined : until}
            onChange={(event) => setSince(event.currentTarget.value)}
          />
        </div>
        <div className="toolbar__group">
          <span className="label">To</span>
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
            Clear filters
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
          Refresh
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
          Clear…
        </button>
      </div>

      <div className="notice notice--info" style={{ marginBottom: 12 }}>
        <Info size={15} />
        <span>
          This is SRCTools' own log, written when an action succeeds or fails here. Moderation done
          in a browser or on another machine is not part of it, and Speedrun.com does not publish a
          history that could be imported.
        </span>
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
          title={filtered ? 'Nothing matches those filters' : 'No actions recorded yet'}
          hint={
            filtered
              ? 'Widen the date range or clear the filters to see the rest of the log.'
              : 'Verify or reject a run and it will be written here, along with the reason you gave.'
          }
          action={
            filtered ? (
              <button type="button" className="btn" onClick={resetFilters}>
                Clear filters
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
            <span>
              Showing {formatNumber(rows.length)}
              {total !== null && !filtered ? ` of ${formatNumber(total)}` : ''}
              {filtered && total !== null ? ` matching (${formatNumber(total)} recorded)` : ''}
            </span>
            {more && <span>Older entries are further down.</span>}
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Game</th>
                <th>Category</th>
                <th>Runner</th>
                <th style={{ textAlign: 'right' }}>Time</th>
                <th>Reason / result</th>
                <th aria-label="Actions" />
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
                Load {PAGE} more
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

const ACTION_COPY: Record<ModerationActionName, { label: string; tone: Tone }> = {
  verify: { label: 'Verified', tone: 'ok' },
  reject: { label: 'Rejected', tone: 'danger' },
  delete: { label: 'Deleted', tone: 'warn' },
};

function HistoryRow({ entry, onInspect }: { entry: HistoryEntry; onInspect: () => void }) {
  const copy = ACTION_COPY[entry.action];
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
            {failed ? `${copy.label} — failed` : copy.label}
          </Badge>
        </span>
      </td>
      <td className="truncate">{entry.gameName ?? <span className="absent">—</span>}</td>
      <td className="truncate">{entry.categoryName ?? <span className="absent">—</span>}</td>
      <td className="truncate">{entry.playerNames ?? <span className="absent">—</span>}</td>
      <td style={{ textAlign: 'right' }} className="num">
        {formatDuration(entry.runTime)}
      </td>
      <td style={{ maxWidth: 320 }}>
        {failed ? (
          <span className="row" style={{ gap: 6, color: 'var(--danger-text)' }}>
            <TriangleAlert size={12} />
            <span data-selectable>{entry.errorMessage ?? 'The request failed.'}</span>
          </span>
        ) : entry.reason !== null && entry.reason.trim() !== '' ? (
          <span data-selectable>{entry.reason}</span>
        ) : (
          <span className="dim">No reason recorded</span>
        )}
        {entry.batchId !== null && (
          <span className="dim" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
            part of a bulk operation
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={onInspect}
          title="Inspect this run"
          aria-label="Inspect this run"
        >
          <Search size={12} />
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void copyToClipboard(entry.runId, 'Run id copied')}
          title={`Copy run id ${entry.runId}`}
          aria-label="Copy run id"
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void openExternal(entry.runWeblink)}
          disabled={entry.runWeblink === null}
          title="Open on Speedrun.com"
          aria-label="Open on Speedrun.com"
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
          {loading ? 'Loading…' : `${plural(entries.length, 'operation')} recorded`}
        </span>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
        >
          {loading ? <Spinner /> : <RefreshCw size={13} />}
          Refresh
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
          title="No bulk operations yet"
          hint="Selecting several runs and acting on them at once records the batch here, with how many succeeded and how many failed."
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
  const partial = entry.failed > 0 && entry.succeeded > 0;
  const tone: Tone = entry.failed === 0 ? 'ok' : partial ? 'warn' : 'danger';

  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          <span>{entry.operation}</span>
          <Badge tone={tone} small dot>
            {entry.failed === 0
              ? 'All succeeded'
              : partial
                ? 'Partly failed'
                : 'Failed'}
          </Badge>
        </span>
      }
      icon={<Layers size={13} />}
      actions={
        <Tooltip label={formatDateTime(entry.startedAt)} detail={`Finished ${formatDateTime(entry.finishedAt)}`}>
          <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
            {formatRelative(entry.startedAt)}
          </span>
        </Tooltip>
      }
    >
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <BatchFigure label="Attempted" value={entry.total} />
        <BatchFigure label="Succeeded" value={entry.succeeded} tone="ok" />
        <BatchFigure label="Failed" value={entry.failed} tone={entry.failed > 0 ? 'danger' : undefined} />
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
        Batch {entry.batchId}
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
