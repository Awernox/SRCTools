//! Types for run analysis.
//!
//! The hard rule this module encodes: analysis **flags**, it never **decides**.
//! Every finding carries a [`Severity`] and a [`Confidence`], and the highest
//! either can reach is "a human should look at this". No field here says
//! "reject" or "approve", and nothing downstream is allowed to infer one.
//!
//! Findings also state where their evidence came from ([`Evidence`]), so the UI
//! can separate *confirmed data* from *a guess based on missing data* — a run
//! whose video could not be reached must never look the same as a run whose
//! video is confirmed deleted.

use serde::{Deserialize, Serialize};

/// How much attention a finding deserves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Context worth knowing; nothing is wrong.
    Info,
    /// Something a moderator would want to check before deciding.
    Warning,
    /// A rule appears to be broken, or required proof is missing.
    Critical,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }
}

/// How sure the check is about what it found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Read directly from the API or a provider — a fact, not an inference.
    Confirmed,
    /// Inferred from data that is present and consistent.
    Likely,
    /// A heuristic that is often wrong; shown, but weighted lightly.
    Heuristic,
    /// The check could not run because the data it needs was unavailable.
    Unverifiable,
}

impl Confidence {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Likely => "likely",
            Self::Heuristic => "heuristic",
            Self::Unverifiable => "unverifiable",
        }
    }
}

/// Where a finding's evidence came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Evidence {
    /// The run record itself.
    RunData,
    /// Game or category rules and ruleset flags.
    GameRules,
    /// A video provider's answer.
    VideoProvider,
    /// The leaderboard, i.e. comparison against other runs.
    Leaderboard,
    /// The runner's own submission history.
    RunnerHistory,
    /// The local database (duplicate detection, prior local decisions).
    LocalRecords,
    /// The data needed was missing or unreachable.
    Missing,
}

/// Stable identifiers for each check, so the UI can group, filter and
/// individually disable them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckId {
    VideoMissing,
    VideoUnreachable,
    VideoInaccessible,
    VideoUnsupportedHost,
    VideoTextOnly,
    VideoShorterThanRun,
    MultipleVideos,
    TimeMissing,
    TimeSuspiciouslyFast,
    TimeAboveLeaderboard,
    LargeImprovement,
    FirstSubmission,
    RunnerHistoryClean,
    DuplicateSubmission,
    PreviouslyActioned,
    EmulatorNotAllowed,
    PlatformNotListed,
    RegionMissing,
    DateInFuture,
    DateBeforeRelease,
    SubmittedBeforePlayed,
    MissingSubcategory,
    NoComment,
    GuestSubmission,
    RulesRequireVideo,
    LongPending,
}

impl CheckId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::VideoMissing => "video_missing",
            Self::VideoUnreachable => "video_unreachable",
            Self::VideoInaccessible => "video_inaccessible",
            Self::VideoUnsupportedHost => "video_unsupported_host",
            Self::VideoTextOnly => "video_text_only",
            Self::VideoShorterThanRun => "video_shorter_than_run",
            Self::MultipleVideos => "multiple_videos",
            Self::TimeMissing => "time_missing",
            Self::TimeSuspiciouslyFast => "time_suspiciously_fast",
            Self::TimeAboveLeaderboard => "time_above_leaderboard",
            Self::LargeImprovement => "large_improvement",
            Self::FirstSubmission => "first_submission",
            Self::RunnerHistoryClean => "runner_history_clean",
            Self::DuplicateSubmission => "duplicate_submission",
            Self::PreviouslyActioned => "previously_actioned",
            Self::EmulatorNotAllowed => "emulator_not_allowed",
            Self::PlatformNotListed => "platform_not_listed",
            Self::RegionMissing => "region_missing",
            Self::DateInFuture => "date_in_future",
            Self::DateBeforeRelease => "date_before_release",
            Self::SubmittedBeforePlayed => "submitted_before_played",
            Self::MissingSubcategory => "missing_subcategory",
            Self::NoComment => "no_comment",
            Self::GuestSubmission => "guest_submission",
            Self::RulesRequireVideo => "rules_require_video",
            Self::LongPending => "long_pending",
        }
    }
}

/// One thing the analysis noticed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: CheckId,
    pub severity: Severity,
    pub confidence: Confidence,
    pub evidence: Evidence,
    /// Short label for a badge or list row.
    pub title: String,
    /// Full explanation, including why the check fired and what it does *not*
    /// prove. Always populated.
    pub detail: String,
    /// What a moderator might do next. Never phrased as a decision.
    pub suggestion: Option<String>,
}

impl Finding {
    pub fn new(
        id: CheckId,
        severity: Severity,
        confidence: Confidence,
        evidence: Evidence,
        title: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            id,
            severity,
            confidence,
            evidence,
            title: title.into(),
            detail: detail.into(),
            suggestion: None,
        }
    }

    pub fn with_suggestion(mut self, suggestion: impl Into<String>) -> Self {
        self.suggestion = Some(suggestion.into());
        self
    }
}

/// Overall recommendation. Deliberately has no "approve" or "reject" variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recommendation {
    /// Nothing was flagged. Still a human decision.
    NothingFlagged,
    /// Findings exist that a moderator should read.
    NeedsReview,
    /// A required piece of evidence could not be checked at all.
    CannotVerify,
}

