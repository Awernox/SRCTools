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
            title="Could not load this run"
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
              <Maybe value={run.gameName} title="Speedrun.com did not name the game" />
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
            <Tooltip label="Reload this run" detail="Re-reads the run, its rules and its videos.">
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void refresh()}
                disabled={loading}
                aria-label="Reload this run"
              >
                {loading ? <Spinner /> : <RefreshCw size={13} />}
              </button>
            </Tooltip>
            <Tooltip label="Open on Speedrun.com">
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void openExternal(run.weblink)}
                disabled={!run.weblink}
                aria-label="Open on Speedrun.com"
              >
                <ExternalLink size={13} />
              </button>
            </Tooltip>
            <button
              type="button"
              className="btn btn--sm btn--ghost btn--icon"
              onClick={onClose}
              aria-label="Close the detail panel"
              title="Close (Esc)"
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
          Verify
        </button>

        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => onReject(run)}
        >
          <Ban size={13} />
          Reject…
        </button>

        <div className="toolbar__spacer" />

        <Tooltip
          label="Copy the run id"
          detail="Useful when reporting a run to another moderator."
        >
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={() => void copyToClipboard(run.id, 'Run id copied')}
            aria-label="Copy the run id"
          >
            <Copy size={13} />
          </button>
        </Tooltip>

        <Tooltip
          label="Delete permanently"
          detail="Removes the run from Speedrun.com entirely. Rejecting is almost always the right action instead."
        >
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
            Delete…
          </button>
        </Tooltip>
      </footer>
    </div>
  );
}

