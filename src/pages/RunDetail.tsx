/**
 * The run inspection panel.
 *
 * This is the screen a moderator makes a decision on, so its whole design is
 * about keeping three things apart and never letting them blur:
 *
 *   - **Confirmed data** — what Speedrun.com and the video providers actually
 *     said. Rendered plainly.
 *   - **Absent data** — an em dash. Never a zero, never a guess, never a blank
 *     that could be read as "none".
 *   - **Heuristic flags** — the analysis findings. Always labelled with their
 *     confidence, always worded as something to look at rather than something
 *     that is wrong.
 *
 * Rules, comments and video titles are attacker-controlled text from public
 * submissions. Everything here renders them as text nodes; there is no
 * `dangerouslySetInnerHTML` anywhere in this file, and links are opened through
 * `openExternal`, which refuses anything that is not http(s).
 */

import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Flag,
  Gamepad2,
  Info,
  ListChecks,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  Video,
  X,
} from 'lucide-react';

import {
  Absent,
  Badge,
  EmptyState,
  ErrorState,
  Maybe,
  Skeleton,
  Spinner,
  Tooltip,
} from '../components/ui';
import {
  ABSENT,
  confidenceLabel,
  confidenceMeaning,
  confidenceTone,
  formatClock,
  formatDate,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  isSafeExternalUrl,
  plural,
  recommendationInfo,
  runStatusLabel,
  runStatusTone,
  severityLabel,
  severityTone,
  urlHost,
  videoStatusInfo,
} from '../format';
import { embedFor } from '../embed';
import { useT } from '../i18n';
import { copyToClipboard, openExternal } from '../open';
import { useDetail } from '../store/detail';
import { useModeration } from '../store/moderation';
import { useSession } from '../store/session';
import type {
  CategoryInfo,
  Finding,
  GameInfo,
  LeaderboardEntry,
  RunDetail,
  RunSummary,
  RunnerHistorySummary,
  VideoCheck,
} from '../types';

interface RunDetailPanelProps {
  runId: string;
  onClose: () => void;
  /** The parent owns the rejection dialog, because it also serves bulk rejects. */
  onReject: (run: RunSummary) => void;
  /** Called after an action removes this run, to move to the next one. */
  onAdvance: () => void;
}

