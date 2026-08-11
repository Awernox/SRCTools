//! The individual heuristics.
//!
//! Each `check_*` function pushes zero or more [`Finding`]s. They share three
//! rules:
//!
//! 1. A check that lacks the data it needs emits a finding with
//!    [`Confidence::Unverifiable`] — or nothing at all. It never guesses.
//! 2. Wording distinguishes "the provider said X" from "this looks like X".
//! 3. No check returns a decision. Severity tops out at "look at this".

use crate::util::{days_between, format_duration, improvement_percent, parse_timestamp};
use crate::video::{VideoCheck, VideoStatus};

use super::types::{CheckId, Confidence, Evidence, Finding, Severity};
use super::AnalysisContext;

/// Runs every check against the supplied context.
pub fn run_all(ctx: &AnalysisContext<'_>) -> Vec<Finding> {
    let mut out = Vec::new();
    check_videos(ctx, &mut out);
    check_times(ctx, &mut out);
    check_leaderboard(ctx, &mut out);
    check_system(ctx, &mut out);
    check_dates(ctx, &mut out);
    check_variables(ctx, &mut out);
    check_submission(ctx, &mut out);
    check_local_records(ctx, &mut out);
    out
}

// --- Video ------------------------------------------------------------------

fn check_videos(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let urls = ctx.run.video_urls();
    let requires_video = ctx
        .game
        .and_then(|g| g.ruleset.as_ref())
        .and_then(|r| r.require_video)
        .unwrap_or(false);
    let free_text = ctx
        .run
        .videos
        .as_ref()
        .and_then(|v| v.text.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if urls.is_empty() {
        if let Some(text) = free_text {
            out.push(
                Finding::new(
                    CheckId::VideoTextOnly,
                    if requires_video { Severity::Critical } else { Severity::Warning },
                    Confidence::Confirmed,
                    Evidence::RunData,
                    "Video described in text, no link",
                    format!(
                        "The submission has no video link — only the note “{}”. There is nothing to verify automatically.",
                        crate::util::sanitize_line(text, 160)
                    ),
                )
                .with_suggestion("Open the run on Speedrun.com to see whether the note points at a real recording."),
            );
        } else {
            out.push(
                Finding::new(
                    CheckId::VideoMissing,
                    if requires_video { Severity::Critical } else { Severity::Warning },
                    Confidence::Confirmed,
                    Evidence::RunData,
                    "No video submitted",
                    if requires_video {
                        "No video link was submitted, and this game's ruleset requires video proof."
                    } else {
                        "No video link was submitted. This game's ruleset does not require one, so check the category rules."
                    },
                ),
            );
        }
        if requires_video {
            out.push(Finding::new(
                CheckId::RulesRequireVideo,
                Severity::Info,
                Confidence::Confirmed,
                Evidence::GameRules,
                "Ruleset requires video",
                "The game's ruleset has “require video” enabled.",
            ));
        }
        return;
    }

    if urls.len() > 1 {
        out.push(Finding::new(
            CheckId::MultipleVideos,
            Severity::Info,
            Confidence::Confirmed,
            Evidence::RunData,
            format!("{} video links", urls.len()),
            "The run has more than one video link. Each was checked separately.",
        ));
    }

    for check in ctx.videos {
        push_video_finding(ctx, check, out);
    }
}

fn push_video_finding(ctx: &AnalysisContext<'_>, check: &VideoCheck, out: &mut Vec<Finding>) {
    let host = check.platform.label();
    match check.status {
        VideoStatus::Available => {
            compare_duration(ctx, check, out);
        }
        VideoStatus::Deleted => out.push(
            Finding::new(
                CheckId::VideoInaccessible,
                Severity::Critical,
                Confidence::Confirmed,
                Evidence::VideoProvider,
                "Video deleted",
                format!("{host} reports that this video no longer exists. {}", check.detail),
            )
            .with_suggestion("Ask the runner for a working link before deciding."),
        ),
        VideoStatus::Private => out.push(
            Finding::new(
                CheckId::VideoInaccessible,
                Severity::Critical,
                Confidence::Confirmed,
                Evidence::VideoProvider,
                "Video not viewable",
                format!("{host} reports this video as private or restricted, so it cannot be watched for verification. {}", check.detail),
            )
            .with_suggestion("Ask the runner to make the video public or unlisted."),
        ),
        VideoStatus::Unavailable | VideoStatus::RegionRestricted => out.push(Finding::new(
            CheckId::VideoInaccessible,
            Severity::Warning,
            Confidence::Confirmed,
            Evidence::VideoProvider,
            "Video may not play",
            format!(
                "{host} reports playback restrictions on this video. This does not mean it was deleted. {}",
                check.detail
            ),
        )),
        VideoStatus::Processing => out.push(Finding::new(
            CheckId::VideoUnreachable,
            Severity::Warning,
            Confidence::Unverifiable,
            Evidence::VideoProvider,
            "Video still processing",
            format!("{host} reports the video as still being processed. Check again shortly."),
        )),
        VideoStatus::InvalidUrl => out.push(Finding::new(
            CheckId::VideoInaccessible,
            Severity::Critical,
            Confidence::Confirmed,
            Evidence::RunData,
            "Video link is not usable",
            check.detail.clone(),
        )),
        VideoStatus::NetworkError => out.push(
            Finding::new(
                CheckId::VideoUnreachable,
                Severity::Warning,
                Confidence::Unverifiable,
                Evidence::Missing,
                "Video could not be checked",
                format!(
                    "The check itself failed, so the state of this video is unknown. It has not been shown to be missing. {}",
                    check.detail
                ),
            )
            .with_suggestion("Re-run the check, or open the link manually."),
        ),
        VideoStatus::Unknown => out.push(Finding::new(
            CheckId::VideoUnsupportedHost,
            Severity::Warning,
            Confidence::Unverifiable,
            Evidence::Missing,
            format!("{host} cannot be checked automatically"),
            format!(
                "SRCTools has no way to query this host for availability, so the video must be opened manually. {}",
                check.detail
            ),
        )),
    }
}

/// Flags a video that is shorter than the run it supposedly shows.
///
/// Only fires when the provider gave a duration *and* the margin is large,
/// because timing rules (loads removed, in-game time) legitimately make a run
/// time shorter than real time — never longer.
fn compare_duration(ctx: &AnalysisContext<'_>, check: &VideoCheck, out: &mut Vec<Finding>) {
    let Some(video_secs) = check.metadata.duration_seconds else {
        return;
    };
    let Some(run_secs) = ctx.run.primary_seconds() else {
        return;
    };
    if video_secs <= 0.0 || run_secs <= 0.0 {
        return;
    }
    // 5% plus 30 seconds of slack absorbs trimmed intros and rounding.
    let allowance = run_secs * 0.05 + 30.0;
    if video_secs + allowance < run_secs {
        out.push(
            Finding::new(
                CheckId::VideoShorterThanRun,
                Severity::Warning,
                Confidence::Likely,
                Evidence::VideoProvider,
                "Video shorter than the run",
                format!(
                    "The video is {} long but the run is timed at {}. That can be legitimate when the timing method removes loads, so check how the category is timed.",
                    format_duration(video_secs),
                    format_duration(run_secs)
                ),
            )
            .with_suggestion("Compare the video length against the category's timing rules."),
        );
    }
}

// --- Times ------------------------------------------------------------------

fn check_times(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let Some(seconds) = ctx.run.primary_seconds() else {
        out.push(Finding::new(
            CheckId::TimeMissing,
            Severity::Critical,
            Confidence::Confirmed,
            Evidence::RunData,
            "No time recorded",
            "The run has no primary time, so it cannot be placed on the leaderboard.",
        ));
        return;
    };

    if seconds <= 0.0 {
        out.push(Finding::new(
            CheckId::TimeMissing,
            Severity::Critical,
            Confidence::Confirmed,
            Evidence::RunData,
            "Time is zero",
            "The submitted time is zero or negative, which cannot be a real run.",
        ));
    }
}

fn check_leaderboard(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let Some(seconds) = ctx.run.primary_seconds().filter(|s| *s > 0.0) else {
        return;
    };
    let Some(board) = ctx.leaderboard_times else {
        // No board fetched — say nothing rather than implying the time is fine.
        return;
    };
    let Some(best) = board.iter().copied().filter(|t| *t > 0.0).min_by(f64::total_cmp) else {
        return;
    };

    if seconds < best {
        let margin = improvement_percent(best, seconds).unwrap_or(0.0);
        let (severity, confidence) = if margin >= 25.0 {
            (Severity::Critical, Confidence::Heuristic)
        } else if margin >= 5.0 {
            (Severity::Warning, Confidence::Heuristic)
        } else {
            (Severity::Info, Confidence::Confirmed)
        };

        out.push(
            Finding::new(
                if margin >= 5.0 { CheckId::TimeSuspiciouslyFast } else { CheckId::LargeImprovement },
                severity,
                confidence,
                Evidence::Leaderboard,
                if margin >= 25.0 {
                    "Far faster than the current record"
                } else {
                    "New best time"
                },
                format!(
                    "At {}, this run is {:.1}% faster than the current top time of {}. A large jump can be a legitimate breakthrough, a new strategy, or a timing mistake — this check cannot tell which.",
                    format_duration(seconds),
                    margin,
                    format_duration(best)
                ),
            )
            .with_suggestion("Watch the run in full and confirm the timing method before deciding."),
        );
    } else if let Some(worst) = board.iter().copied().max_by(f64::total_cmp) {
        // Slower than everything on the board is normal for a new runner; only
        // note it, never warn.
        if seconds > worst {
            out.push(Finding::new(
                CheckId::TimeAboveLeaderboard,
                Severity::Info,
                Confidence::Confirmed,
                Evidence::Leaderboard,
                "Slower than the fetched leaderboard",
                format!(
                    "At {} this run is slower than every run in the leaderboard sample that was fetched. That is not a problem in itself.",
                    format_duration(seconds)
                ),
            ));
        }
    }
}

// --- Platform, emulator, region --------------------------------------------

fn check_system(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let Some(system) = ctx.run.system.as_ref() else {
        return;
    };

    if system.emulated.unwrap_or(false) {
        let allowed = ctx
            .game
            .and_then(|g| g.ruleset.as_ref())
            .and_then(|r| r.emulators_allowed);
        match allowed {
            Some(false) => out.push(
                Finding::new(
                    CheckId::EmulatorNotAllowed,
                    Severity::Critical,
                    Confidence::Confirmed,
                    Evidence::GameRules,
                    "Emulator run, emulators not allowed",
                    "The run is marked as emulated and the game's ruleset does not allow emulators.",
                )
                .with_suggestion("Check the category rules — some categories allow what the game-level ruleset does not."),
            ),
            Some(true) => out.push(Finding::new(
                CheckId::EmulatorNotAllowed,
                Severity::Info,
                Confidence::Confirmed,
                Evidence::GameRules,
                "Emulator run",
                "The run is marked as emulated, which this game allows.",
            )),
            None => out.push(Finding::new(
                CheckId::EmulatorNotAllowed,
                Severity::Info,
                Confidence::Unverifiable,
                Evidence::Missing,
                "Emulator run, rule unknown",
                "The run is marked as emulated. The game's ruleset does not state whether emulators are allowed.",
            )),
        }
    }

    if let (Some(platform), Some(game)) = (system.platform.as_deref(), ctx.game) {
        let listed = game.platform_ids();
        if !listed.is_empty() && !listed.iter().any(|p| p == platform) {
            let name = ctx
                .platform_name
                .map(|n| n.to_string())
                .unwrap_or_else(|| platform.to_string());
            out.push(Finding::new(
                CheckId::PlatformNotListed,
                Severity::Warning,
                Confidence::Confirmed,
                Evidence::GameRules,
                "Platform not listed for this game",
                format!("The run is submitted on {name}, which is not among the platforms listed for this game."),
            ));
        }
    }

    if system.region.is_none() {
        if let Some(game) = ctx.game {
            if !game.region_ids().is_empty() {
                out.push(Finding::new(
                    CheckId::RegionMissing,
                    Severity::Info,
                    Confidence::Confirmed,
                    Evidence::RunData,
                    "No region set",
                    "This game lists regions but the run does not specify one. Many categories do not require it.",
                ));
            }
        }
    }
}

// --- Dates ------------------------------------------------------------------

fn check_dates(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let now = chrono::Utc::now();

    if let Some(played) = ctx.run.date.as_deref().and_then(parse_timestamp) {
        // One day of slack for time-zone differences.
        if played > now + chrono::Duration::days(1) {
            out.push(Finding::new(
                CheckId::DateInFuture,
                Severity::Warning,
                Confidence::Confirmed,
                Evidence::RunData,
                "Run date is in the future",
                format!("The run is dated {}, which is in the future.", played.date_naive()),
            ));
        }

        if let Some(released) = ctx
            .game
            .and_then(|g| g.release_date.as_deref())
            .and_then(parse_timestamp)
        {
            if played < released {
                out.push(Finding::new(
                    CheckId::DateBeforeRelease,
                    Severity::Warning,
                    Confidence::Confirmed,
                    Evidence::GameRules,
                    "Run predates the game's release",
                    format!(
                        "The run is dated {} but the game's release date is {}.",
                        played.date_naive(),
                        released.date_naive()
                    ),
                ));
            }
        }
    }

    if let (Some(played), Some(submitted)) = (ctx.run.date.as_deref(), ctx.run.submitted.as_deref()) {
        if let Some(gap) = days_between(submitted, played) {
            // Submitted before played, beyond a day of time-zone slack.
            if gap > 1 {
                out.push(Finding::new(
                    CheckId::SubmittedBeforePlayed,
                    Severity::Warning,
                    Confidence::Confirmed,
                    Evidence::RunData,
                    "Submitted before it was played",
                    format!("The run is dated {gap} days after its submission timestamp."),
                ));
            }
        }
    }

    if let Some(submitted) = ctx.run.submitted.as_deref() {
        if let Some(days) = days_between(submitted, &crate::util::now_iso8601()) {
            if days >= 30 {
                out.push(Finding::new(
                    CheckId::LongPending,
                    Severity::Info,
                    Confidence::Confirmed,
                    Evidence::RunData,
                    format!("Pending for {days} days"),
                    "This run has been waiting in the queue for a month or more.",
                ));
            }
        }
    }
}

// --- Variables --------------------------------------------------------------

fn check_variables(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    for variable in ctx.variables {
        let mandatory = variable.mandatory.unwrap_or(false);
        if !mandatory {
            continue;
        }
        // Only variables scoped to this run's category apply.
        if let Some(cat) = variable.category.as_deref() {
            if Some(cat) != ctx.run.category_id().as_deref() {
                continue;
            }
        }
        if !ctx.run.values.contains_key(&variable.id) {
            out.push(Finding::new(
                CheckId::MissingSubcategory,
                Severity::Warning,
                Confidence::Confirmed,
                Evidence::RunData,
                format!("Missing required value: {}", variable.name),
                format!(
                    "The category requires a value for “{}” and the run does not have one.",
                    variable.name
                ),
            ));
        }
    }
}

// --- Submission shape -------------------------------------------------------

fn check_submission(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    let players = ctx.run.players();

    if players.is_empty() {
        out.push(Finding::new(
            CheckId::GuestSubmission,
            Severity::Warning,
            Confidence::Confirmed,
            Evidence::RunData,
            "No player listed",
            "The run record has no player attached.",
        ));
    } else if players
        .iter()
        .any(|p| p.kind == crate::src_api::models::PlayerKind::Guest)
    {
        out.push(Finding::new(
            CheckId::GuestSubmission,
            Severity::Info,
            Confidence::Confirmed,
            Evidence::RunData,
            "Includes a guest player",
            "At least one player is a guest rather than a registered account, so no submission history is available for them.",
        ));
    }

    if let Some(expected) = ctx.category.and_then(|c| c.players.as_ref()) {
        if let (Some(kind), Some(value)) = (expected.player_type.as_deref(), expected.value) {
            let count = players.len() as u32;
            let mismatch = match kind {
                "exactly" => count != value,
                "up-to" => count > value,
                _ => false,
            };
            if mismatch && count > 0 {
                out.push(Finding::new(
                    CheckId::GuestSubmission,
                    Severity::Warning,
                    Confidence::Confirmed,
                    Evidence::GameRules,
                    "Unexpected number of players",
                    format!(
                        "This category expects {kind} {value} player(s) but the run lists {count}."
                    ),
                ));
            }
        }
    }

    let comment = ctx.run.comment.as_deref().map(str::trim).unwrap_or_default();
    if comment.is_empty() {
        out.push(Finding::new(
            CheckId::NoComment,
            Severity::Info,
            Confidence::Confirmed,
            Evidence::RunData,
            "No submission comment",
            "The runner did not leave a comment. Most submissions do not.",
        ));
    }
}

// --- Local records ----------------------------------------------------------

fn check_local_records(ctx: &AnalysisContext<'_>, out: &mut Vec<Finding>) {
    for duplicate in ctx.duplicates {
        out.push(
            Finding::new(
                CheckId::DuplicateSubmission,
                Severity::Warning,
                Confidence::Confirmed,
                Evidence::RunData,
                "Same video as another pending run",
                format!(
                    "Run {} in the queue points at the same video. That can mean a duplicate submission, or one recording legitimately covering runs in several categories.",
                    duplicate
                ),
            )
            .with_suggestion("Compare both runs before acting. SRCTools never rejects duplicates on its own."),
        );
    }

    if let Some(prior) = ctx.prior_action {
        out.push(Finding::new(
            CheckId::PreviouslyActioned,
            Severity::Info,
            Confidence::Confirmed,
            Evidence::LocalRecords,
            "You already acted on this run",
            format!("Your local history records a “{prior}” action for this run."),
        ));
    }

    if let Some(history) = ctx.runner_history {
        if history.total_runs == 0 {
            out.push(Finding::new(
                CheckId::FirstSubmission,
                Severity::Info,
                Confidence::Confirmed,
                Evidence::RunnerHistory,
                "First submission from this runner",
                "No earlier runs were found for this player in this game.",
            ));
        } else if history.rejected_runs > 0 {
            out.push(Finding::new(
                CheckId::RunnerHistoryClean,
                Severity::Info,
                Confidence::Confirmed,
                Evidence::RunnerHistory,
                format!("{} earlier rejection(s)", history.rejected_runs),
                format!(
                    "This player has {} verified and {} rejected run(s) in this game. Past rejections say nothing about this run.",
                    history.verified_runs, history.rejected_runs
                ),
            ));
        }

        if let (Some(previous_best), Some(current)) = (history.best_time, ctx.run.primary_seconds()) {
            if let Some(pct) = improvement_percent(previous_best, current) {
                if pct >= 20.0 {
                    out.push(Finding::new(
                        CheckId::LargeImprovement,
                        Severity::Warning,
                        Confidence::Heuristic,
                        Evidence::RunnerHistory,
                        format!("{pct:.0}% faster than their own best"),
                        format!(
                            "This run is {} against their previous best of {}. Large personal improvements are common after learning a new route, so this is context, not evidence.",
                            format_duration(current),
                            format_duration(previous_best)
                        ),
                    ));
                } else if pct > 0.0 {
                    out.push(Finding::new(
                        CheckId::LargeImprovement,
                        Severity::Info,
                        Confidence::Confirmed,
                        Evidence::RunnerHistory,
                        format!("Personal best, {pct:.1}% faster"),
                        format!(
                            "Improves on their previous best of {}.",
                            format_duration(previous_best)
                        ),
                    ));
                }
            }
        }
    }
}

/// Summary of a runner's earlier submissions in the same game.
///
/// Built by `crate::analysis::runner_history` from runs the API actually
/// returned. `best_time` is `None` when no earlier timed run was found, which
/// is different from "they have never improved".
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHistory {
    pub total_runs: usize,
    pub verified_runs: usize,
    pub rejected_runs: usize,
    /// Fastest earlier time in this category, when one exists.
    pub best_time: Option<f64>,
}
