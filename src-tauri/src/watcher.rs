//! The new-run watcher.
//!
//! This runs on the Tokio runtime rather than in the webview, and that is the
//! whole point of the module. The polling loop used to live in the frontend as a
//! chain of `setTimeout` calls, which Chromium throttles hard once the window is
//! hidden or unfocused — after a few minutes in the background a timer asking
//! for five seconds fires roughly once a minute. A moderator waiting for a toast
//! is, by definition, not looking at the window, so the throttle applied exactly
//! when the watcher mattered most.
//!
//! Here the cadence is the runtime's, so it is the cadence the moderator chose.
//! Nothing about the window — focus, visibility, minimised state — changes it.
//!
//! Two further rules follow from that, and both are load-bearing:
//!
//! 1. **One cycle is one narrow request.** `status=new`, newest first, twenty
//!    rows. It is a "what changed" query, not a queue rebuild: no game list, no
//!    category walk, no history, no video probing.
//! 2. **The next tick is armed from the cycle's own start.** Announcing a run —
//!    the toast, the sound, the webhook, the video check — happens in the
//!    frontend after the event is emitted, so none of it can push the next poll
//!    later. The period is the interval, not the interval plus the work.
//!
//! Two slower feeds ride along: `status=verified` and `status=rejected`, both
//! polled at most every [`VERDICT_INTERVAL`]. A
//! verdict is the one moderation outcome the app cannot learn from its own
//! actions — another moderator, or this moderator working on the Speedrun.com
//! site, approves or rejects a run and no action hook here ever sees it. Asking
//! is the only way to know: without these two feeds the "Approved runs" and
//! "Rejected runs" webhook toggles only ever fired for verdicts made in this
//! window, which is not where most of them are made.
//!
//! Failure is bounded, never a hidden cooldown: repeated errors slow the loop to
//! at most [`MAX_FAILURE_WAIT`] and it recovers on its own, without a restart.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::dto::RunSummary;
use crate::error::AppResult;
use crate::src_api::endpoints::{self, RunOrder, RunQuery, RunStatusFilter};
use crate::state::AppState;

/// Carries the runs a cycle has not reported before.
const NEW_RUNS_EVENT: &str = "srctools://new-runs";

/// Carries verifications the app did not perform itself.
const APPROVED_EVENT: &str = "srctools://approved-runs";

/// Carries rejections the app did not perform itself.
const REJECTED_EVENT: &str = "srctools://rejected-runs";

/// Carries connection state, so the status bar shows the truth without polling.
const STATUS_EVENT: &str = "srctools://watcher";

/// Ceiling on the pause after consecutive failures.
///
/// Deliberately short. The old renderer loop backed off to ten minutes, which
/// read as "notifications stopped working" and could only be cleared by
/// restarting the app.
const MAX_FAILURE_WAIT: Duration = Duration::from_secs(30);

/// Consecutive failures before the loop slows down at all.
const FAILURES_BEFORE_BACKOFF: u32 = 3;

/// How many run ids to remember.
///
/// Only needs to outlast the window in which a run could still be re-reported.
/// The [`Watermark`] is the real guard; this bounds memory.
const SEEN_CAPACITY: usize = 600;

/// Longest a status event may be withheld while nothing changes, so the "last
/// checked" line stays honest without waking the frontend every second.
const STATUS_HEARTBEAT: Duration = Duration::from_secs(15);

/// How often the loop says in the log that it is alive.
///
/// Without this the log is silent whenever nothing is wrong, so "the watcher is
/// polling and your games are quiet" and "the watcher died" produce the same
/// empty file — which is exactly the ambiguity that made the last report
/// impossible to answer from the log alone. One line a minute is cheap and
/// settles it. Not per cycle: at a one-second cadence that would be 1,440 lines
/// an hour.
const LOG_HEARTBEAT: Duration = Duration::from_secs(60);

/// What the loop was told to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherConfig {
    pub enabled: bool,
    /// Seconds between cycles. Clamped to [`MIN_INTERVAL`]..=`3600`.
    pub interval_secs: u64,
}

/// Fastest cadence offered. One second is 60 requests a minute against a budget
/// of about 100, which is deliberate but leaves room for the moderator's own
/// browsing.
const MIN_INTERVAL: u64 = 1;
const MAX_INTERVAL: u64 = 3_600;

