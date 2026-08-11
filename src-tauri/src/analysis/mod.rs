//! Run analysis: heuristics that flag runs for a moderator to review.
//!
//! Nothing in this module decides anything. `analyse` returns a
//! [`RunAnalysis`] whose strongest possible statement is "a human should look
//! at this", and the command layer never turns that into an action.
//!
//! The split is:
//! - [`types`] — the vocabulary (severity, confidence, evidence, findings).
//! - [`checks`] — the individual heuristics.
//! - this file — the [`AnalysisContext`] the checks read from, duplicate
//!   detection across a queue, and runner-history summarisation.

pub mod checks;
pub mod types;

use std::collections::HashMap;

pub use checks::RunnerHistory;
pub use types::{
    CheckId, Confidence, Evidence, Finding, Recommendation, RunAnalysis, Severity,
};

use crate::src_api::models::{Category, Game, Run, Variable};
use crate::video::{detect, VideoCheck};

/// Everything a check may read.
///
/// Each field is optional or empty-by-default: a check whose data is absent
/// stays silent or reports [`Confidence::Unverifiable`], never a guess.
pub struct AnalysisContext<'a> {
    pub run: &'a Run,
    pub game: Option<&'a Game>,
    pub category: Option<&'a Category>,
    pub variables: &'a [Variable],
    /// Video verdicts, in submission order.
    pub videos: &'a [VideoCheck],
    /// Primary times from the category leaderboard, when one was fetched.
    /// `None` means "not fetched", which is not the same as an empty board.
    pub leaderboard_times: Option<&'a [f64]>,
    /// IDs of other pending runs sharing a video with this one.
    pub duplicates: &'a [String],
    /// A previous local decision on this run, e.g. "reject".
    pub prior_action: Option<&'a str>,
    pub runner_history: Option<&'a RunnerHistory>,
    /// Resolved platform name, for readable messages.
    pub platform_name: Option<&'a str>,
}

impl<'a> AnalysisContext<'a> {
    /// A context with only the run itself, for callers that have nothing else
    /// loaded yet. Checks needing more data simply stay quiet.
    pub fn minimal(run: &'a Run) -> Self {
        Self {
            run,
            game: None,
            category: None,
            variables: &[],
            videos: &[],
            leaderboard_times: None,
            duplicates: &[],
            prior_action: None,
            runner_history: None,
            platform_name: None,
        }
    }
}

/// Analyses one run.
pub fn analyse(ctx: &AnalysisContext<'_>) -> RunAnalysis {
    RunAnalysis::from_findings(ctx.run.id.clone(), checks::run_all(ctx))
}

/// Groups runs that share a video, by normalised URL.
///
/// Returns run id → the other run ids sharing at least one video. A shared
/// video is *not* proof of a duplicate: one recording can legitimately cover
/// several categories, so the caller surfaces this as a flag only.
pub fn find_duplicates(runs: &[Run]) -> HashMap<String, Vec<String>> {
    let mut by_video: HashMap<String, Vec<String>> = HashMap::new();

    for run in runs {
        for url in run.video_urls() {
            let Ok(reference) = detect::parse(&url) else {
                continue;
            };
            let ids = by_video.entry(reference.normalized).or_default();
            if !ids.contains(&run.id) {
                ids.push(run.id.clone());
            }
        }
    }

    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for ids in by_video.values().filter(|ids| ids.len() > 1) {
        for id in ids {
            let others: Vec<String> = ids.iter().filter(|o| *o != id).cloned().collect();
            let entry = out.entry(id.clone()).or_default();
            for other in others {
                if !entry.contains(&other) {
                    entry.push(other);
                }
            }
        }
    }
    out
}