export function RunDetailPanel({ runId, onClose, onReject, onAdvance }: RunDetailPanelProps) {
  const detail = useDetail((state) => state.detail);
  const openedId = useDetail((state) => state.runId);
  const loading = useDetail((state) => state.loading);
  const error = useDetail((state) => state.error);
  const open = useDetail((state) => state.open);
  const refresh = useDetail((state) => state.refresh);

  const busy = useModeration((state) => state.busy.has(runId));
  const t = useT();

  useEffect(() => {
    void open(runId);
  }, [runId, open]);

  // `openedId` lags `runId` for one render after the panel is pointed at another
  // run; showing the previous run's data in that gap would be actively
  // misleading, so it counts as loading.
  const settling = openedId !== runId;

  if (error && !settling) {
    return (
      <div className="detail">
        <PanelHeader onClose={onClose} />
        <div className="detail__body">
          <ErrorState
            title={t('detail.loadFailed')}
            message={error}
            onRetry={() => void refresh()}
          />
        </div>
      </div>
    );
  }

  // A detail object for a *different* run is worse than no detail at all, so it
  // shows the skeleton rather than another run's evidence under this heading.
  if (!detail || settling || detail.run.id !== runId) {
    return (
      <div className="detail">
        <PanelHeader onClose={onClose} />
        <div className="detail__body">
          <Skeleton width="70%" height={18} />
          <Skeleton width="40%" height={12} />
          <div className="col" style={{ gap: 8 }}>
            <Skeleton height={64} radius={8} />
            <Skeleton height={92} radius={8} />
            <Skeleton height={120} radius={8} />
          </div>
        </div>
      </div>
    );
  }

  const run = detail.run;

  return (
    <div className="detail">
      <header className="detail__header">
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="detail__title">
              <Maybe value={run.gameName} title={t('detail.noGameName')} />
            </div>
            <div className="detail__meta">
              <Badge tone={runStatusTone(run.status)} small dot>
                {runStatusLabel(run.status)}
              </Badge>
              <span>
                <Maybe value={run.categoryName} />
                {run.levelName && <span className="dim"> · {run.levelName}</span>}
              </span>
              <span className="dim">·</span>
              <span>{run.playerLabel}</span>
              {run.primaryDisplay && (
                <>
                  <span className="dim">·</span>
                  <span className="num">{run.primaryDisplay}</span>
                </>
              )}
            </div>
          </div>

          <div className="row" style={{ gap: 4, flexShrink: 0 }}>
            <Tooltip label={t('detail.reload')} detail={t('detail.reloadHint')}>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void refresh()}
                disabled={loading}
                aria-label={t('detail.reload')}
              >
                {loading ? <Spinner /> : <RefreshCw size={13} />}
              </button>
            </Tooltip>
            <Tooltip label={t('action.openOnSrc')}>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void openExternal(run.weblink)}
                disabled={!run.weblink}
                aria-label={t('action.openOnSrc')}
              >
                <ExternalLink size={13} />
              </button>
            </Tooltip>
            <button
              type="button"
              className="btn btn--sm btn--ghost btn--icon"
              onClick={onClose}
              aria-label={t('detail.close')}
              title={t('detail.closeEsc')}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      </header>

      <div className="detail__body">
        {detail.priorAction && (
          <div className="notice notice--warn">
            <Flag size={15} />
            <span>{detail.priorAction}</span>
          </div>
        )}

        <AnalysisSection detail={detail} />
        <VideoSection run={run} checks={detail.videoChecks} />
        <FactsSection run={run} />
        <RulesSection game={detail.game} category={detail.category} />
        <RunnerSection history={detail.runnerHistory} currentRunId={run.id} />
        <LeaderboardSection
          entries={detail.leaderboard}
          error={detail.leaderboardError}
          currentRunId={run.id}
        />
      </div>

      <footer className="detail__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy}
          onClick={() => {
            void useModeration
              .getState()
              .verify(run)
              .then((done) => {
                if (done) onAdvance();
              });
          }}
        >
          {busy ? <Spinner /> : <Check size={13} />}
          {t('action.verify')}
        </button>

        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => onReject(run)}
        >
          <Ban size={13} />
          {t('detail.reject')}
        </button>

        <div className="toolbar__spacer" />

        <Tooltip label={t('detail.copyId')} detail={t('detail.copyIdHint')}>
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={() => void copyToClipboard(run.id, t('queue.row.idCopied'))}
            aria-label={t('detail.copyId')}
          >
            <Copy size={13} />
          </button>
        </Tooltip>

        <Tooltip label={t('detail.deleteTooltip')} detail={t('detail.deleteHint')}>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            onClick={() => {
              void useModeration
                .getState()
                .remove(run)
                .then((done) => {
                  if (done) onAdvance();
                });
            }}
          >
            <Trash2 size={13} />
            {t('detail.delete')}
          </button>
        </Tooltip>
      </footer>
    </div>
  );
}

/** Header shown while the run itself is not available yet. */
function PanelHeader({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <header className="detail__header">
      <div className="row">
        <span className="muted" style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
          {t('detail.title')}
        </span>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={onClose}
          aria-label={t('detail.close')}
        >
          <X size={13} />
        </button>
      </div>
    </header>
  );
}