impl WatcherConfig {
    const fn off() -> Self {
        Self { enabled: false, interval_secs: 5 }
    }

    fn interval(&self) -> Duration {
        Duration::from_secs(self.interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL))
    }
}

/// Loop state, as the status bar renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub enabled: bool,
    /// True once a cycle has established what "already known" means.
    pub primed: bool,
    /// ISO-8601 timestamp of the last cycle that completed, successful or not.
    pub last_check: Option<String>,
    /// Why the last cycle failed, when one did. Carries no credential.
    pub last_error: Option<String>,
    pub failures: u32,
    /// The cadence actually in use, after clamping.
    pub interval_secs: u64,
    /// Games the query was scoped to.
    pub scoped_games: usize,
}

impl WatcherStatus {
    const fn off() -> Self {
        Self {
            enabled: false,
            primed: false,
            last_check: None,
            last_error: None,
            failures: 0,
            interval_secs: 5,
            scoped_games: 0,
        }
    }
}

/// Payload of `srctools://new-runs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRuns {
    pub runs: Vec<RunSummary>,
    pub fetched_at: String,
    pub scoped_games: usize,
}

/// Which timestamp orders the feed a [`Seen`] set is guarding.
///
/// It has to match the feed's `orderby`, and getting it wrong is silent in both
/// directions: a mark the feed is not sorted by reads a run as long-since-seen
/// and never reports it, which looks exactly like "nothing happened".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Watermark {
    /// `submitted` — the newest-first pending feed.
    Submitted,
    /// `status.verify-date` — the verified feed, ordered by verdict time.
    Verdict,
    /// No mark: ids alone decide, and eviction is the only way to forget.
    ///
    /// For the rejected feed, which has no usable timestamp of either kind.
    /// Speedrun.com records `verify-date` for verified runs only — every rejected
    /// run on the site reports it as null, checked against the live API — so the
    /// feed is ordered by submission instead, and a mark on `submitted` would
    /// then be wrong: the newest *submission* among rejected runs has nothing to
    /// do with the newest *rejection*, so a run rejected today but submitted
    /// before that mark would be read as already reported.
    ///
    /// Safe here because rejections are rare. Twenty rows of the site-wide feed
    /// spanned five and a half hours when measured, so [`SEEN_CAPACITY`] ids
    /// cover weeks of them and nothing is evicted while it still matters.
    Ids,
}

impl Watermark {
    fn of(self, run: &RunSummary) -> Option<&String> {
        match self {
            Self::Submitted => run.submitted.as_ref(),
            Self::Verdict => run.verify_date.as_ref(),
            Self::Ids => None,
        }
    }
}

/// What the loop remembers between cycles.
///
/// `ids` answers "have I reported this run", and is bounded. `high` answers the
/// same question for a run that has since been forgotten, which is what keeps an
/// evicted id from being announced a second time.
struct Seen {
    mark: Watermark,
    ids: HashSet<String>,
    order: VecDeque<String>,
    high: Option<String>,
    /// True once this feed has established its own baseline.
    ///
    /// Per feed rather than per cycle, and that distinction is load-bearing: a
    /// verdict feed whose first request failed would otherwise inherit the
    /// pending feed's "already primed" and announce the twenty runs sitting on
    /// its opening page as twenty fresh verdicts.
    primed: bool,
}

impl Seen {
    fn new(mark: Watermark) -> Self {
        Self {
            mark,
            ids: HashSet::new(),
            order: VecDeque::new(),
            high: None,
            primed: false,
        }
    }

    /// The runs on this page worth announcing, marking the whole page seen.
    ///
    /// The opening page is a baseline and returns nothing: it is the backlog that
    /// already existed, and announcing it would fire on every launch.
    fn news(&mut self, page: &[RunSummary]) -> Vec<RunSummary> {
        let news: Vec<RunSummary> = if self.primed {
            page.iter().filter(|run| !self.contains(run)).cloned().collect()
        } else {
            Vec::new()
        };
        for run in page {
            self.remember(run);
        }
        self.primed = true;
        news
    }

    fn contains(&self, run: &RunSummary) -> bool {
        if self.ids.contains(&run.id) {
            return true;
        }
        // Older than everything already reported, so it has been seen before
        // even though its id has aged out of the set.
        match (self.mark.of(run), &self.high) {
            (Some(stamp), Some(high)) => stamp <= high,
            _ => false,
        }
    }

