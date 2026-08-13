/**
 * The virtualised queue table.
 *
 * Rows are absolutely positioned inside a spacer sized to the full list, so a
 * queue of several thousand runs costs the same number of DOM nodes as a queue
 * of twenty. The grid template is rebuilt from the visible columns rather than
 * hidden with CSS, so a hidden column takes no space at all.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Trash2,
  Video,
} from 'lucide-react';

import { Badge, Spinner, Tooltip, type MenuEntry } from '../components/ui';
import { formatRelative, plural, runStatusLabel, videoStatusInfo } from '../format';
import { t as translate, useT, type Translate } from '../i18n';
import { copyToClipboard, openExternal } from '../open';
import { useApp } from '../store/app';
import { useModeration } from '../store/moderation';
import { QUEUE_COLUMNS, useQueue, worstStatus, type QueueColumn, type SortKey } from '../store/queue';
import { useSession } from '../store/session';
import type { RunSummary, VideoStatus } from '../types';

interface QueueTableProps {
  runs: RunSummary[];
  onOpen: (run: RunSummary) => void;
  onContextMenu: (event: React.MouseEvent, run: RunSummary, entries: MenuEntry[]) => void;
  onReject: (run: RunSummary) => void;
}

export function QueueTable({ runs, onOpen, onContextMenu, onReject }: QueueTableProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);

  const selected = useQueue((state) => state.selected);
  const focusIndex = useQueue((state) => state.focusIndex);
  const sortKey = useQueue((state) => state.sortKey);
  const sortAsc = useQueue((state) => state.sortAsc);
  const sortBy = useQueue((state) => state.sortBy);
  const toggleSelect = useQueue((state) => state.toggleSelect);
  const selectRange = useQueue((state) => state.selectRange);
  const checks = useQueue((state) => state.checks);
  const duplicates = useQueue((state) => state.duplicates);

  const hidden = useSession((state) => state.settings.hiddenColumns);
  const busy = useModeration((state) => state.busy);
  const openDetail = useApp((state) => state.openDetail);

  const columns = useMemo(
    () => QUEUE_COLUMNS.filter((column) => !hidden.includes(column.id)),
    [hidden],
  );

  // 28px for the checkbox, then one track per visible column.
  const template = useMemo(
    () => `28px ${columns.map((column) => column.width).join(' ')}`,
    [columns],
  );

  const rowHeight = useSession((state) => (state.settings.density === 'compact' ? 32 : 40));

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Keyboard navigation moves `focusIndex`; the row it points at has to be on
  // screen or the moderator is acting on something they cannot see.
  useEffect(() => {
    if (focusIndex >= 0 && focusIndex < runs.length) {
      virtualizer.scrollToIndex(focusIndex, { align: 'auto' });
    }
  }, [focusIndex, runs.length, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <>
      <div className="vhead" style={{ gridTemplateColumns: template }}>
        <span className="vselect" />
        {columns.map((column) => (
          <button
            key={column.id}
            type="button"
            className="vhead__cell"
            data-sortable="true"
            style={column.align === 'right' ? { justifyContent: 'flex-end' } : undefined}
            onClick={() => sortBy(column.id)}
            title={t('queue.sortBy', { column: t(column.labelKey) })}
          >
            {t(column.labelKey)}
            <SortIcon active={sortKey === column.id} ascending={sortAsc} />
          </button>
        ))}
      </div>

      <div className="vtable" ref={scroller}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const run = runs[item.index];
            if (!run) return null;
            return (
              <Row
                key={run.id}
                run={run}
                index={item.index}
                top={item.start}
                height={item.size}
                template={template}
                columns={columns}
                status={worstStatus(checks[run.id])}
                duplicateCount={(duplicates[run.id] ?? []).length}
                selected={selected.has(run.id)}
                focused={focusIndex === item.index}
                busy={busy.has(run.id)}
                onOpen={onOpen}
                onToggle={toggleSelect}
                onRange={selectRange}
                onContextMenu={(event) =>
                  onContextMenu(event, run, rowMenu(run, () => openDetail(run.id), () => onReject(run)))
                }
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------- row */

