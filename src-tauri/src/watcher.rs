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
use crate::state::AppState;

/// Carries the runs a cycle has not reported before.
const NEW_RUNS_EVENT: &str = "srctools://new-runs";

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
/// `last_submitted` is the real guard; this bounds memory.
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

/// What the loop remembers between cycles.
///
/// `ids` answers "have I reported this run", and is bounded. `last_submitted`
/// answers the same question for a run that has since been forgotten, which is
/// what keeps an evicted id from being announced a second time.
#[derive(Default)]
struct Seen {
    ids: HashSet<String>,
    order: VecDeque<String>,
    last_submitted: Option<String>,
}

impl Seen {
    fn contains(&self, run: &RunSummary) -> bool {
        if self.ids.contains(&run.id) {
            return true;
        }
        // Older than everything already reported, so it has been seen before
        // even though its id has aged out of the set.
        match (&run.submitted, &self.last_submitted) {
            (Some(submitted), Some(high)) => submitted <= high,
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
        if let Some(submitted) = &run.submitted {
            if self.last_submitted.as_ref().is_none_or(|high| submitted > high) {
                self.last_submitted = Some(submitted.clone());
            }
        }
    }

    fn forget(&mut self) {
        self.ids.clear();
        self.order.clear();
        self.last_submitted = None;
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
/// HTTP request.
async fn cycle(app: &tauri::AppHandle, seen: &mut Seen) -> AppResult<Cycle> {
    use crate::src_api::endpoints::{self, RunOrder, RunQuery, RunStatusFilter};

    let state: State<'_, AppState> = app.state::<AppState>();

    let games = crate::commands::library::load_moderated_games(&state).await?;
    if games.is_empty() {
        return Ok(Cycle {
            fresh: Vec::new(),
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

    let fresh: Vec<RunSummary> = summaries
        .iter()
        .filter(|run| !seen.contains(run))
        .cloned()
        .collect();
    for run in &summaries {
        seen.remember(run);
    }

    Ok(Cycle {
        fresh,
        matched: summaries.len(),
        fetched_at: crate::util::now_iso8601(),
        scoped_games: games.len(),
    })
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
    let mut seen = Seen::default();
    let mut primed = false;
    let mut failures: u32 = 0;
    let mut last_emit: Option<Instant> = None;
    let mut last_log: Option<Instant> = None;
    // Successful cycles since the last heartbeat line.
    let mut cycles: u32 = 0;
    // Pending runs in scope as of the last successful cycle.
    let mut matched: usize = 0;

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
            primed = false;
        }

        // The clock starts here. Everything the frontend does with the event
        // below happens after this cycle has already been timed, so the period
        // stays the interval the moderator asked for.
        let started = Instant::now();
        let outcome = cycle(&app, &mut seen).await;

        let (last_error, scoped_games, fetched_at) = match outcome {
            Ok(found) => {
                failures = 0;
                let was_primed = primed;
                primed = true;

                // The first cycle only learns what is already there; announcing
                // the backlog on every launch would be noise, not news.
                if was_primed && !found.fresh.is_empty() {
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