function Section({
  icon,
  title,
  actions,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="section__title">
        {icon}
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- analysis */

/**
 * Automated checks.
 *
 * The wording throughout is deliberate: findings are *flags*, and the panel says
 * so in the header rather than relying on the moderator to remember. There is no
 * "recommended action" anywhere, because the engine has no such output.
 */
function AnalysisSection({ detail }: { detail: RunDetail }) {
  const t = useT();
  const expandAnalysis = useSession((state) => state.settings.expandAnalysis);
  const analysis = detail.analysis;
  const info = recommendationInfo(analysis.recommendation);

  // Counted nouns, not a label plus an "s": Russian and Ukrainian pick between
  // three endings on the last digits, so the whole phrase has to come from the
  // plural catalogue.
  const counts: Array<['critical' | 'warning' | 'note', number]> = [
    ['critical', analysis.criticalCount],
    ['warning', analysis.warningCount],
    ['note', analysis.infoCount],
  ];

  return (
    <Section
      icon={<Sparkles size={13} />}
      title={t('detail.analysis.title')}
      actions={
        <span className="row" style={{ gap: 6 }}>
          {counts
            .filter(([, count]) => count > 0)
            .map(([noun, count]) => (
              <Badge
                key={noun}
                small
                tone={noun === 'critical' ? 'danger' : noun === 'warning' ? 'warn' : 'info'}
              >
                {plural(count, noun)}
              </Badge>
            ))}
        </span>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <div
          className={
            info.tone === 'ok'
              ? 'notice'
              : info.tone === 'warn'
                ? 'notice notice--warn'
                : 'notice notice--unknown'
          }
        >
          <ListChecks size={15} />
          <span>
            <strong>{info.label}.</strong> {info.detail}
          </span>
        </div>

        {analysis.findings.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {t('detail.analysis.noFindings')}
          </p>
        ) : (
          <details open={expandAnalysis}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                marginBottom: 8,
                listStyle: 'none',
              }}
            >
              {t('detail.analysis.findingsSummary', {
                findings: plural(analysis.findings.length, 'finding'),
              })}
            </summary>
            <div className="col" style={{ gap: 7 }}>
              {analysis.findings.map((finding) => (
                <FindingRow key={`${finding.id}-${finding.title}`} finding={finding} />
              ))}
            </div>
          </details>
        )}

        {analysis.hasUnverifiable && (
          <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {t('detail.analysis.unverifiable')}
          </p>
        )}
      </div>
    </Section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className={`finding finding--${finding.severity}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="finding__title">
          <span>{finding.title}</span>
          <Badge tone={severityTone(finding.severity)} small outline>
            {severityLabel(finding.severity)}
          </Badge>
          <Tooltip
            label={confidenceLabel(finding.confidence)}
            detail={confidenceMeaning(finding.confidence)}
          >
            <Badge tone={confidenceTone(finding.confidence)} small>
              {confidenceLabel(finding.confidence)}
            </Badge>
          </Tooltip>
        </div>
        <div className="finding__detail">{finding.detail}</div>
        {finding.suggestion && <div className="finding__suggestion">{finding.suggestion}</div>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- videos */

function VideoSection({ run, checks }: { run: RunSummary; checks: VideoCheck[] }) {
  const t = useT();
  const expanded = useDetail((state) => state.expandedVideos);
  const setExpanded = useDetail((state) => state.setExpandedVideos);
  const rechecking = useDetail((state) => state.rechecking);
  const recheck = useDetail((state) => state.recheck);

  return (
    <Section
      icon={<Video size={13} />}
      title={t('detail.video.title')}
      actions={
        run.videoUrls.length > 0 ? (
          <span className="row" style={{ gap: 4 }}>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? t('detail.video.hideDetails') : t('detail.video.showDetails')}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? t('detail.video.less') : t('detail.video.more')}
            </button>
            <Tooltip
              label={t('detail.video.checkAgain')}
              detail={t('detail.video.checkAgainHint')}
            >
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void recheck()}
                disabled={rechecking}
                aria-label={t('detail.video.checkAgainAria')}
              >
                {rechecking ? <Spinner /> : <RefreshCw size={12} />}
              </button>
            </Tooltip>
          </span>
        ) : undefined
      }
    >
      {run.videoUrls.length === 0 ? (
        <div className="notice notice--unknown">
          <Info size={15} />
          {/* The runner's own words are quoted inside the sentence, so the whole
              notice is selectable rather than just the quotation. */}
          <span data-selectable>
            {run.videoText
              ? t('detail.video.noLinkWithText', { text: run.videoText })
              : t('detail.video.noLink')}
          </span>
        </div>
      ) : checks.length === 0 ? (
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>
            {t('detail.video.notCheckedYet', {
              links: plural(run.videoUrls.length, 'link'),
            })}
          </span>
        </div>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {checks.map((check) => (
            <VideoItem key={check.url} check={check} expanded={expanded} runSeconds={run.primarySeconds} />
          ))}
        </div>
      )}
    </Section>
  );
}

function VideoItem({
  check,
  expanded,
  runSeconds,
}: {
  check: VideoCheck;
  expanded: boolean;
  runSeconds: number | null;
}) {
  const t = useT();
  const info = videoStatusInfo(check.status);
  const meta = check.metadata;

  // The player is opt-in per video. Framing every one of them on open would
  // start several third-party players at once on a run with mirrors, and a
  // moderator who only needs the verdict never wanted any of them.
  const [playing, setPlaying] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);
  const embed = embedFor(check.platform, check.videoId);

  // Thumbnails come from the provider, so the URL is not ours. The app's CSP
  // allows images over https only; anything else would render as a broken box,
  // so it is dropped rather than shown.
  const thumbnail =
    meta.thumbnailUrl !== null &&
    isSafeExternalUrl(meta.thumbnailUrl) &&
    meta.thumbnailUrl.startsWith('https://')
      ? meta.thumbnailUrl
      : null;

  return (
    <div className="video-item">
      <div className="video-item__head">
        <Tooltip label={info.label} detail={info.meaning}>
          <Badge tone={info.tone} small dot>
            {info.label}
          </Badge>
        </Tooltip>
        <span className="video-item__url" title={check.url} data-selectable>
          {urlHost(check.url)}
        </span>
        {check.fromCache && (
          <Tooltip
            label={t('detail.video.cached')}
            detail={t('detail.video.cachedHint', { when: formatRelative(check.checkedAt) })}
          >
            <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
              {t('detail.video.cachedBadge')}
            </span>
          </Tooltip>
        )}
        {embed === null ? (
          <Tooltip label={t('video.noEmbed')} detail={t('video.noEmbedHint')}>
            <button type="button" className="btn btn--sm btn--ghost" disabled>
              <Play size={12} />
              {t('video.watch')}
            </button>
          </Tooltip>
        ) : (
          <Tooltip
            label={playing ? t('video.hide') : t('video.watch')}
            detail={t('video.watchHint', { provider: embed.provider })}
          >
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-pressed={playing}
              onClick={() => {
                // A retry after a refused frame is worth allowing: the first
                // failure may have been the network rather than the provider.
                setPlayerFailed(false);
                setPlaying((open) => !open);
              }}
            >
              {playing ? <X size={12} /> : <Play size={12} />}
              {playing ? t('video.hide') : t('video.watch')}
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void copyToClipboard(check.url, t('detail.video.linkCopied'))}
          aria-label={t('video.copyLink')}
          title={t('video.copyLink')}
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => void openExternal(check.url)}
          aria-label={t('video.openExternal')}
          title={t('video.openExternal')}
        >
          <ExternalLink size={12} />
        </button>
      </div>

      {playing && embed !== null && (
        <div className="video-item__player">
          {playerFailed ? (
            <div className="notice notice--unknown" style={{ margin: 0 }}>
              <Info size={15} />
              <span>
                <strong>{t('video.playerFailed')}</strong> {t('video.playerFailedHint')}
              </span>
            </div>
          ) : (
            <iframe
              // Re-mounts on retry, so a second press actually re-requests the
              // player rather than showing the frame that already failed.
              key={embed.url}
              className="video-item__frame"
              src={embed.url}
              title={t('detail.video.playerTitle', { provider: embed.provider })}
              // No `allow-same-origin`: the player runs with no access to this
              // app's origin, which is what makes framing a third-party page
              // acceptable at all. `allow-presentation` covers casting.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-presentation"
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              onError={() => setPlayerFailed(true)}
            />
          )}
        </div>
      )}

      <div className="video-item__detail">{check.detail}</div>

      {expanded && (
        <div className="video-item__detail" style={{ paddingTop: 0 }}>
          <div className="dl">
            <span className="dl__key">{t('detail.video.titleField')}</span>
            <span className="dl__val">
              <Maybe value={meta.title} title={t('detail.video.noTitle')} />
            </span>
            <span className="dl__key">{t('detail.video.channel')}</span>
            <span className="dl__val">
              <Maybe value={meta.channel} title={t('detail.video.noChannel')} />
            </span>
            <span className="dl__key">{t('detail.video.length')}</span>
            <span className="dl__val">
              {meta.durationSeconds === null ? (
                <Absent title={t('detail.video.noDuration')} />
              ) : (
                <>
                  <span className="num">{formatClock(meta.durationSeconds)}</span>
                  {runSeconds !== null && meta.durationSeconds + 1 < runSeconds && (
                    <Tooltip
                      label={t('detail.video.shorter')}
                      detail={t('detail.video.shorterHint')}
                    >
                      <span style={{ marginLeft: 6 }}>
                        <Badge tone="warn" small>
                          {t('detail.video.shorterBadge')}
                        </Badge>
                      </span>
                    </Tooltip>
                  )}
                </>
              )}
            </span>
            <span className="dl__key">{t('detail.video.uploaded')}</span>
            <span className="dl__val">
              {meta.uploadDate === null ? (
                <Absent title={t('detail.video.noUploadDate')} />
              ) : (
                formatDate(meta.uploadDate)
              )}
            </span>
            <span className="dl__key">{t('detail.video.checked')}</span>
            <span className="dl__val">{formatDateTime(check.checkedAt)}</span>
          </div>
        </div>
      )}

      {expanded && thumbnail && (
        <img
          className="video-item__thumb"
          src={thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ facts */

/** What Speedrun.com actually holds about the run. No interpretation. */
function FactsSection({ run }: { run: RunSummary }) {
  const t = useT();
  const subcategories = run.variableLabels.filter((value) => value.isSubcategory);
  const others = run.variableLabels.filter((value) => !value.isSubcategory);

  return (
    <Section icon={<Clock size={13} />} title={t('detail.facts.title')}>
      <div className="dl">
        <span className="dl__key">{t('queue.col.time')}</span>
        <span className="dl__val num">
          {run.primaryDisplay ?? (run.primarySeconds === null ? <Absent /> : formatDuration(run.primarySeconds))}
        </span>

        <span className="dl__key">{t('detail.facts.played')}</span>
        <span className="dl__val">
          {run.date === null ? (
            <Absent title={t('detail.facts.noPlayDate')} />
          ) : (
            formatDate(run.date)
          )}
        </span>

        <span className="dl__key">{t('queue.col.submitted')}</span>
        <span className="dl__val">
          {run.submitted === null ? (
            <Absent title={t('detail.facts.noSubmitTime')} />
          ) : (
            <>
              {formatDateTime(run.submitted)}{' '}
              <span className="dim">({formatRelative(run.submitted)})</span>
            </>
          )}
        </span>

        <span className="dl__key">{t('queue.col.runner')}</span>
        <span className="dl__val">
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {run.players.length === 0 ? (
              <span>{run.playerLabel}</span>
            ) : (
              run.players.map((player, index) => (
                <span key={`${player.name}-${index}`} className="row" style={{ gap: 4 }}>
                  {player.weblink ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ height: 20, padding: '0 5px' }}
                      onClick={() => void openExternal(player.weblink)}
                    >
                      {player.name}
                      <ExternalLink size={10} />
                    </button>
                  ) : (
                    <span>{player.name}</span>
                  )}
                  {player.kind === 'guest' && (
                    <Tooltip
                      label={t('detail.facts.guest')}
                      detail={t('detail.facts.guestHint')}
                    >
                      <Badge tone="unknown" small>
                        {t('detail.facts.guestBadge')}
                      </Badge>
                    </Tooltip>
                  )}
                </span>
              ))
            )}
          </span>
        </span>

        <span className="dl__key">{t('detail.facts.platform')}</span>
        <span className="dl__val">
          <Maybe value={run.platformName} title={t('detail.facts.noPlatform')} />
        </span>

        <span className="dl__key">{t('detail.facts.region')}</span>
        <span className="dl__val">
          <Maybe value={run.regionName} title={t('detail.facts.noRegion')} />
        </span>

        <span className="dl__key">{t('detail.facts.emulator')}</span>
        <span className="dl__val">
          {run.emulated === null ? (
            <Absent title={t('detail.facts.noEmulator')} />
          ) : run.emulated ? (
            <Badge tone="warn" small>
              {t('detail.facts.emulated')}
            </Badge>
          ) : (
            t('common.no')
          )}
        </span>

        {subcategories.length > 0 && (
          <>
            <span className="dl__key">{t('detail.facts.subcategory')}</span>
            <span className="dl__val">
              {subcategories
                .map((value) => value.valueLabel ?? value.valueId)
                .join(' · ')}
            </span>
          </>
        )}

        {others.map((value) => (
          <ValueRow key={value.variableId} label={value.variableName} value={value.valueLabel} />
        ))}

        <span className="dl__key">{t('detail.facts.runId')}</span>
        <span className="dl__val mono" data-selectable>
          {run.id}
        </span>
      </div>

      {run.comment && (
        <div style={{ marginTop: 10 }}>
          <div className="section__title" style={{ marginBottom: 6 }}>
            <Info size={12} />
            {t('detail.facts.comment')}
          </div>
          <div className="rules" data-selectable>
            {run.comment}
          </div>
        </div>
      )}

      {run.rejectionReason && (
        <div className="notice notice--danger" style={{ marginTop: 10 }}>
          <Ban size={15} />
          <span data-selectable>
            {t('detail.facts.previouslyRejected', { reason: run.rejectionReason })}
          </span>
        </div>
      )}
    </Section>
  );
}

/** One variable row; a null label means the API gave an id without a name. */
function ValueRow({ label, value }: { label: string; value: string | null }) {
  const t = useT();
  return (
    <>
      <span className="dl__key">{label}</span>
      <span className="dl__val">
        <Maybe value={value} title={t('detail.facts.unlabelledValue')} />
      </span>
    </>
  );
}

/* ------------------------------------------------------------------ rules */

function RulesSection({
  game,
  category,
}: {
  game: GameInfo | null;
  category: CategoryInfo | null;
}) {
  const t = useT();

  if (!game && !category) {
    return (
      <Section icon={<Gamepad2 size={13} />} title={t('detail.rules.title')}>
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>{t('detail.rules.unavailable')}</span>
        </div>
      </Section>
    );
  }

  return (
    <Section
      icon={<Gamepad2 size={13} />}
      title={t('detail.rules.title')}
      actions={
        game?.weblink ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void openExternal(game.weblink)}
          >
            {t('detail.rules.gamePage')}
            <ExternalLink size={11} />
          </button>
        ) : undefined
      }
    >
      <div className="col" style={{ gap: 10 }}>
        {game && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <RuleFlag
              label={t('detail.rules.videoRequired')}
              value={game.requireVideo}
              yes={t('detail.rules.videoYes')}
              no={t('detail.rules.videoNo')}
            />
            <RuleFlag
              label={t('detail.rules.emulators')}
              value={game.emulatorsAllowed}
              yes={t('detail.rules.emulatorsYes')}
              no={t('detail.rules.emulatorsNo')}
              invert
            />
            <RuleFlag
              label={t('detail.rules.verification')}
              value={game.requireVerification}
              yes={t('detail.rules.verificationYes')}
              no={t('detail.rules.verificationNo')}
            />
            {game.releaseDate && (
              <Badge tone="neutral" small>
                {t('detail.rules.released', { date: formatDate(game.releaseDate) })}
              </Badge>
            )}
          </div>
        )}

        {category?.rules ? (
          <div>
            <div className="section__title" style={{ marginBottom: 6 }}>
              <ListChecks size={12} />
              {category.name}
            </div>
            {/* Plain text from the API, rendered as text. Never as HTML. */}
            <div className="rules" data-selectable>
              {category.rules}
            </div>
          </div>
        ) : (
          <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {category ? t('detail.rules.noRules') : t('detail.rules.noCategory')}
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * A tri-state rule flag.
 *
 * `null` renders as "not stated" rather than as a "no": a game that never set
 * the option is not the same as a game that turned it off.
 */
function RuleFlag({
  label,
  value,
  yes,
  no,
  invert = false,
}: {
  label: string;
  value: boolean | null;
  yes: string;
  no: string;
  invert?: boolean;
}) {
  const t = useT();

  if (value === null) {
    return (
      <Tooltip
        label={t('detail.rules.flagNotStated', { label })}
        detail={t('detail.rules.flagNotStatedHint')}
      >
        <Badge tone="unknown" small>
          {label}: <span className="absent">{ABSENT}</span>
        </Badge>
      </Tooltip>
    );
  }
  const positive = invert ? !value : value;
  return (
    <Tooltip label={value ? yes : no}>
      <Badge tone={positive ? 'ok' : 'neutral'} small>
        {value ? yes : no}
      </Badge>
    </Tooltip>
  );
}

/* ----------------------------------------------------------------- runner */

function RunnerSection({
  history,
  currentRunId,
}: {
  history: RunnerHistorySummary | null;
  currentRunId: string;
}) {
  const t = useT();

  if (!history) {
    return (
      <Section icon={<Users size={13} />} title={t('detail.runner.title')}>
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>{t('detail.runner.noHistory')}</span>
        </div>
      </Section>
    );
  }

  if (history.error) {
    return (
      <Section icon={<Users size={13} />} title={t('detail.runner.title')}>
        <div className="notice notice--unknown">
          <Info size={15} />
          <span data-selectable>
            {t('detail.runner.loadFailed', {
              name: history.displayName,
              error: history.error,
            })}
          </span>
        </div>
      </Section>
    );
  }

  const previous = history.runs.filter((run) => run.id !== currentRunId);
  const improvement = history.improvementPercent;

  return (
    <Section
      icon={<Users size={13} />}
      title={t('detail.runner.title')}
      actions={
        history.weblink ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void openExternal(history.weblink)}
          >
            {t('detail.runner.profile')}
            <ExternalLink size={11} />
          </button>
        ) : undefined
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="dl">
          <span className="dl__key">{t('queue.col.runner')}</span>
          <span className="dl__val">{history.displayName}</span>
          <span className="dl__key">{t('detail.runner.onRecord')}</span>
          <span className="dl__val">
            {t('detail.runner.recordSummary', {
              runs: plural(history.totalRuns, 'run'),
              verified: history.verifiedRuns,
              rejected: history.rejectedRuns,
            })}
          </span>
          <span className="dl__key">{t('detail.runner.memberSince')}</span>
          <span className="dl__val">
            {history.signupDate === null ? <Absent /> : formatDate(history.signupDate)}
          </span>
          <span className="dl__key">{t('detail.runner.previousBest')}</span>
          <span className="dl__val num">
            <Maybe
              value={history.previousBestDisplay}
              title={t('detail.runner.noPreviousBest')}
            />
          </span>
        </div>

        {improvement !== null && (
          <div className={improvement >= 25 ? 'notice notice--warn' : 'notice'}>
            <Trophy size={15} />
            <span>
              {improvement >= 0
                ? t('detail.runner.faster', { percent: formatPercent(improvement) })
                : t('detail.runner.slower', {
                    percent: formatPercent(Math.abs(improvement)),
                  })}{' '}
              {improvement >= 25 && t('detail.runner.bigJump')}
            </span>
          </div>
        )}

        {previous.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            {t('detail.runner.noOtherRuns')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('queue.col.category')}</th>
                <th style={{ textAlign: 'right' }}>{t('queue.col.time')}</th>
                <th>{t('queue.col.status')}</th>
                <th>{t('queue.col.submitted')}</th>
              </tr>
            </thead>
            <tbody>
              {previous.slice(0, 8).map((run) => (
                <tr
                  key={run.id}
                  data-row-action="true"
                  onClick={() => void openExternal(run.weblink)}
                  title={t('detail.openRunOnSrc')}
                >
                  <td>
                    <Maybe value={run.categoryName} />
                    {run.levelName && <span className="dim"> · {run.levelName}</span>}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num">
                    {run.primaryDisplay ?? <Absent />}
                  </td>
                  <td>
                    <Badge tone={runStatusTone(run.status)} small>
                      {runStatusLabel(run.status)}
                    </Badge>
                  </td>
                  <td>{formatRelative(run.submitted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ leaderboard */

function LeaderboardSection({
  entries,
  error,
  currentRunId,
}: {
  entries: LeaderboardEntry[] | null;
  error: string | null;
  currentRunId: string;
}) {
  const t = useT();

  if (error) {
    return (
      <Section icon={<Trophy size={13} />} title={t('detail.leaderboard.title')}>
        <div className="notice notice--unknown">
          <Info size={15} />
          <span data-selectable>{t('detail.leaderboard.loadFailed', { error })}</span>
        </div>
      </Section>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <Section icon={<Trophy size={13} />} title={t('detail.leaderboard.title')}>
        <EmptyState
          title={t('detail.leaderboard.empty')}
          hint={t('detail.leaderboard.emptyHint')}
        />
      </Section>
    );
  }

  return (
    <Section icon={<Trophy size={13} />} title={t('detail.leaderboard.title')}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 44 }}>{t('detail.leaderboard.place')}</th>
            <th>{t('queue.col.runner')}</th>
            <th style={{ textAlign: 'right' }}>{t('queue.col.time')}</th>
            <th>{t('detail.leaderboard.date')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.runId}
              data-row-action="true"
              data-selected={entry.runId === currentRunId}
              onClick={() => void openExternal(entry.weblink)}
              title={t('detail.openRunOnSrc')}
            >
              <td className="num">{entry.place}</td>
              <td>{entry.playerLabel}</td>
              <td style={{ textAlign: 'right' }} className="num">
                {entry.display ?? formatDuration(entry.seconds)}
              </td>
              <td>{entry.date === null ? <Absent /> : formatDate(entry.date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