interface RowProps {
  run: RunSummary;
  index: number;
  top: number;
  height: number;
  template: string;
  columns: readonly QueueColumn[];
  status: VideoStatus | null;
  duplicateCount: number;
  selected: boolean;
  focused: boolean;
  busy: boolean;
  onOpen: (run: RunSummary) => void;
  onToggle: (runId: string) => void;
  onRange: (runId: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

function Row({
  run,
  index,
  top,
  height,
  template,
  columns,
  status,
  duplicateCount,
  selected,
  focused,
  busy,
  onOpen,
  onToggle,
  onRange,
  onContextMenu,
}: RowProps) {
  const t = useT();
  const focus = useQueue((state) => state.focus);

  return (
    <div
      className="vrow"
      style={{ gridTemplateColumns: template, transform: `translateY(${top}px)`, height }}
      data-selected={selected}
      data-focused={focused}
      data-busy={busy}
      onClick={(event) => {
        if (event.shiftKey) {
          onRange(run.id);
          return;
        }
        focus(index);
        onOpen(run);
      }}
      onContextMenu={(event) => {
        focus(index);
        onContextMenu(event);
      }}
    >
      <span
        className="vselect"
        onClick={(event) => {
          // Selecting must not also open the run: the moderator is building a
          // bulk set, not inspecting.
          event.stopPropagation();
          if (event.shiftKey) onRange(run.id);
          else onToggle(run.id);
        }}
      >
        {busy ? (
          <Spinner />
        ) : (
          <input
            type="checkbox"
            className="checkbox"
            checked={selected}
            aria-label={t('queue.selectRun', { player: run.playerLabel })}
            onChange={() => onToggle(run.id)}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </span>

      {columns.map((column) => (
        <Cell
          key={column.id}
          column={column.id}
          align={column.align}
          run={run}
          status={status}
          duplicateCount={duplicateCount}
        />
      ))}
    </div>
  );
}

function Cell({
  column,
  align,
  run,
  status,
  duplicateCount,
}: {
  column: SortKey;
  align?: 'right';
  run: RunSummary;
  status: VideoStatus | null;
  duplicateCount: number;
}) {
  const t = useT();
  const className = align === 'right' ? 'vcell vcell--right' : 'vcell';

  switch (column) {
    case 'video':
      return (
        <span className={className}>
          <VideoBadge run={run} status={status} />
        </span>
      );

    case 'game':
      return (
        <span className={className} title={run.gameName ?? undefined}>
          {run.gameName ?? <span className="absent">—</span>}
          {duplicateCount > 0 && (
            <Tooltip
              label={t('queue.dup.label', { runs: plural(duplicateCount, 'run') })}
              detail={t('queue.dup.detail')}
            >
              <span style={{ marginLeft: 6 }}>
                <Badge tone="warn" small>
                  {t('queue.dup')}
                </Badge>
              </span>
            </Tooltip>
          )}
        </span>
      );

    case 'category':
      return (
        <span className={className}>
          <span className="vcell__stack">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {run.categoryName ?? <span className="absent">—</span>}
            </span>
            {(run.levelName || run.variableLabels.length > 0) && (
              <span className="vcell__sub">
                {[
                  run.levelName,
                  ...run.variableLabels
                    .filter((v) => v.isSubcategory)
                    .map((v) => v.valueLabel)
                    .filter((label): label is string => Boolean(label)),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </span>
        </span>
      );

    case 'player':
      return (
        <span className={className} title={run.playerLabel}>
          {run.playerLabel}
        </span>
      );

    case 'time':
      return (
        <span className={className}>
          {run.primaryDisplay ?? <span className="absent">—</span>}
        </span>
      );

    case 'submitted':
      return (
        <span className={className} title={run.submitted ?? t('queue.noSubmitDate')}>
          {formatRelative(run.submitted)}
        </span>
      );

    case 'status':
      return (
        <span className={className}>
          <Badge tone={run.status === 'new' ? 'info' : 'neutral'} small>
            {runStatusLabel(run.status)}
          </Badge>
        </span>
      );
  }
}

/**
 * The video column.
 *
 * Three distinct states, never collapsed into one: no link submitted, checked
 * with a verdict, and not checked. The last is grey, because SRCTools failing to
 * look is not a fact about the run.
 */
function VideoBadge({ run, status }: { run: RunSummary; status: VideoStatus | null }) {
  const t = useT();

  if (run.videoUrls.length === 0) {
    return (
      <Tooltip
        label={run.videoText ? t('queue.video.textOnly') : t('queue.video.missing')}
        detail={
          run.videoText
            ? t('queue.video.textOnlyHint', { text: run.videoText })
            : t('queue.video.missingHint')
        }
      >
        <Badge tone="unknown" small dot>
          {run.videoText ? t('queue.video.textBadge') : t('common.none')}
        </Badge>
      </Tooltip>
    );
  }

  if (status === null) {
    return (
      <Tooltip label={t('video.notChecked')} detail={t('queue.video.notCheckedHint')}>
        <Badge tone="unknown" small>
          —
        </Badge>
      </Tooltip>
    );
  }

  const info = videoStatusInfo(status);
  return (
    <Tooltip label={info.label} detail={info.meaning}>
      <Badge tone={info.tone} small dot>
        {info.label}
      </Badge>
    </Tooltip>
  );
}

function SortIcon({ active, ascending }: { active: boolean; ascending: boolean }) {
  if (!active) return null;
  return ascending ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
}

/**
 * Right-click entries for a run row.
 *
 * A plain function, not a component, so it reads the catalogue through the
 * store-level `translate` rather than a hook. The menu is built at the moment
 * of the click, which is late enough for that to be the current language.
 */
export function rowMenu(run: RunSummary, onInspect: () => void, onReject: () => void): MenuEntry[] {
  const t: Translate = translate;
  const moderation = useModeration.getState();
  const entries: MenuEntry[] = [
    { heading: run.gameName ?? t('queue.row.heading') },
    { label: t('queue.row.inspect'), icon: <Eye size={13} />, onSelect: onInspect, hint: 'enter' },
  ];

  if (run.videoUrls.length > 0) {
    entries.push({
      label: t('queue.row.openVideo'),
      icon: <Video size={13} />,
      onSelect: () => void openExternal(run.videoUrls[0]),
      hint: 'v',
    });
  }

  if (run.weblink) {
    entries.push({
      label: t('queue.row.openSrc'),
      icon: <ExternalLink size={13} />,
      onSelect: () => void openExternal(run.weblink),
      hint: 'o',
    });
  }

  entries.push(
    {
      label: t('queue.row.copyId'),
      icon: <Copy size={13} />,
      onSelect: () => void copyToClipboard(run.id, t('queue.row.idCopied')),
    },
    { separator: true },
    {
      label: t('queue.row.verify'),
      icon: <Check size={13} />,
      onSelect: () => void moderation.verify(run),
      hint: 'a',
    },
    { label: t('queue.row.reject'), icon: <Ban size={13} />, onSelect: onReject, hint: 'r' },
    { separator: true },
    {
      label: t('queue.row.delete'),
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => void moderation.remove(run),
    },
  );

  return entries;
}