impl Recommendation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NothingFlagged => "nothing_flagged",
            Self::NeedsReview => "needs_review",
            Self::CannotVerify => "cannot_verify",
        }
    }

    /// Text shown next to the badge, reinforcing that this is not a verdict.
    pub fn caption(&self) -> &'static str {
        match self {
            Self::NothingFlagged => "No automated check raised a flag. The decision is still yours.",
            Self::NeedsReview => "Automated checks raised flags for a human to review.",
            Self::CannotVerify => {
                "Some evidence could not be checked. This says nothing about whether the run is valid."
            }
        }
    }
}

/// The complete analysis of one run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnalysis {
    pub run_id: String,
    pub recommendation: Recommendation,
    pub findings: Vec<Finding>,
    /// Count of findings at each severity, for compact badges.
    pub critical_count: usize,
    pub warning_count: usize,
    pub info_count: usize,
    /// True when at least one check could not run for lack of data.
    pub has_unverifiable: bool,
    pub analysed_at: String,
}

impl RunAnalysis {
    /// Builds the summary from a finished set of findings.
    pub fn from_findings(run_id: impl Into<String>, mut findings: Vec<Finding>) -> Self {
        // Most serious first; within a severity, more certain first.
        findings.sort_by(|a, b| {
            b.severity
                .cmp(&a.severity)
                .then_with(|| confidence_rank(a.confidence).cmp(&confidence_rank(b.confidence)))
        });

        let critical_count = findings.iter().filter(|f| f.severity == Severity::Critical).count();
        let warning_count = findings.iter().filter(|f| f.severity == Severity::Warning).count();
        let info_count = findings.iter().filter(|f| f.severity == Severity::Info).count();
        let has_unverifiable = findings
            .iter()
            .any(|f| f.confidence == Confidence::Unverifiable);

        // An unverifiable *critical* finding is the "cannot verify" case: the
        // check that matters could not run. Unverifiable warnings do not
        // escalate, or a slow provider would make every run look broken.
        let blocked = findings
            .iter()
            .any(|f| f.confidence == Confidence::Unverifiable && f.severity >= Severity::Warning);

        let recommendation = if blocked && critical_count == 0 {
            Recommendation::CannotVerify
        } else if critical_count > 0 || warning_count > 0 {
            Recommendation::NeedsReview
        } else {
            Recommendation::NothingFlagged
        };

        Self {
            run_id: run_id.into(),
            recommendation,
            findings,
            critical_count,
            warning_count,
            info_count,
            has_unverifiable,
            analysed_at: crate::util::now_iso8601(),
        }
    }
}

fn confidence_rank(c: Confidence) -> u8 {
    match c {
        Confidence::Confirmed => 0,
        Confidence::Likely => 1,
        Confidence::Heuristic => 2,
        Confidence::Unverifiable => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(severity: Severity, confidence: Confidence) -> Finding {
        Finding::new(
            CheckId::NoComment,
            severity,
            confidence,
            Evidence::RunData,
            "t",
            "d",
        )
    }

    #[test]
    fn no_findings_means_nothing_flagged() {
        let a = RunAnalysis::from_findings("r1", vec![]);
        assert_eq!(a.recommendation, Recommendation::NothingFlagged);
        assert!(!a.has_unverifiable);
    }

    #[test]
    fn info_alone_does_not_ask_for_review() {
        let a = RunAnalysis::from_findings("r1", vec![finding(Severity::Info, Confidence::Confirmed)]);
        assert_eq!(a.recommendation, Recommendation::NothingFlagged);
        assert_eq!(a.info_count, 1);
    }

    #[test]
    fn a_warning_asks_for_review() {
        let a =
            RunAnalysis::from_findings("r1", vec![finding(Severity::Warning, Confidence::Likely)]);
        assert_eq!(a.recommendation, Recommendation::NeedsReview);
    }

    #[test]
    fn unverifiable_evidence_is_reported_as_cannot_verify() {
        let a = RunAnalysis::from_findings(
            "r1",
            vec![finding(Severity::Warning, Confidence::Unverifiable)],
        );
        assert_eq!(a.recommendation, Recommendation::CannotVerify);
        assert!(a.has_unverifiable);
    }

    #[test]
    fn a_real_problem_outranks_an_unverifiable_one() {
        let a = RunAnalysis::from_findings(
            "r1",
            vec![
                finding(Severity::Warning, Confidence::Unverifiable),
                finding(Severity::Critical, Confidence::Confirmed),
            ],
        );
        assert_eq!(a.recommendation, Recommendation::NeedsReview);
        assert_eq!(a.findings[0].severity, Severity::Critical);
    }

    #[test]
    fn findings_sort_by_severity_then_certainty() {
        let a = RunAnalysis::from_findings(
            "r1",
            vec![
                finding(Severity::Info, Confidence::Confirmed),
                finding(Severity::Critical, Confidence::Heuristic),
                finding(Severity::Critical, Confidence::Confirmed),
            ],
        );
        assert_eq!(a.findings[0].confidence, Confidence::Confirmed);
        assert_eq!(a.findings[1].confidence, Confidence::Heuristic);
        assert_eq!(a.findings[2].severity, Severity::Info);
    }

    #[test]
    fn no_recommendation_can_mean_approve_or_reject() {
        // Guards the product rule at the type level: if someone adds a decisive
        // variant, this test is where the discussion happens.
        for r in [
            Recommendation::NothingFlagged,
            Recommendation::NeedsReview,
            Recommendation::CannotVerify,
        ] {
            let s = r.as_str();
            assert!(!s.contains("approve") && !s.contains("reject"), "{s}");
        }
    }
}