/// Summarises a player's earlier runs in the same game and category.
///
/// `earlier` should be the runs the API returned for that user; `current` is
/// excluded by id so a run never compares against itself.
pub fn summarise_runner_history(
    earlier: &[Run],
    current: &Run,
    category_id: Option<&str>,
) -> RunnerHistory {
    let mut history = RunnerHistory::default();

    for run in earlier {
        if run.id == current.id {
            continue;
        }
        history.total_runs += 1;
        match run.status_str() {
            "verified" => history.verified_runs += 1,
            "rejected" => history.rejected_runs += 1,
            _ => {}
        }

        // Only compare like with like: a different category's time is not a
        // personal best for this one.
        let same_category = match (category_id, run.category_id()) {
            (Some(want), Some(got)) => want == got,
            _ => false,
        };
        if !same_category || run.status_str() == "rejected" {
            continue;
        }
        if let Some(seconds) = run.primary_seconds().filter(|s| *s > 0.0) {
            history.best_time = Some(match history.best_time {
                Some(best) if best <= seconds => best,
                _ => seconds,
            });
        }
    }

    history
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::src_api::models::{Ruleset, Times, Videos};
    use crate::video::{VideoPlatform, VideoStatus};

    /// A minimal run with one registered player, so fixtures do not
    /// accidentally trip the "no player listed" check.
    fn run_with(id: &str, videos: Vec<&str>, seconds: Option<f64>) -> Run {
        Run {
            id: id.to_string(),
            weblink: None,
            game: None,
            level: None,
            category: None,
            videos: Some(Videos {
                text: None,
                links: videos
                    .into_iter()
                    .map(|uri| crate::src_api::models::Link {
                        rel: None,
                        uri: uri.to_string(),
                    })
                    .collect(),
            }),
            comment: Some("a comment".into()),
            status: None,
            players: Some(serde_json::json!([{ "rel": "user", "id": "u1" }])),
            date: None,
            submitted: None,
            times: Some(Times {
                primary_t: seconds,
                ..Default::default()
            }),
            system: None,
            splits: None,
            values: Default::default(),
        }
    }

    fn video(status: VideoStatus, url: &str) -> VideoCheck {
        VideoCheck::new(url, VideoPlatform::YouTube, status, "detail")
    }

    #[test]
    fn a_missing_video_is_critical_when_the_ruleset_requires_one() {
        let run = run_with("r1", vec![], Some(100.0));
        let game = Game {
            id: "g".into(),
            names: Default::default(),
            abbreviation: None,
            weblink: None,
            released: None,
            release_date: None,
            ruleset: Some(Ruleset {
                require_video: Some(true),
                ..Default::default()
            }),
            romhack: None,
            platforms: None,
            regions: None,
            moderators: Default::default(),
            created: None,
            assets: None,
        };
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.game = Some(&game);

        let analysis = analyse(&ctx);
        assert_eq!(analysis.recommendation, Recommendation::NeedsReview);
        assert!(analysis
            .findings
            .iter()
            .any(|f| f.id == CheckId::VideoMissing && f.severity == Severity::Critical));
    }

    #[test]
    fn an_unreachable_video_is_never_reported_as_missing() {
        let run = run_with("r1", vec!["https://youtu.be/abc"], Some(100.0));
        let checks = vec![video(VideoStatus::NetworkError, "https://youtu.be/abc")];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.videos = &checks;

        let analysis = analyse(&ctx);
        let finding = analysis
            .findings
            .iter()
            .find(|f| f.id == CheckId::VideoUnreachable)
            .expect("an unreachable finding");
        assert_eq!(finding.confidence, Confidence::Unverifiable);
        assert_eq!(finding.evidence, Evidence::Missing);
        assert_eq!(analysis.recommendation, Recommendation::CannotVerify);
        assert!(
            !analysis.findings.iter().any(|f| f.id == CheckId::VideoInaccessible),
            "a failed check must not become a verdict about the video"
        );
    }

    #[test]
    fn a_deleted_video_is_confirmed_evidence() {
        let run = run_with("r1", vec!["https://youtu.be/abc"], Some(100.0));
        let checks = vec![video(VideoStatus::Deleted, "https://youtu.be/abc")];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.videos = &checks;

        let finding = analyse(&ctx)
            .findings
            .into_iter()
            .find(|f| f.id == CheckId::VideoInaccessible)
            .expect("a deleted finding");
        assert_eq!(finding.confidence, Confidence::Confirmed);
        assert_eq!(finding.severity, Severity::Critical);
    }

    #[test]
    fn a_working_video_and_a_normal_time_raise_nothing() {
        let run = run_with("r1", vec!["https://youtu.be/abc"], Some(100.0));
        let checks = vec![video(VideoStatus::Available, "https://youtu.be/abc")];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.videos = &checks;

        let analysis = analyse(&ctx);
        assert_eq!(analysis.critical_count, 0);
        assert_eq!(analysis.warning_count, 0);
        assert_eq!(analysis.recommendation, Recommendation::NothingFlagged);
    }

    #[test]
    fn a_record_shattering_time_is_flagged_as_a_heuristic_only() {
        let run = run_with("r1", vec![], Some(10.0));
        let board = [100.0, 110.0, 120.0];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.leaderboard_times = Some(&board);

        let finding = analyse(&ctx)
            .findings
            .into_iter()
            .find(|f| f.id == CheckId::TimeSuspiciouslyFast)
            .expect("a speed finding");
        assert_eq!(finding.confidence, Confidence::Heuristic);
        assert!(finding.detail.contains("cannot tell"));
    }

    #[test]
    fn without_a_leaderboard_no_time_comparison_is_made() {
        let run = run_with("r1", vec![], Some(1.0));
        let ctx = AnalysisContext::minimal(&run);
        assert!(!analyse(&ctx)
            .findings
            .iter()
            .any(|f| f.id == CheckId::TimeSuspiciouslyFast));
    }

    #[test]
    fn a_short_video_is_flagged_but_only_past_the_allowance() {
        let run = run_with("r1", vec!["https://youtu.be/abc"], Some(600.0));
        let mut check = video(VideoStatus::Available, "https://youtu.be/abc");
        check.metadata.duration_seconds = Some(120.0);
        let checks = vec![check];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.videos = &checks;
        assert!(analyse(&ctx)
            .findings
            .iter()
            .any(|f| f.id == CheckId::VideoShorterThanRun));

        // Slightly shorter is within the allowance and must stay silent.
        let mut close = video(VideoStatus::Available, "https://youtu.be/abc");
        close.metadata.duration_seconds = Some(590.0);
        let closes = vec![close];
        let mut ctx2 = AnalysisContext::minimal(&run);
        ctx2.videos = &closes;
        assert!(!analyse(&ctx2)
            .findings
            .iter()
            .any(|f| f.id == CheckId::VideoShorterThanRun));
    }

    #[test]
    fn duplicates_group_by_normalised_video() {
        let runs = vec![
            run_with("a", vec!["https://youtu.be/SHARED"], Some(1.0)),
            run_with("b", vec!["https://www.youtube.com/watch?v=SHARED&t=10"], Some(1.0)),
            run_with("c", vec!["https://youtu.be/OTHER"], Some(1.0)),
        ];
        let dupes = find_duplicates(&runs);
        assert_eq!(dupes.get("a"), Some(&vec!["b".to_string()]));
        assert_eq!(dupes.get("b"), Some(&vec!["a".to_string()]));
        assert!(!dupes.contains_key("c"));
    }

    #[test]
    fn a_duplicate_is_a_warning_never_a_decision() {
        let run = run_with("a", vec!["https://youtu.be/x"], Some(1.0));
        let dupes = vec!["b".to_string()];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.duplicates = &dupes;

        let finding = analyse(&ctx)
            .findings
            .into_iter()
            .find(|f| f.id == CheckId::DuplicateSubmission)
            .expect("a duplicate finding");
        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.suggestion.unwrap().contains("never rejects"));
    }

    #[test]
    fn runner_history_ignores_the_current_run_and_other_categories() {
        let mut current = run_with("current", vec![], Some(90.0));
        current.category = Some(serde_json::json!("cat1"));

        let mut same = run_with("older", vec![], Some(120.0));
        same.category = Some(serde_json::json!("cat1"));
        same.status = Some(crate::src_api::models::RunStatus {
            status: "verified".into(),
            examiner: None,
            reason: None,
            verify_date: None,
        });

        let mut other = run_with("other-cat", vec![], Some(5.0));
        other.category = Some(serde_json::json!("cat2"));

        let history = summarise_runner_history(
            &[current.clone(), same, other],
            &current,
            Some("cat1"),
        );
        assert_eq!(history.total_runs, 2, "the current run is excluded");
        assert_eq!(history.verified_runs, 1);
        assert_eq!(
            history.best_time,
            Some(120.0),
            "only the same category counts toward a personal best"
        );
    }

    #[test]
    fn an_unknown_host_is_unverifiable_not_a_problem() {
        let run = run_with("r1", vec!["https://example.com/run.mp4"], Some(100.0));
        let checks = vec![VideoCheck::new(
            "https://example.com/run.mp4",
            VideoPlatform::Other,
            VideoStatus::Unknown,
            "no integration",
        )];
        let mut ctx = AnalysisContext::minimal(&run);
        ctx.videos = &checks;

        let analysis = analyse(&ctx);
        assert_eq!(analysis.recommendation, Recommendation::CannotVerify);
        assert!(analysis
            .findings
            .iter()
            .any(|f| f.id == CheckId::VideoUnsupportedHost));
    }
}
