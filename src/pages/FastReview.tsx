/**
 * Fast Review.
 *
 * One run at a time, keyboard first. The point is to remove the friction of
 * moving a mouse between a table row and a detail panel — not to make deciding
 * faster. Every action still goes through the same confirmation and the same
 * rejection-reason requirement as the queue, and nothing here decides anything
 * on the moderator's behalf.
 *
 * The run being decided is removed from the queue by the moderation store, which
 * clamps the focus index, so the next run simply appears at the same position.
 * When `fastReviewDelay` is set, the outcome is held on screen for that many
 * seconds first, so a streak of keypresses cannot act on a run that was never
 * actually looked at.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  ListChecks,
  Play,
  ShieldAlert,
  SkipForward,
  Sparkles,
  Video,
  VideoOff,
  X,
  Zap,
} from 'lucide-react';

import { RejectDialog } from '../components/RejectDialog';
import {
  Absent,
  Badge,
  EmptyState,
  KeyHint,
  ProgressBar,
  Skeleton,
  Tooltip,
} from '../components/ui';
import { useShortcuts } from '../hooks/useShortcuts';
import { useT, type Translate, type TranslationKey } from '../i18n';
import {
  confidenceLabel,
  formatNumber,
  formatRelative,
  plural,
  recommendationInfo,
  severityLabel,
  severityTone,
  urlHost,
  videoStatusInfo,
} from '../format';
import { openExternal } from '../open';
import { useApp } from '../store/app';
import { useDetail } from '../store/detail';
import { useModeration } from '../store/moderation';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import { ui } from '../store/ui';
import type { RunDetail, RunSummary } from '../types';

/** What just happened to the run being held on screen. */
type Outcome = 'verified' | 'rejected';