    fn remember(&mut self, run: &RunSummary) {
        if self.ids.insert(run.id.clone()) {
            self.order.push_back(run.id.clone());
            while self.order.len() > SEEN_CAPACITY {
                if let Some(old) = self.order.pop_front() {
                    self.ids.remove(&old);
                }
            }
        }
        if let Some(stamp) = self.mark.of(run) {
            if self.high.as_ref().is_none_or(|high| stamp > high) {
                self.high = Some(stamp.clone());
            }
        }
    }

    fn forget(&mut self) {
        self.ids.clear();
        self.order.clear();
        self.high = None;
        // A fresh baseline is wanted, not a page full of announcements.
        self.primed = false;
    }
}

/// Handle to the watcher loop. One is managed by Tauri for the app's life.
pub struct Watcher {
    config: Arc<RwLock<WatcherConfig>>,
    status: Arc<RwLock<WatcherStatus>>,
    /// Wakes the loop when the configuration changes or a poll is requested,
    /// so a settings change takes effect now rather than after the old sleep.
    wake: Arc<Notify>,
    /// Set when the loop should discard what it has seen before its next cycle.
    reprime: Arc<RwLock<bool>>,
}

impl Watcher {
    /// Starts the loop. It parks until something enables it.
    pub fn spawn(app: tauri::AppHandle) -> Self {
        let config = Arc::new(RwLock::new(WatcherConfig::off()));
        let status = Arc::new(RwLock::new(WatcherStatus::off()));
        let wake = Arc::new(Notify::new());
        let reprime = Arc::new(RwLock::new(false));

        let handle = Self {
            config: Arc::clone(&config),
            status: Arc::clone(&status),
            wake: Arc::clone(&wake),
            reprime: Arc::clone(&reprime),
        };

        tauri::async_runtime::spawn(run(app, config, status, wake, reprime));
        handle
    }

    pub fn status(&self) -> WatcherStatus {
        self.status.read().clone()
    }

    /// Applies the two settings that decide whether the loop polls at all.
    ///
    /// Enabling re-primes: the backlog that existed while the watcher was off is
    /// not news, and announcing all of it would be worse than announcing none.
    pub fn configure(&self, next: WatcherConfig) -> WatcherStatus {
        let was_enabled = self.config.read().enabled;
        let interval_secs = next.interval_secs.clamp(MIN_INTERVAL, MAX_INTERVAL);
        *self.config.write() = WatcherConfig { enabled: next.enabled, interval_secs };

        tracing::info!(
            "watcher configured: enabled={}, interval={}s",
            next.enabled,
            interval_secs
        );

        if next.enabled && !was_enabled {
            *self.reprime.write() = true;
        }

        {
            let mut status = self.status.write();
            status.enabled = next.enabled;
            status.interval_secs = interval_secs;
            if !next.enabled {
                status.failures = 0;
                status.last_error = None;
            }
        }

        self.wake.notify_one();
        self.status()
    }

    /// Runs a cycle now, without disturbing the cadence.
    pub fn poll_now(&self) {
        self.wake.notify_one();
    }

    /// Forgets what has been reported, so the next cycle re-establishes the
    /// baseline. Used when the signed-in account changes.
    pub fn reprime(&self) {
        *self.reprime.write() = true;
        self.wake.notify_one();
    }
}

/// What one cycle found.
struct Cycle {
    /// Runs this cycle had not reported before, newest first.
    fresh: Vec<RunSummary>,
    /// Runs a moderator verified since the last look — whoever did it and
    /// wherever they did it, including on the Speedrun.com site itself. Empty on
    /// the cycles that did not check.
    approved: Vec<RunSummary>,
    /// Runs a moderator rejected since the last look — whoever did it and
    /// wherever they did it, including on the Speedrun.com site itself. Empty on
    /// the cycles that did not check.
    rejected: Vec<RunSummary>,
    /// Runs on the page that belong to a moderated game, new or not. Reported in
    /// the heartbeat log so "nothing arrived" can be told apart from "the filter
    /// is dropping everything", which look identical from outside.
    matched: usize,
    fetched_at: String,
    scoped_games: usize,
}