/** Header shown while the run itself is not available yet. */
function PanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="detail__header">
      <div className="row">
        <span className="muted" style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
          Run detail
        </span>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={onClose}
          aria-label="Close the detail panel"
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
  const expandAnalysis = useSession((state) => state.settings.expandAnalysis);
  const analysis = detail.analysis;
  const info = recommendationInfo(analysis.recommendation);

  const counts: Array<[string, number]> = [
    ['critical', analysis.criticalCount],
    ['warning', analysis.warningCount],
    ['note', analysis.infoCount],
  ];

  return (
    <Section
      icon={<Sparkles size={13} />}
      title="Automated checks"
      actions={
        <span className="row" style={{ gap: 6 }}>
          {counts
            .filter(([, count]) => count > 0)
            .map(([label, count]) => (
              <Badge
                key={label}
                small
                tone={label === 'critical' ? 'danger' : label === 'warning' ? 'warn' : 'info'}
              >
                {count} {label}
                {count === 1 ? '' : 's'}
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
            No check raised anything. That is not a verdict either — the checks
            only cover what the API and the video providers can tell SRCTools.
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
              {plural(analysis.findings.length, 'finding')} — none of them decide anything
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
            Some checks could not run because the data they need was not
            available. Missing information is not evidence of a problem.
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
  const expanded = useDetail((state) => state.expandedVideos);
  const setExpanded = useDetail((state) => state.setExpandedVideos);
  const rechecking = useDetail((state) => state.rechecking);
  const recheck = useDetail((state) => state.recheck);

  return (
    <Section
      icon={<Video size={13} />}
      title="Video"
      actions={
        run.videoUrls.length > 0 ? (
          <span className="row" style={{ gap: 4 }}>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? 'Hide the details' : 'Show titles, durations and thumbnails'}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? 'Less' : 'More'}
            </button>
            <Tooltip
              label="Check again"
              detail="Asks the provider again, ignoring the cached answer."
            >
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--icon"
                onClick={() => void recheck()}
                disabled={rechecking}
                aria-label="Check the videos again"
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
          <span>
            {run.videoText ? (
              <>
                No video link was submitted. The runner wrote:{' '}
                <span data-selectable>“{run.videoText}”</span>. Whether that is
                acceptable depends on this game’s rules.
              </>
            ) : (
              <>
                No video was submitted with this run. Whether a video is required
                depends on this game’s rules, shown below.
              </>
            )}
          </span>
        </div>
      ) : checks.length === 0 ? (
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>
            {plural(run.videoUrls.length, 'link')} submitted, not checked yet.
            Use <em>Check again</em> above, or open them yourself.
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
            label="Cached answer"
            detail={`Checked ${formatRelative(check.checkedAt)}. Use “Check again” to ask the provider now.`}
          >
            <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
              cached
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
          onClick={() => void copyToClipboard(check.url, 'Video link copied')}
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
              title={`${embed.provider} player`}
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
            <span className="dl__key">Title</span>
            <span className="dl__val">
              <Maybe value={meta.title} title="The provider did not return a title" />
            </span>
            <span className="dl__key">Channel</span>
            <span className="dl__val">
              <Maybe value={meta.channel} title="The provider did not return a channel" />
            </span>
            <span className="dl__key">Length</span>
            <span className="dl__val">
              {meta.durationSeconds === null ? (
                <Absent title="The provider did not return a duration" />
              ) : (
                <>
                  <span className="num">{formatClock(meta.durationSeconds)}</span>
                  {runSeconds !== null && meta.durationSeconds + 1 < runSeconds && (
                    <Tooltip
                      label="Shorter than the submitted time"
                      detail="Trimmed uploads, split videos and separate load-removal footage all do this legitimately. It is a flag, not a fault."
                    >
                      <span style={{ marginLeft: 6 }}>
                        <Badge tone="warn" small>
                          shorter than the run
                        </Badge>
                      </span>
                    </Tooltip>
                  )}
                </>
              )}
            </span>
            <span className="dl__key">Uploaded</span>
            <span className="dl__val">
              {meta.uploadDate === null ? (
                <Absent title="The provider did not return an upload date" />
              ) : (
                formatDate(meta.uploadDate)
              )}
            </span>
            <span className="dl__key">Checked</span>
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
  const subcategories = run.variableLabels.filter((value) => value.isSubcategory);
  const others = run.variableLabels.filter((value) => !value.isSubcategory);

  return (
    <Section icon={<Clock size={13} />} title="Submission">
      <div className="dl">
        <span className="dl__key">Time</span>
        <span className="dl__val num">
          {run.primaryDisplay ?? (run.primarySeconds === null ? <Absent /> : formatDuration(run.primarySeconds))}
        </span>

        <span className="dl__key">Played</span>
        <span className="dl__val">
          {run.date === null ? <Absent title="No play date was given" /> : formatDate(run.date)}
        </span>

        <span className="dl__key">Submitted</span>
        <span className="dl__val">
          {run.submitted === null ? (
            <Absent title="Speedrun.com did not report a submission time" />
          ) : (
            <>
              {formatDateTime(run.submitted)}{' '}
              <span className="dim">({formatRelative(run.submitted)})</span>
            </>
          )}
        </span>

        <span className="dl__key">Runner</span>
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
                      label="Guest submission"
                      detail="This runner has no Speedrun.com account, so there is no history to compare against."
                    >
                      <Badge tone="unknown" small>
                        guest
                      </Badge>
                    </Tooltip>
                  )}
                </span>
              ))
            )}
          </span>
        </span>

        <span className="dl__key">Platform</span>
        <span className="dl__val">
          <Maybe value={run.platformName} title="No platform was recorded" />
        </span>

        <span className="dl__key">Region</span>
        <span className="dl__val">
          <Maybe value={run.regionName} title="No region was recorded" />
        </span>

        <span className="dl__key">Emulator</span>
        <span className="dl__val">
          {run.emulated === null ? (
            <Absent title="Speedrun.com did not say whether an emulator was used" />
          ) : run.emulated ? (
            <Badge tone="warn" small>
              Emulated
            </Badge>
          ) : (
            'No'
          )}
        </span>

        {subcategories.length > 0 && (
          <>
            <span className="dl__key">Subcategory</span>
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

        <span className="dl__key">Run id</span>
        <span className="dl__val mono" data-selectable>
          {run.id}
        </span>
      </div>

      {run.comment && (
        <div style={{ marginTop: 10 }}>
          <div className="section__title" style={{ marginBottom: 6 }}>
            <Info size={12} />
            Runner’s comment
          </div>
          <div className="rules" data-selectable>
            {run.comment}
          </div>
        </div>
      )}

      {run.rejectionReason && (
        <div className="notice notice--danger" style={{ marginTop: 10 }}>
          <Ban size={15} />
          <span data-selectable>Previously rejected: {run.rejectionReason}</span>
        </div>
      )}
    </Section>
  );
}

/** One variable row; a null label means the API gave an id without a name. */
function ValueRow({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <span className="dl__key">{label}</span>
      <span className="dl__val">
        <Maybe value={value} title="Speedrun.com did not label this value" />
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
  if (!game && !category) {
    return (
      <Section icon={<Gamepad2 size={13} />} title="Rules">
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>
            The game and category could not be loaded, so their rules are not
            shown. Check them on Speedrun.com before deciding.
          </span>
        </div>
      </Section>
    );
  }

  return (
    <Section
      icon={<Gamepad2 size={13} />}
      title="Rules"
      actions={
        game?.weblink ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void openExternal(game.weblink)}
          >
            Game page
            <ExternalLink size={11} />
          </button>
        ) : undefined
      }
    >
      <div className="col" style={{ gap: 10 }}>
        {game && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <RuleFlag
              label="Video required"
              value={game.requireVideo}
              yes="Videos are required"
              no="Videos are not required"
            />
            <RuleFlag
              label="Emulators"
              value={game.emulatorsAllowed}
              yes="Emulators are allowed"
              no="Emulators are not allowed"
              invert
            />
            <RuleFlag
              label="Verification"
              value={game.requireVerification}
              yes="Runs need verification"
              no="Runs are auto-verified"
            />
            {game.releaseDate && (
              <Badge tone="neutral" small>
                Released {formatDate(game.releaseDate)}
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
            {category
              ? 'This category has no written rules on Speedrun.com.'
              : 'The category for this run could not be loaded.'}
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
  if (value === null) {
    return (
      <Tooltip label={`${label}: not stated`} detail="Speedrun.com did not report this setting.">
        <Badge tone="unknown" small>
          {label}: <span className="absent">—</span>
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
  if (!history) {
    return (
      <Section icon={<Users size={13} />} title="Runner history">
        <div className="notice notice--unknown">
          <Info size={15} />
          <span>
            No history is available for this runner. Guests have no account to
            look up, so this is expected for guest submissions.
          </span>
        </div>
      </Section>
    );
  }

  if (history.error) {
    return (
      <Section icon={<Users size={13} />} title="Runner history">
        <div className="notice notice--unknown">
          <Info size={15} />
          <span data-selectable>
            {history.displayName}’s history could not be loaded: {history.error}. That
            is a fetch problem, not something about the runner.
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
      title="Runner history"
      actions={
        history.weblink ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void openExternal(history.weblink)}
          >
            Profile
            <ExternalLink size={11} />
          </button>
        ) : undefined
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="dl">
          <span className="dl__key">Runner</span>
          <span className="dl__val">{history.displayName}</span>
          <span className="dl__key">On record</span>
          <span className="dl__val">
            {plural(history.totalRuns, 'run')} — {history.verifiedRuns} verified,{' '}
            {history.rejectedRuns} rejected
          </span>
          <span className="dl__key">Member since</span>
          <span className="dl__val">
            {history.signupDate === null ? <Absent /> : formatDate(history.signupDate)}
          </span>
          <span className="dl__key">Previous best</span>
          <span className="dl__val num">
            <Maybe
              value={history.previousBestDisplay}
              title="No earlier run in this category was found"
            />
          </span>
        </div>

        {improvement !== null && (
          <div className={improvement >= 25 ? 'notice notice--warn' : 'notice'}>
            <Trophy size={15} />
            <span>
              {improvement >= 0
                ? `${formatPercent(improvement)} faster than their previous best.`
                : `${formatPercent(Math.abs(improvement))} slower than their previous best.`}{' '}
              {improvement >= 25 && (
                <>
                  A jump this large is worth watching the video for — it is also
                  exactly what a genuine breakthrough looks like.
                </>
              )}
            </span>
          </div>
        )}

        {previous.length === 0 ? (
          <p className="dim" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
            No other runs by this runner were returned. A first submission is not
            a problem in itself.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Time</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {previous.slice(0, 8).map((run) => (
                <tr
                  key={run.id}
                  data-row-action="true"
                  onClick={() => void openExternal(run.weblink)}
                  title="Open this run on Speedrun.com"
                >
                  <td>
                    <Maybe value={run.categoryName} />
                    {run.levelName && <span className="dim"> · {run.levelName}</span>}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num">
                    {run.primaryDisplay ?? '—'}
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
  if (error) {
    return (
      <Section icon={<Trophy size={13} />} title="Leaderboard">
        <div className="notice notice--unknown">
          <Info size={15} />
          <span data-selectable>
            The leaderboard could not be loaded: {error}. Compare the time on
            Speedrun.com before deciding.
          </span>
        </div>
      </Section>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <Section icon={<Trophy size={13} />} title="Leaderboard">
        <EmptyState
          title="No leaderboard to compare against"
          hint="This category has no ranked runs yet, or it does not use a leaderboard."
        />
      </Section>
    );
  }

  return (
    <Section icon={<Trophy size={13} />} title="Leaderboard">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 44 }}>#</th>
            <th>Runner</th>
            <th style={{ textAlign: 'right' }}>Time</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.runId}
              data-row-action="true"
              data-selected={entry.runId === currentRunId}
              onClick={() => void openExternal(entry.weblink)}
              title="Open this run on Speedrun.com"
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