export function FastReview() {
  const t = useT();
  const runs = useQueue((state) => state.visible());
  const focusIndex = useQueue((state) => state.focusIndex);
  const focus = useQueue((state) => state.focus);
  const move = useQueue((state) => state.move);

  const delaySeconds = useSession((state) => state.settings.fastReviewDelay);
  const setFastReview = useApp((state) => state.setFastReview);

  const detail = useDetail((state) => state.detail);
  const detailLoading = useDetail((state) => state.loading);
  const detailError = useDetail((state) => state.error);
  const openDetail = useDetail((state) => state.open);
  const closeDetail = useDetail((state) => state.close);

  const [rejecting, setRejecting] = useState<RunSummary | null>(null);
  const [held, setHeld] = useState<{ run: RunSummary; outcome: Outcome } | null>(null);
  const [handled, setHandled] = useState(0);

  // Denominator for the progress bar, captured once. The queue shrinks as runs
  // are decided, so a live total would make the bar crawl instead of fill.
  const [startingTotal] = useState(() => Math.max(runs.length, 1));

  const holdTimer = useRef<number | undefined>(undefined);

  const index = focusIndex < 0 ? 0 : Math.min(focusIndex, runs.length - 1);
  const current = runs.length > 0 ? (runs[index] ?? null) : null;
  const currentId = current?.id ?? null;

  const busy = useModeration((state) => (currentId === null ? false : state.busy.has(currentId)));

  // Entering Fast Review from a queue with no focused row.
  useEffect(() => {
    if (runs.length > 0 && focusIndex < 0) focus(0);
  }, [runs.length, focusIndex, focus]);

  // Load the detail for whichever run is on screen. A held outcome keeps the
  // previous run in place, so this deliberately waits until it is released.
  useEffect(() => {
    if (!held && currentId) void openDetail(currentId);
  }, [held, currentId, openDetail]);

  useEffect(
    () => () => {
      window.clearTimeout(holdTimer.current);
      closeDetail();
    },
    [closeDetail],
  );

  const exit = () => setFastReview(false);

  /** Shows the outcome for the configured pause, then reveals the next run. */
  const hold = (run: RunSummary, outcome: Outcome) => {
    setHandled((count) => count + 1);
    if (delaySeconds <= 0) return;
    setHeld({ run, outcome });
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setHeld(null), delaySeconds * 1000);
  };

  const release = () => {
    window.clearTimeout(holdTimer.current);
    setHeld(null);
  };

  const verifyCurrent = () => {
    if (held || !current) return;
    const run = current;
    void useModeration
      .getState()
      .verify(run)
      .then((done) => {
        if (done) hold(run, 'verified');
      });
  };

  const skipCurrent = () => {
    if (held) {
      release();
      return;
    }
    if (!current) return;
    const next = move(1);
    if (!next || next.id === current.id) {
      ui.info(t('fast.lastRun'), t('fast.lastRunHint'));
    }
  };

  useShortcuts({
    approve: verifyCurrent,
    reject: () => {
      if (!held && current) setRejecting(current);
    },
    openVideo: () => {
      const run = held?.run ?? current;
      if (!run) return;
      const first = run.videoUrls[0];
      if (first) void openExternal(first);
      else ui.warning(t('fast.noVideoLink'), t('fast.noVideoLinkHint'));
    },
    openRun: () => {
      const run = held?.run ?? current;
      if (run) void openExternal(run.weblink);
    },
    next: skipCurrent,
    previous: () => {
      if (held) release();
      else move(-1);
    },
    fastReview: exit,
    escape: () => {
      if (rejecting) setRejecting(null);
      else exit();
    },
  });

  const remaining = runs.length;

  return (
    <div className="fast">
      <div className="fast__bar">
        <Zap size={14} style={{ color: 'var(--accent-text)' }} />
        <span className="fast__progress">
          {remaining === 0
            ? t('fast.handled', { runs: plural(handled, 'run') })
            : t('fast.position', {
                index: formatNumber(index + 1),
                total: formatNumber(remaining),
              })}
        </span>

        <div style={{ width: 160 }}>
          <ProgressBar value={handled} max={startingTotal} />
        </div>

        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
          {handled === 0
            ? t('fast.nothingDecided')
            : t('fast.decisionsThisSession', { decisions: plural(handled, 'decision') })}
        </span>

        <div className="toolbar__spacer" />

        <span
          className="row"
          style={{ gap: 12, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}
        >
          <HintPair action="approve" labelKey="fast.hint.verify" />
          <HintPair action="reject" labelKey="fast.hint.reject" />
          <HintPair action="next" labelKey="fast.hint.skip" />
          <HintPair action="openVideo" labelKey="fast.hint.video" />
        </span>

        <button
          type="button"
          className="btn btn--sm"
          onClick={exit}
          title={t('fast.exit')}
        >
          <X size={13} />
          {t('fast.exitShort')}
        </button>
      </div>

      <div className="fast__stage">
        {held ? (
          <HeldCard
            run={held.run}
            outcome={held.outcome}
            seconds={delaySeconds}
            onContinue={release}
          />
        ) : !current ? (
          <div className="fast__card">
            <EmptyState
              icon={<Check size={26} />}
              title={handled > 0 ? t('fast.done') : t('fast.nothingToReview')}
              hint={
                handled > 0
                  ? t('fast.doneHint', { runs: plural(handled, 'run') })
                  : t('fast.nothingToReviewHint')
              }
              action={
                <button type="button" className="btn btn--primary" onClick={exit}>
                  {t('fast.backToQueue')}
                </button>
              }
            />
          </div>
        ) : (
          <div className="fast__card">
            <ReviewCard
              run={current}
              // The detail lags one fetch behind when moving between runs.
              // Showing another run's evidence under this heading would be far
              // worse than showing none.
              detail={detail && detail.run.id === current.id ? detail : null}
              loading={detailLoading}
              error={detailError}
            />

            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn--primary"
                onClick={verifyCurrent}
                disabled={busy}
              >
                <Check size={14} />
                {t('action.verify')}
                <HintKey action="approve" />
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => setRejecting(current)}
                disabled={busy}
              >
                <Ban size={14} />
                {t('detail.reject')}
                <HintKey action="reject" />
              </button>

              <button type="button" className="btn" onClick={skipCurrent}>
                <SkipForward size={14} />
                {t('action.skip')}
                <HintKey action="next" />
              </button>

              <div className="toolbar__spacer" />

              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => move(-1)}
                disabled={index === 0}
                title={t('action.prevRun')}
                aria-label={t('action.prevRun')}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => move(1)}
                disabled={index >= runs.length - 1}
                title={t('action.nextRun')}
                aria-label={t('action.nextRun')}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {rejecting && (
        <RejectDialog
          runs={[rejecting]}
          onCancel={() => setRejecting(null)}
          onSubmit={(reason) => {
            const target = rejecting;
            setRejecting(null);
            void useModeration
              .getState()
              .reject(target, reason)
              .then((done) => {
                if (done) hold(target, 'rejected');
              });
          }}
        />
      )}
    </div>
  );
}