/// How many of the newest pending runs one cycle looks at.
///
/// The global `status=new` feed sorted newest-first spans twenty-odd minutes of
/// submissions across the whole site, so twenty rows is a wide, fresh window for
/// games that only see a handful of submissions a day. It is bounded because
/// this is a change check, not a queue rebuild: whatever is deeper than one page
/// was already seen, and processing it again would just re-announce old runs.
const POLL_LIMIT: usize = 20;

/// Floor on how often the verdict feeds are polled, whatever the interval is.
///
/// A verdict someone else made is worth reporting, but it is not what the
/// moderator is sitting at the window waiting for, and there are two of these
/// feeds. Pairing them with a one-second pending poll would put 180 requests a
/// minute against a budget of about a hundred — the fast cadence exists for new
/// submissions, and spending it here would starve the thing it was for.
const VERDICT_INTERVAL: Duration = Duration::from_secs(20);

/// One poll: the narrowest question that answers "has anything arrived".
///
/// Deliberately not a queue refresh, and deliberately **one** request rather
/// than one per moderated game. The global `status=new` feed sorted newest-first
/// is a change feed for the whole site: sampled repeatedly, twenty rows spanned
/// a little over twenty minutes of submissions. A five-second cadence therefore
/// has roughly two hundred times the window it needs, and the moderator's games
/// are found by filtering that page rather than by asking about each game in
/// turn. Fanning out would cost one request per game per cycle — thirty-six
/// games at five seconds is over four hundred requests a minute against a budget
/// of about a hundred, so it would spend the whole allowance on a question the
/// single page already answers, and starve the moderator's own browsing.
///
/// The moderated-game list comes from a cache with a six-hour lifetime, and the
/// only per-game lookups are variables and levels for games that actually appear
/// in the page — themselves cached for twelve hours. A steady-state cycle is one
/// HTTP request, or three on the cycles that also check verdicts.
async fn cycle(
    app: &tauri::AppHandle,
    seen: &mut Seen,
    approvals: &mut Seen,
    rejects: &mut Seen,
    check_verdicts: bool,
) -> AppResult<Cycle> {
    let state: State<'_, AppState> = app.state::<AppState>();

    let games = crate::commands::library::load_moderated_games(&state).await?;
    if games.is_empty() {
        // Deliberately without touching any baseline: a cycle that found no
        // moderated games has learned nothing, and marking the feeds primed here
        // would make the first cycle that *does* see games announce all of them.
        return Ok(Cycle {
            fresh: Vec::new(),
            approved: Vec::new(),
            rejected: Vec::new(),
            matched: 0,
            fetched_at: crate::util::now_iso8601(),
            scoped_games: 0,
        });
    }

    let owned: HashSet<String> = games.iter().map(|g| g.id.clone()).collect();

    let query = RunQuery {
        status: Some(RunStatusFilter::New),
        order_by: Some(RunOrder::Submitted),
        ascending: false,
        embed: true,
        // Without this the poll is answered from the CDN's five-minute copy and
        // a new run shows up minutes late however often we ask.
        cache_buster: Some(crate::util::epoch_millis()),
        ..Default::default()
    };

    let client = state.client();
    let api_key = state.api_key().ok();
    let fetched = endpoints::runs(&client, &query, api_key.as_deref(), Some(POLL_LIMIT)).await?;

    let mine: Vec<_> = fetched
        .into_iter()
        .filter(|run| run.game_id().is_some_and(|id| owned.contains(&id)))
        .collect();

    let summaries = crate::commands::queue::summarise_runs(&state, &mine).await?;
    let fresh = seen.news(&summaries);

    // Verdicts, which this app may have had no part in. A moderator approving or
    // rejecting on the site, or a second moderator doing either anywhere, is
    // invisible to the action-driven webhook — the only way to see it is to ask.
    //
    // Neither failure is propagated. The pending page above has already been
    // marked seen, so returning `Err` from here would drop those runs for good
    // and they would never be announced; a feed that failed simply re-asks on the
    // next verdict cycle, its own baseline untouched.
    let mut approved = Vec::new();
    let mut rejected = Vec::new();
    if check_verdicts {
        match verdict_feed(&state, &owned, RunStatusFilter::Verified, approvals).await {
            Ok(runs) => approved = runs,
            Err(e) => tracing::warn!("watcher: the verified feed failed: {e}"),
        }
        match verdict_feed(&state, &owned, RunStatusFilter::Rejected, rejects).await {
            Ok(runs) => rejected = runs,
            Err(e) => tracing::warn!("watcher: the rejected feed failed: {e}"),
        }
    }

    Ok(Cycle {
        fresh,
        approved,
        rejected,
        matched: summaries.len(),
        fetched_at: crate::util::now_iso8601(),
        scoped_games: games.len(),
    })
}

