/**
 * The review queue: toolbar, virtualised table, bulk bar and detail panel.
 *
 * Two kinds of filtering live side by side here. The status/scope controls on
 * the left rebuild the request sent to Speedrun.com; the filter box, video
 * filter and duplicates toggle narrow what is already loaded and never touch
 * the network. That distinction is why typing in the box is instant.
 *
 * Nothing on this page acts on its own. Video checks and the analysis engine
 * annotate rows; every verify, reject and delete comes from a key the moderator
 * pressed or a button they clicked.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Ban,
  Check,
  Columns3,
  Copy,
  Download,
  Filter,
  Inbox,
  RotateCcw,
  Search,
  ShieldAlert,
  SkipForward,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react';

import { RejectDialog } from '../components/RejectDialog';
import {
  Checkbox,
  ContextMenu,
  EmptyState,
  ErrorState,
  ProgressBar,
  Segmented,
  Spinner,
  Tooltip,
  type MenuAnchor,
  type MenuEntry,
} from '../components/ui';
import { useShortcuts } from '../hooks/useShortcuts';
import { useSplit } from '../hooks/useSplit';
import { useT, type Translate, type TranslationKey } from '../i18n';
import { records } from '../ipc';
import { formatNumber, plural } from '../format';
import { copyToClipboard, openExternal, saveExport } from '../open';
import { useApp } from '../store/app';
import { failureSummary, useModeration } from '../store/moderation';
import { QUEUE_COLUMNS, useQueue, type VideoFilter } from '../store/queue';
import { useSession } from '../store/session';
import { ui } from '../store/ui';
import type { RunSummary } from '../types';
import { QueueTable } from './QueueTable';
import { RunDetailPanel } from './RunDetail';

// Built per render rather than at module scope: a module-level array would be
// frozen in whatever language the app started in.
const statusOptions = (t: Translate) => [
  { value: 'new' as const, label: t('runStatus.new'), title: t('queue.status.newHint') },
  {
    value: 'verified' as const,
    label: t('runStatus.verified'),
    title: t('queue.status.verifiedHint'),
  },
  {
    value: 'rejected' as const,
    label: t('runStatus.rejected'),
    title: t('queue.status.rejectedHint'),
  },
];

const videoOptions = (t: Translate): Array<{ value: VideoFilter; label: string }> => [
  { value: 'any', label: t('queue.video.any') },
  { value: 'problem', label: t('queue.video.problem') },
  { value: 'ok', label: t('queue.video.ok') },
  { value: 'unverified', label: t('queue.video.unverified') },
  { value: 'none', label: t('queue.video.none') },
];

export function Queue() {
  const t = useT();
  const searchBox = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** Runs the rejection dialog is open for; `null` when it is closed. */
  const [rejecting, setRejecting] = useState<RunSummary[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const hasApiKey = useSession((state) => state.hasApiKey);
  const hidden = useSession((state) => state.settings.hiddenColumns);
  const updateSetting = useSession((state) => state.updateSetting);

  const runs = useQueue((state) => state.visible());
  const total = useQueue((state) => state.runs.length);
  const loading = useQueue((state) => state.loading);
  const error = useQueue((state) => state.error);
  const truncated = useQueue((state) => state.truncated);
  const fetchedAt = useQueue((state) => state.fetchedAt);
  const filter = useQueue((state) => state.filter);
  const search = useQueue((state) => state.search);
  const videoFilter = useQueue((state) => state.videoFilter);
  const onlyDuplicates = useQueue((state) => state.onlyDuplicates);
  const checking = useQueue((state) => state.checking);
  const checkProgress = useQueue((state) => state.checkProgress);
  const selected = useQueue((state) => state.selected);

  const load = useQueue((state) => state.load);
  const setFilter = useQueue((state) => state.setFilter);
  const resetFilter = useQueue((state) => state.resetFilter);
  const setSearch = useQueue((state) => state.setSearch);
  const setVideoFilter = useQueue((state) => state.setVideoFilter);
  const setOnlyDuplicates = useQueue((state) => state.setOnlyDuplicates);
  const checkVideos = useQueue((state) => state.checkVideos);
  const clearSelection = useQueue((state) => state.clearSelection);

  const bulk = useModeration((state) => state.bulk);
  const bulkAction = useModeration((state) => state.bulkAction);
  const retryFailures = useModeration((state) => state.retryFailures);
  const dismissBulk = useModeration((state) => state.dismissBulk);

  const detailRunId = useApp((state) => state.detailRunId);
  const openDetail = useApp((state) => state.openDetail);
  const closeDetail = useApp((state) => state.closeDetail);
  const setFastReview = useApp((state) => state.setFastReview);
  const queueSplit = useApp((state) => state.layout.queueSplit);
  const setLayout = useApp((state) => state.setLayout);

  const { containerRef, handleProps, fraction } = useSplit({
    value: queueSplit,
    onChange: (value) => setLayout({ queueSplit: value }),
    min: 0.3,
    max: 0.85,
  });

  // First visit to the page with nothing loaded. The shell loads once at
  // startup; this covers arriving here after connecting a key later on.
  useEffect(() => {
    if (hasApiKey && fetchedAt === null && !loading) void load();
  }, [hasApiKey, fetchedAt, loading, load]);

  const selectedRuns = () => useQueue.getState().selectedRuns();

  /* ------------------------------------------------------------ shortcuts */

  useShortcuts({
    approve: () => {
      const run = useQueue.getState().focused();
      if (run) void useModeration.getState().verify(run);
    },
    reject: () => {
      const run = useQueue.getState().focused();
      if (run) setRejecting([run]);
    },
    openVideo: () => {
      const run = useQueue.getState().focused();
      if (!run) return;
      const first = run.videoUrls[0];
      if (first) void openExternal(first);
      else ui.warning(t('queue.noVideoLink'));
    },
    openRun: () => {
      const run = useQueue.getState().focused();
      if (run) void openExternal(run.weblink);
    },
    openDetail: () => {
      const run = useQueue.getState().focused();
      if (run) openDetail(run.id);
    },
    toggleSelect: () => {
      const run = useQueue.getState().focused();
      if (run) useQueue.getState().toggleSelect(run.id);
    },
    next: () => {
      const run = useQueue.getState().move(1);
      // Keeping the panel in step means N and P walk the queue with the detail
      // open, which is how a moderator actually reviews.
      if (run && useApp.getState().detailRunId) openDetail(run.id);
    },
    previous: () => {
      const run = useQueue.getState().move(-1);
      if (run && useApp.getState().detailRunId) openDetail(run.id);
    },
    fastReview: () => {
      if (runs.length === 0) {
        ui.info(t('queue.nothingToReview'), t('queue.nothingToReviewHint'));
        return;
      }
      setFastReview(true);
    },
    selectAll: () => useQueue.getState().selectAllVisible(),
    clearSelection: () => clearSelection(),
    search: () => {
      searchBox.current?.focus();
      searchBox.current?.select();
    },
  });

  /* ---------------------------------------------------------------- menus */

  const columnMenu = (): MenuEntry[] => {
    const visibleCount = QUEUE_COLUMNS.length - hidden.length;
    return [
      { heading: t('queue.columns.heading') },
      ...QUEUE_COLUMNS.map((column) => {
        const isHidden = hidden.includes(column.id);
        return {
          label: t(column.labelKey),
          icon: isHidden ? <span style={{ width: 13 }} /> : <Check size={13} />,
          // The last remaining column cannot be hidden; an empty table would
          // leave no way to get it back.
          disabled: !isHidden && visibleCount <= 1,
          onSelect: () =>
            void updateSetting(
              'hiddenColumns',
              isHidden ? hidden.filter((id) => id !== column.id) : [...hidden, column.id],
            ),
        };
      }),
    ];
  };

  const exportMenu = (): MenuEntry[] => {
    const chosen = selected.size > 0 ? selectedRuns() : runs;
    const scope =
      selected.size > 0 ? t('queue.export.scopeSelected') : t('queue.export.scopeShown');
    return [
      {
        heading: t('queue.export.heading', {
          runs: plural(chosen.length, 'run'),
          scope,
        }),
      },
      {
        label: t('queue.export.csv'),
        icon: <Download size={13} />,
        disabled: chosen.length === 0 || exporting,
        onSelect: () => void runExport('csv', chosen),
      },
      {
        label: t('queue.export.json'),
        icon: <Download size={13} />,
        disabled: chosen.length === 0 || exporting,
        onSelect: () => void runExport('json', chosen),
      },
    ];
  };

  const runExport = async (format: 'csv' | 'json', chosen: RunSummary[]) => {
    if (chosen.length === 0) return;
    setExporting(true);
    try {
      const payload = await records.exportRuns(format, chosen);
      await saveExport(payload);
    } catch (err) {
      ui.error(t('queue.exportFailed'), err);
    } finally {
      setExporting(false);
    }
  };

  /** Opens a menu anchored beneath a toolbar button. */
  const openToolbarMenu = (event: React.MouseEvent<HTMLButtonElement>, entries: MenuEntry[]) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom + 4, entries });
  };

  /* ------------------------------------------------------------- rendering */

  if (!hasApiKey) {
    return (
      <div className="page">
        <EmptyState
          icon={<ShieldAlert size={26} />}
          title={t('queue.noKey')}
          hint={t('queue.noKeyHint')}
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => useApp.getState().go('settings')}
            >
              {t('queue.openSettings')}
            </button>
          }
        />
      </div>
    );
  }

  const selectionSize = selected.size;

  return (
    <div className="page page--flush">
      <div className="toolbar">
        <Segmented
          value={(filter.status ?? 'new') as 'new' | 'verified' | 'rejected'}
          options={statusOptions(t)}
          onChange={(value) => void setFilter({ status: value })}
        />

        <div className="toolbar__divider" />

        <label className="row" style={{ gap: 6, position: 'relative' }} title={t('queue.filterHint')}>
          <Search
            size={13}
            style={{ position: 'absolute', left: 8, color: 'var(--text-tertiary)' }}
          />
          <input
            ref={searchBox}
            className="input"
            type="search"
            value={search}
            placeholder={t('queue.filterPlaceholder')}
            aria-label={t('queue.filterAria')}
            spellCheck={false}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setSearch('');
                event.currentTarget.blur();
              }
            }}
            style={{ width: 210, paddingLeft: 26 }}
          />
        </label>

        <select
          className="select"
          value={videoFilter}
          aria-label={t('queue.video.aria')}
          onChange={(event) => setVideoFilter(event.currentTarget.value as VideoFilter)}
        >
          {videoOptions(t).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <Tooltip label={t('queue.duplicates.hint')} detail={t('queue.duplicates.detail')}>
          <Checkbox
            checked={onlyDuplicates}
            onChange={setOnlyDuplicates}
            label={t('queue.duplicates')}
          />
        </Tooltip>

        <div className="toolbar__spacer" />

        {checking && (
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            <Spinner />
            {t('queue.checking', { done: checkProgress.done, total: checkProgress.total })}
          </span>
        )}

        <Tooltip label={t('queue.checkVideos.hint')} detail={t('queue.checkVideos.detail')}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void checkVideos(true)}
            disabled={checking || total === 0}
          >
            <Video size={13} />
            {t('queue.checkVideos')}
          </button>
        </Tooltip>

        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setFastReview(true)}
          disabled={runs.length === 0}
          title={t('queue.fastReviewHint')}
        >
          <Zap size={13} />
          {t('queue.fastReview')}
        </button>

        <button
          type="button"
          className="btn btn--sm btn--icon"
          onClick={(event) => openToolbarMenu(event, columnMenu())}
          title={t('queue.columns')}
          aria-label={t('queue.columns')}
        >
          <Columns3 size={13} />
        </button>

        <button
          type="button"
          className="btn btn--sm btn--icon"
          onClick={(event) => openToolbarMenu(event, exportMenu())}
          title={t('queue.export')}
          aria-label={t('queue.export')}
          disabled={exporting}
        >
          {exporting ? <Spinner /> : <Download size={13} />}
        </button>

        <Tooltip label={t('queue.reset.hint')} detail={t('queue.reset.detail')}>
          <button
            type="button"
            className="btn btn--sm btn--icon"
            onClick={() => void resetFilter()}
            aria-label={t('queue.reset')}
          >
            <RotateCcw size={13} />
          </button>
        </Tooltip>
      </div>

      {truncated && (
        <div style={{ padding: '10px 12px 0' }}>
          <div className="notice notice--unknown">
            <Filter size={15} />
            <span>{t('queue.truncated', { count: formatNumber(total) })}</span>
          </div>
        </div>
      )}

      <div className="split" ref={containerRef}>
        <div
          className="split__pane"
          style={
            detailRunId
              ? { flex: `0 0 ${(fraction * 100).toFixed(2)}%` }
              : { flex: '1 1 100%' }
          }
        >
          {error ? (
            <div className="page">
              <ErrorState message={error} onRetry={() => void load(true)} />
            </div>
          ) : loading && total === 0 ? (
            <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
              <div className="col" style={{ alignItems: 'center', gap: 12 }}>
                <Spinner size="lg" accent />
                <span className="muted">{t('queue.loading')}</span>
              </div>
            </div>
          ) : runs.length === 0 ? (
            <div className="page">
              <EmptyState
                icon={<Inbox size={26} />}
                title={total === 0 ? t('queue.empty') : t('queue.noMatch')}
                hint={
                  total === 0
                    ? t('queue.emptyHint')
                    : t('queue.noMatchHint', { count: formatNumber(total) })
                }
                action={
                  total > 0 ? (
                    <button type="button" className="btn" onClick={() => void resetFilter()}>
                      {t('queue.clearFilters')}
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={() => void load(true)}>
                      {t('common.refresh')}
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <QueueTable
              runs={runs}
              onOpen={(run) => openDetail(run.id)}
              onContextMenu={(event, _run, entries) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, entries });
              }}
              onReject={(run) => setRejecting([run])}
            />
          )}

          {bulk && <BulkProgressBar />}

          {selectionSize > 0 && !bulk && (
            <div className="bulkbar">
              <span className="bulkbar__count">
                {t('queue.bulk.selected', { runs: plural(selectionSize, 'run') })}
              </span>

              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => void bulkAction('verify', selectedRuns())}
              >
                <Check size={13} />
                {t('queue.bulk.verifyAll')}
              </button>

              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setRejecting(selectedRuns())}
              >
                <Ban size={13} />
                {t('queue.bulk.rejectAll')}
              </button>

              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => void bulkAction('delete', selectedRuns())}
                title={t('queue.bulk.deleteHint')}
              >
                <Trash2 size={13} />
                {t('queue.bulk.deleteAll')}
              </button>

              <div className="toolbar__divider" />

              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  const ids = selectedRuns()
                    .map((run) => run.id)
                    .join('\n');
                  void copyToClipboard(ids, t('queue.bulk.idsCopied', { count: selectionSize }));
                }}
                title={t('queue.bulk.copyIdsHint')}
              >
                <Copy size={13} />
                {t('queue.bulk.copyIds')}
              </button>

              <div className="toolbar__spacer" />

              <button type="button" className="btn btn--sm btn--ghost" onClick={clearSelection}>
                <X size={13} />
                {t('common.clear')}
              </button>
            </div>
          )}
        </div>

        {detailRunId && (
          <>
            <div className="split__handle" {...handleProps} />
            <div className="split__pane" style={{ flex: '1 1 0' }}>
              <RunDetailPanel
                runId={detailRunId}
                onClose={closeDetail}
                onReject={(run) => setRejecting([run])}
                onAdvance={() => {
                  const next = useQueue.getState().move(1);
                  if (next) openDetail(next.id);
                  else closeDetail();
                }}
              />
            </div>
          </>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}

      {rejecting && (
        <RejectDialog
          runs={rejecting}
          onCancel={() => setRejecting(null)}
          onSubmit={(reason) => {
            const targets = rejecting;
            setRejecting(null);
            if (targets.length === 1) {
              const only = targets[0];
              if (only) void useModeration.getState().reject(only, reason);
            } else {
              void bulkAction('reject', targets, reason);
            }
          }}
        />
      )}

      {/* Kept mounted so the retry list survives the bulk bar disappearing. */}
      {bulk?.finished && bulk.failures.length > 0 && (
        <FailureReport
          onRetry={() => void retryFailures()}
          onDismiss={dismissBulk}
          onCopy={() => void copyToClipboard(failureSummary(bulk), t('bulk.failureListCopied'))}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- bulk */

/**
 * Catalogue keys per action, in progress and once finished.
 *
 * Whole sentences rather than a verb the code conjugates: "Verifying" +
 * " 3/10" happens to work in English and falls apart everywhere else, where
 * the count governs the ending of the verb and the noun both.
 */
const ACTION_KEYS = {
  verify: { running: 'bulk.progress.verify', done: 'bulk.progress.verifyDone', failed: 'bulk.failed.verify' },
  reject: { running: 'bulk.progress.reject', done: 'bulk.progress.rejectDone', failed: 'bulk.failed.reject' },
  delete: { running: 'bulk.progress.delete', done: 'bulk.progress.deleteDone', failed: 'bulk.failed.delete' },
} as const satisfies Record<string, Record<string, TranslationKey>>;

/** Live progress for a running batch, and the outcome once it finishes. */
function BulkProgressBar() {
  const t = useT();
  const bulk = useModeration((state) => state.bulk);
  const cancelBulk = useModeration((state) => state.cancelBulk);
  const dismissBulk = useModeration((state) => state.dismissBulk);
  if (!bulk) return null;

  const keys = ACTION_KEYS[bulk.action];

  return (
    <div className="bulkbar">
      <span className="bulkbar__count">
        {t(bulk.finished ? keys.done : keys.running, {
          done: bulk.completed,
          total: bulk.total,
        })}
      </span>

      <div style={{ flex: 1, minWidth: 120, maxWidth: 320 }}>
        <ProgressBar
          value={bulk.completed}
          max={bulk.total}
          tone={bulk.failed > 0 ? 'warn' : bulk.finished ? 'ok' : 'accent'}
        />
      </div>

      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {t('bulk.counts', { succeeded: bulk.succeeded, failed: bulk.failed })}
      </span>

      <div className="toolbar__spacer" />

      {!bulk.finished ? (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void cancelBulk()}
          disabled={bulk.cancelling}
        >
          {bulk.cancelling ? <Spinner /> : <SkipForward size={13} />}
          {bulk.cancelling ? t('bulk.stopping') : t('bulk.stopAfter')}
        </button>
      ) : (
        <button type="button" className="btn btn--sm btn--ghost" onClick={dismissBulk}>
          <X size={13} />
          {t('common.dismiss')}
        </button>
      )}
    </div>
  );
}

/**
 * What failed, and why.
 *
 * Retrying only the failures matters: re-running the whole batch would issue
 * another verify for every run that already succeeded.
 */
function FailureReport({
  onRetry,
  onDismiss,
  onCopy,
}: {
  onRetry: () => void;
  onDismiss: () => void;
  onCopy: () => void;
}) {
  const t = useT();
  const bulk = useModeration((state) => state.bulk);
  if (!bulk) return null;

  const retryable = bulk.failures.filter((failure) => failure.retryable).length;

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <div className="notice notice--warn" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="row">
          <Ban size={15} />
          <strong style={{ fontSize: 'var(--text-sm)' }}>
            {t(ACTION_KEYS[bulk.action].failed, {
              runs: plural(bulk.failures.length, 'run'),
            })}
          </strong>
          <div className="toolbar__spacer" />
          <button type="button" className="btn btn--sm" onClick={onCopy}>
            <Copy size={13} />
            {t('bulk.copyDetails')}
          </button>
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            <RotateCcw size={13} />
            {retryable > 0 ? t('bulk.retryCount', { count: retryable }) : t('bulk.retry')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={onDismiss}
            aria-label={t('common.dismiss')}
          >
            <X size={13} />
          </button>
        </div>
        <ul
          className="col"
          style={{ gap: 4, margin: 0, paddingLeft: 24, maxHeight: 132, overflowY: 'auto' }}
        >
          {bulk.failures.map((failure) => (
            <li key={failure.runId} style={{ fontSize: 'var(--text-xs)' }} data-selectable>
              <span className="mono">{failure.runId}</span> — {failure.error}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