/** The shortcut hints along the top bar, which follow any rebinding. */
function HintPair({
  action,
  labelKey,
}: {
  action: 'approve' | 'reject' | 'next' | 'openVideo';
  labelKey: TranslationKey;
}) {
  const t = useT();
  const binding = useSession((state) => state.binding(action));
  return (
    <span className="row" style={{ gap: 4 }}>
      <KeyHint binding={binding} />
      {t(labelKey)}
    </span>
  );
}

/** The same hint inside a button. */
function HintKey({ action }: { action: 'approve' | 'reject' | 'next' }) {
  const binding = useSession((state) => state.binding(action));
  return <KeyHint binding={binding} />;
}

/* ------------------------------------------------------------------- card */

function ReviewCard({
  run,
  detail,
  loading,
  error,
}: {
  run: RunSummary;
  detail: RunDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const t = useT();
  const analysis = detail?.analysis ?? null;
  const checks = detail?.videoChecks ?? [];
  const category = detail?.category ?? null;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div className="h1" style={{ fontSize: 'var(--text-xl)' }}>
          {run.gameName ?? <Absent title={t('detail.noGameName')} />}
        </div>
        <div className="detail__meta">
          <span>{run.categoryName ?? <Absent />}</span>
          {run.levelName !== null && <span className="dim">· {run.levelName}</span>}
          <span className="dim">·</span>
          <span>{run.playerLabel}</span>
          {run.primaryDisplay !== null && (
            <>
              <span className="dim">·</span>
              <span className="num">{run.primaryDisplay}</span>
            </>
          )}
          <span className="dim">·</span>
          <span>{t('fast.submitted', { when: formatRelative(run.submitted) })}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void openExternal(run.weblink)}
          >
            {t('action.openOnSrc')}
            <ExternalLink size={11} />
          </button>
        </div>
      </div>

      {detail?.priorAction != null && (
        <div className="notice notice--warn">
          <ShieldAlert size={15} />
          <span>{detail.priorAction}</span>
        </div>
      )}

      {/* -------------------------------------------------------------- video */}
      <section>
        <div className="section__title">
          <Video size={13} />
          {t('detail.video.title')}
        </div>

        {run.videoUrls.length === 0 ? (
          <div className="notice notice--unknown">
            <VideoOff size={15} />
            <span>
              {run.videoText !== null
                ? t('detail.video.noLinkWithText', { text: run.videoText })
                : t('detail.video.noLink')}
            </span>
          </div>
        ) : loading && checks.length === 0 ? (
          <Skeleton height={56} radius={8} />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {run.videoUrls.map((url) => {
              const check = checks.find((item) => item.url === url) ?? null;
              const info = check ? videoStatusInfo(check.status) : null;
              return (
                <div className="video-item" key={url}>
                  <div className="video-item__head">
                    {info ? (
                      <Tooltip label={info.label} detail={info.meaning}>
                        <Badge tone={info.tone} small dot>
                          {info.label}
                        </Badge>
                      </Tooltip>
                    ) : (
                      <Badge tone="unknown" small>
                        {t('fast.notChecked')}
                      </Badge>
                    )}
                    <span className="video-item__url" title={url}>
                      {urlHost(url)}
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void openExternal(url)}
                    >
                      <Play size={12} />
                      {t('fast.watch')}
                    </button>
                  </div>
                  {check && <div className="video-item__detail">{check.detail}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ----------------------------------------------------------- analysis */}
      <section>
        <div className="section__title">
          <Sparkles size={13} />
          {t('detail.analysis.title')}
        </div>

        {error !== null ? (
          <div className="notice notice--unknown">
            <Info size={15} />
            <span>{t('fast.checksFailed', { error })}</span>
          </div>
        ) : !analysis ? (
          <Skeleton height={44} radius={8} />
        ) : (
          <AnalysisBlock analysis={analysis} />
        )}
      </section>

      {/* -------------------------------------------------------------- rules */}
      {category?.rules != null && (
        <section>
          <div className="section__title">
            <ListChecks size={13} />
            {t('fast.categoryRules', { category: category.name })}
          </div>
          <div className="rules" data-selectable>
            {category.rules}
          </div>
        </section>
      )}
    </div>
  );
}

function AnalysisBlock({ analysis }: { analysis: NonNullable<RunDetail['analysis']> }) {
  const verdict = recommendationInfo(analysis.recommendation);
  const noticeClass =
    verdict.tone === 'ok' ? 'notice' : verdict.tone === 'warn' ? 'notice notice--warn' : 'notice notice--unknown';

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className={noticeClass}>
        <Info size={15} />
        <span>
          <strong>{verdict.label}.</strong> {verdict.detail}
        </span>
      </div>

      {analysis.findings.map((finding) => (
        <div className={`finding finding--${finding.severity}`} key={finding.id}>
          <div style={{ minWidth: 0 }}>
            <div className="finding__title">
              <span>{finding.title}</span>
              <Badge tone={severityTone(finding.severity)} small outline>
                {severityLabel(finding.severity)}
              </Badge>
              <Badge tone="neutral" small>
                {confidenceLabel(finding.confidence)}
              </Badge>
            </div>
            <div className="finding__detail">{finding.detail}</div>
            {finding.suggestion !== null && (
              <div className="finding__suggestion">{finding.suggestion}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- held */

const OUTCOME_COPY: Record<Outcome, { titleKey: TranslationKey; icon: ReactNode }> = {
  verified: { titleKey: 'runStatus.verified', icon: <Check size={26} /> },
  rejected: { titleKey: 'runStatus.rejected', icon: <Ban size={26} /> },
};

/**
 * "Verified — Half-Life", and the line under it.
 *
 * Assembled through the catalogue rather than by concatenation so that the
 * outcome, the game and the countdown can be reordered by a translation.
 */
function heldCopy(
  run: RunSummary,
  outcome: Outcome,
  seconds: number,
  t: Translate,
): { title: string; hint: string } {
  return {
    title: t('fast.heldTitle', {
      outcome: t(OUTCOME_COPY[outcome].titleKey),
      game: run.gameName ?? t('common.unknownGame'),
    }),
    hint: t('fast.heldHint', {
      category: run.categoryName ?? t('common.unknownCategory'),
      runner: run.playerLabel,
      seconds: plural(seconds, 'second'),
    }),
  };
}

/** The pause between one decision and the next run appearing. */
function HeldCard({
  run,
  outcome,
  seconds,
  onContinue,
}: {
  run: RunSummary;
  outcome: Outcome;
  seconds: number;
  onContinue: () => void;
}) {
  const t = useT();
  const copy = heldCopy(run, outcome, seconds, t);
  return (
    <div className="fast__card">
      <EmptyState
        icon={OUTCOME_COPY[outcome].icon}
        title={copy.title}
        hint={copy.hint}
        action={
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn--primary" onClick={onContinue}>
              <SkipForward size={13} />
              {t('fast.continueNow')}
            </button>
            <button type="button" className="btn" onClick={() => void openExternal(run.weblink)}>
              <ExternalLink size={13} />
              {t('fast.openRun')}
            </button>
          </div>
        }
      />
      <div
        className="row"
        style={{
          justifyContent: 'center',
          gap: 6,
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <ShieldAlert size={12} />
        {t('fast.alreadyTold')}
      </div>
    </div>
  );
}