/// How a verdict feed has to be ordered for its newest rows to be the new ones.
///
/// Not a preference. A verified run carries `status.verify-date`, so that feed is
/// a true change feed. A rejected run does not: Speedrun.com leaves the field
/// null for every rejection on the site, so `orderby=verify-date` there sorts by
/// a column that is null in every row and returns an arbitrary page which barely
/// changes from one poll to the next. That is why rejections were never noticed —
/// the feed was asked a question it cannot answer.
///
/// Submission time is the closest thing that exists. A rejection normally follows
/// its submission within hours, so a run rejected now is near the top of the
/// newest-submitted page. The gap is real and cannot be closed from this API: a
/// run rejected long after it was submitted sits deep in the page and is missed.
/// Rejections made in this window do not depend on the feed at all — they are
/// posted the moment they succeed — so what this loses is only the late rejection
/// of an old run made somewhere else.
fn verdict_order(status: RunStatusFilter) -> RunOrder {
    match status {
        RunStatusFilter::Rejected => RunOrder::Submitted,
        _ => RunOrder::VerifyDate,
    }
}

/// One verdict feed: the runs a moderator has just judged, whoever judged them.
///
/// Global rather than per game, for the same reason the pending poll is: one page
/// of the site-wide feed answers the question for every moderated game at once,
/// and asking per game would cost one request each.
async fn verdict_feed(
    state: &AppState,
    owned: &HashSet<String>,
    status: RunStatusFilter,
    seen: &mut Seen,
) -> AppResult<Vec<RunSummary>> {
    let query = RunQuery {
        status: Some(status),
        order_by: Some(verdict_order(status)),
        ascending: false,
        embed: true,
        // Same reason as the pending poll: without it the answer can come from a
        // five-minute-old edge copy, and a verdict would arrive minutes late.
        cache_buster: Some(crate::util::epoch_millis()),
        ..Default::default()
    };

    let client = state.client();
    let api_key = state.api_key().ok();
    let fetched = endpoints::runs(&client, &query, api_key.as_deref(), Some(POLL_LIMIT)).await?;
    let mine: Vec<_> = fetched
        .into_iter()
        .filter(|run| run.game_id().is_some_and(|id| owned.contains(&id)))
        .collect();
    let page = crate::commands::queue::summarise_runs(state, &mine).await?;

    Ok(seen.news(&page))
}

/// Publishes a status change, and a heartbeat so "last checked" stays honest.
///
/// At a one-second cadence, emitting every cycle would wake the frontend sixty
/// times a minute to redraw the same line.
fn publish_status(
    app: &tauri::AppHandle,
    shared: &RwLock<WatcherStatus>,
    next: WatcherStatus,
    last_emit: &mut Option<Instant>,
) {
    let changed = {
        let mut guard = shared.write();
        let changed = *guard != next;
        *guard = next.clone();
        changed
    };
    let due = last_emit.is_none_or(|at| at.elapsed() >= STATUS_HEARTBEAT);
    if changed || due {
        *last_emit = Some(Instant::now());
        let _ = app.emit(STATUS_EVENT, next);
    }
}

/// The loop.
async fn run(
    app: tauri::AppHandle,
    config: Arc<RwLock<WatcherConfig>>,
    status: Arc<RwLock<WatcherStatus>>,
    wake: Arc<Notify>,
    reprime: Arc<RwLock<bool>>,
) {
    let mut seen = Seen::new(Watermark::Submitted);
    let mut approvals = Seen::new(Watermark::Verdict);
    // Ids alone: see `Watermark::Ids`. A rejected run has no verdict timestamp,
    // so there is nothing to mark and marking its submission would silence it.
    let mut rejects = Seen::new(Watermark::Ids);
    let mut primed = false;
    let mut failures: u32 = 0;
    let mut last_emit: Option<Instant> = None;
    let mut last_log: Option<Instant> = None;
    // Successful cycles since the last heartbeat line.
    let mut cycles: u32 = 0;
    // Pending runs in scope as of the last successful cycle.
    let mut matched: usize = 0;
    // When the rejected feed was last asked about, so the fast cadence stays for
    // new submissions alone.
    let mut last_verdict: Option<Instant> = None;

    loop {
        let current = *config.read();
        if !current.enabled {
            // Nothing to do until a setting changes. Costs no timer and no
            // request; the loop is not a busy wait.
            wake.notified().await;
            continue;
        }

        if std::mem::replace(&mut *reprime.write(), false) {
            seen.forget();
            approvals.forget();
            rejects.forget();
            primed = false;
            last_verdict = None;
        }

        // Checked on the first cycle, so the existing rejections are learned
        // rather than announced, then at most every VERDICT_INTERVAL.
        let check_verdicts = last_verdict.is_none_or(|at| at.elapsed() >= VERDICT_INTERVAL);

        // The clock starts here. Everything the frontend does with the event
        // below happens after this cycle has already been timed, so the period
        // stays the interval the moderator asked for.
        let started = Instant::now();
        let outcome = cycle(&app, &mut seen, &mut approvals, &mut rejects, check_verdicts).await;

        let (last_error, scoped_games, fetched_at) = match outcome {
            Ok(found) => {
                failures = 0;
                primed = true;
                if check_verdicts {
                    last_verdict = Some(started);
                }

                // Nothing here asks whether this was the first cycle: each feed
                // holds its own baseline and reports nothing on its opening page,
                // which is also right for a feed whose first request failed.
                if !found.fresh.is_empty() {
                    tracing::info!("watcher: {} new run(s)", found.fresh.len());
                    let _ = app.emit(
                        NEW_RUNS_EVENT,
                        NewRuns {
                            runs: found.fresh,
                            fetched_at: found.fetched_at.clone(),
                            scoped_games: found.scoped_games,
                        },
                    );
                }
                if !found.approved.is_empty() {
                    tracing::info!("watcher: {} approval(s) by a moderator", found.approved.len());
                    let _ = app.emit(
                        APPROVED_EVENT,
                        NewRuns {
                            runs: found.approved,
                            fetched_at: found.fetched_at.clone(),
                            scoped_games: found.scoped_games,
                        },
                    );
                }
                if !found.rejected.is_empty() {
                    tracing::info!("watcher: {} rejection(s) by a moderator", found.rejected.len());
                    let _ = app.emit(
                        REJECTED_EVENT,
                        NewRuns {
                            runs: found.rejected,
                            fetched_at: found.fetched_at.clone(),
                            scoped_games: found.scoped_games,
                        },
                    );
                }
                cycles = cycles.saturating_add(1);
                matched = found.matched;
                (None, found.scoped_games, Some(found.fetched_at))
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                // At `warn` on purpose. A watcher that has quietly stopped is
                // indistinguishable from a broken app, and the default log
                // filter drops `debug`, so this was previously invisible in
                // exactly the situation someone would go looking for it.
                tracing::warn!("watcher cycle failed ({failures} in a row): {e}");
                let scoped = status.read().scoped_games;
                (Some(e.to_string()), scoped, Some(crate::util::now_iso8601()))
            }
        };

        publish_status(
            &app,
            &status,
            WatcherStatus {
                enabled: true,
                primed,
                last_check: fetched_at,
                last_error,
                failures,
                interval_secs: current.interval_secs,
                scoped_games,
            },
            &mut last_emit,
        );

        // Proof of life, at most once a minute. Says what was actually checked
        // so a quiet log can be read as "polling, nothing arrived" rather than
        // guessed at.
        if last_log.is_none_or(|at: Instant| at.elapsed() >= LOG_HEARTBEAT) {
            last_log = Some(Instant::now());
            tracing::info!(
                "watcher alive: {cycles} cycle(s) since last report, every {}s, \
                 {scoped_games} moderated game(s), {matched} pending run(s) in scope, \
                 {failures} consecutive failure(s)",
                current.interval_secs,
            );
            cycles = 0;
        }

        let interval = current.interval();
        let elapsed = started.elapsed();
        let mut wait = interval.saturating_sub(elapsed);
        if failures >= FAILURES_BEFORE_BACKOFF {
            // Slow down while the API is unreachable, but only a little: a
            // watcher that has silently stopped for minutes is indistinguishable
            // from a broken one, and this recovers without a restart.
            let slowed = interval.saturating_mul(2).min(MAX_FAILURE_WAIT);
            wait = wait.max(slowed.saturating_sub(elapsed));
        }
        // A cycle slower than the interval means "go again", not "spin".
        let wait = wait.max(Duration::from_millis(250));

        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.notified() => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Applies the watcher settings and starts or stops polling.
#[tauri::command]
pub fn watcher_configure(
    watcher: State<'_, Watcher>,
    config: WatcherConfig,
) -> AppResult<WatcherStatus> {
    Ok(watcher.configure(config))
}

#[tauri::command]
pub fn watcher_status(watcher: State<'_, Watcher>) -> WatcherStatus {
    watcher.status()
}

/// Runs a cycle now, for the manual refresh.
#[tauri::command]
pub fn watcher_poll_now(watcher: State<'_, Watcher>) -> WatcherStatus {
    watcher.poll_now();
    watcher.status()
}

/// Forgets the baseline, so a changed account does not inherit the old one.
#[tauri::command]
pub fn watcher_reprime(watcher: State<'_, Watcher>) {
    watcher.reprime();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, submitted: Option<&str>, verdict: Option<&str>) -> RunSummary {
        RunSummary {
            id: id.to_string(),
            submitted: submitted.map(str::to_string),
            verify_date: verdict.map(str::to_string),
            ..RunSummary::default()
        }
    }

    #[test]
    fn a_run_is_reported_once() {
        let mut seen = Seen::new(Watermark::Submitted);
        let first = run("aaa", Some("2026-08-11T10:00:00Z"), None);

        assert!(!seen.contains(&first), "not seen before the first look");
        seen.remember(&first);
        assert!(seen.contains(&first), "seen after it");
    }

    #[test]
    fn an_evicted_id_is_not_announced_a_second_time() {
        let mut seen = Seen::new(Watermark::Submitted);
        seen.remember(&run("old", Some("2026-08-11T10:00:00Z"), None));
        // Push the id out of the bounded set.
        for i in 0..SEEN_CAPACITY + 10 {
            seen.remember(&run(&format!("filler{i}"), Some("2026-08-11T11:00:00Z"), None));
        }

        let forgotten = run("old", Some("2026-08-11T10:00:00Z"), None);
        assert!(!seen.ids.contains("old"), "the id really did age out");
        // Older than the high-water mark, so still known to have been reported.
        assert!(seen.contains(&forgotten));
    }

    #[test]
    fn a_verdict_feed_is_guarded_by_verdict_time_not_submission_time() {
        // The trap this enum exists for. The rejected feed is ordered by verdict
        // time, so the run being rejected right now can carry a submission date
        // older than everything already reported. Guarding it by `submitted`
        // would silently drop exactly the rejection worth announcing.
        let mut verdicts = Seen::new(Watermark::Verdict);
        verdicts.remember(&run(
            "recent",
            Some("2026-08-11T10:00:00Z"),
            Some("2026-08-11T10:05:00Z"),
        ));

        let ancient_run_just_rejected = run(
            "ancient",
            Some("2019-01-01T00:00:00Z"),
            Some("2026-08-11T10:06:00Z"),
        );
        assert!(
            !verdicts.contains(&ancient_run_just_rejected),
            "a years-old run rejected a minute ago is news"
        );

        // And the same set still suppresses a verdict it has already reported.
        let already_reported = run(
            "older-verdict",
            Some("2026-08-11T09:00:00Z"),
            Some("2026-08-11T10:01:00Z"),
        );
        assert!(verdicts.contains(&already_reported));
    }

    #[test]
    fn a_feeds_opening_page_is_a_baseline_not_news() {
        // Otherwise every launch announces whatever was already on the page —
        // twenty approvals in one burst, none of them new.
        let mut approvals = Seen::new(Watermark::Verdict);
        let page = vec![
            run("a", None, Some("2026-08-11T10:00:00Z")),
            run("b", None, Some("2026-08-11T09:00:00Z")),
        ];
        assert!(approvals.news(&page).is_empty(), "the first look reports nothing");
        assert!(approvals.primed);

        let mut later = page.clone();
        later.insert(0, run("c", None, Some("2026-08-11T10:30:00Z")));
        let news = approvals.news(&later);
        assert_eq!(news.len(), 1, "only the run that arrived since");
        assert_eq!(news[0].id, "c");
    }

    #[test]
    fn a_feed_whose_first_request_failed_still_gets_a_first_look() {
        // The baseline is per feed, not per cycle. A verified feed that errored
        // on the cycle which primed the pending feed must not read its own next
        // page as twenty fresh approvals.
        let mut approvals = Seen::new(Watermark::Verdict);
        assert!(!approvals.primed, "a feed that has not answered is not primed");
        assert!(approvals
            .news(&[run("a", None, Some("2026-08-11T10:00:00Z"))])
            .is_empty());
    }

    #[test]
    fn each_verdict_feed_is_ordered_by_something_it_actually_has() {
        // Checked against the live API: every rejected run on the site reports
        // `verify-date` as null, so ordering the rejected feed by it sorts on an
        // empty column and the newest rejection never reaches the top. This is
        // the reason rejections went unnoticed; do not put it back.
        assert_eq!(verdict_order(RunStatusFilter::Verified), RunOrder::VerifyDate);
        assert_eq!(verdict_order(RunStatusFilter::Rejected), RunOrder::Submitted);
    }

    #[test]
    fn a_rejection_is_not_silenced_by_an_older_submission() {
        // The rejected feed is ordered by submission, so its newest row says
        // nothing about when anything was rejected. A mark on that would read a
        // run rejected today but submitted last year as already reported.
        let mut rejects = Seen::new(Watermark::Ids);
        rejects.news(&[run("recent", Some("2026-08-11T17:39:11Z"), None)]);

        let old = run("ancient", Some("2021-03-31T14:47:20Z"), None);
        assert!(!rejects.contains(&old), "an old submission is still a new rejection");
        assert_eq!(rejects.news(std::slice::from_ref(&old)).len(), 1);
    }

    #[test]
    fn the_two_verdict_feeds_do_not_share_a_baseline() {
        // A run is verified or rejected, never both, but the sets are separate so
        // that one feed's page can never mark the other's runs as reported.
        let mut approvals = Seen::new(Watermark::Verdict);
        let rejects = Seen::new(Watermark::Ids);

        let approved = run("aaa", None, Some("2026-08-11T10:00:00Z"));
        approvals.news(std::slice::from_ref(&approved));

        assert!(approvals.contains(&approved));
        assert!(!rejects.contains(&approved));
    }

    #[test]
    fn the_two_feeds_do_not_share_a_baseline() {
        // A pending run and its own later rejection are two separate pieces of
        // news; one set marking it seen must not silence the other.
        let mut seen = Seen::new(Watermark::Submitted);
        let verdicts = Seen::new(Watermark::Verdict);

        let pending = run("same", Some("2026-08-11T10:00:00Z"), None);
        seen.remember(&pending);

        let rejected = run("same", Some("2026-08-11T10:00:00Z"), Some("2026-08-11T10:30:00Z"));
        assert!(seen.contains(&rejected), "the pending feed already reported it");
        assert!(!verdicts.contains(&rejected), "the rejection has not been reported");
    }

    #[test]
    fn forgetting_clears_both_the_ids_and_the_watermark() {
        let mut seen = Seen::new(Watermark::Submitted);
        seen.remember(&run("aaa", Some("2026-08-11T10:00:00Z"), None));
        seen.forget();
        // Re-priming must treat everything as unknown, or a changed account
        // would inherit the previous account's baseline.
        assert!(!seen.contains(&run("aaa", Some("2026-08-11T10:00:00Z"), None)));
        assert!(!seen.contains(&run("bbb", Some("2026-01-01T00:00:00Z"), None)));
    }

    #[test]
    fn a_run_with_no_timestamp_is_judged_by_id_alone() {
        // Legacy runs have no verify-date. Treating "no timestamp" as "older than
        // the mark" would drop them silently.
        let mut verdicts = Seen::new(Watermark::Verdict);
        verdicts.remember(&run("known", None, Some("2026-08-11T10:00:00Z")));

        assert!(!verdicts.contains(&run("stranger", None, None)));
        assert!(verdicts.contains(&run("known", None, Some("2026-08-11T10:00:00Z"))));
    }

    #[test]
    fn the_verdict_feed_is_not_polled_at_the_pending_cadence() {
        // One second is an offered interval; pairing two verdict polls with it
        // would triple a request count that is already near the budget.
        assert!(VERDICT_INTERVAL >= Duration::from_secs(10));
        assert!(Duration::from_secs(MIN_INTERVAL) < VERDICT_INTERVAL);
    }
}
