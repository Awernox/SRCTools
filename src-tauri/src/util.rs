//! Small shared helpers: timestamps, duration formatting, text sanitising.
//!
//! Sanitising lives here because *everything* arriving from Speedrun.com or a
//! video provider passes through it before reaching the database or the UI.
//! React escapes HTML on render, so the risk is not script injection but
//! control characters and unbounded strings corrupting the interface.

use chrono::{DateTime, SecondsFormat, Utc};

/// Current UTC time as `2026-08-10T14:03:11.482Z`.
pub fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Milliseconds since the Unix epoch.
///
/// Used to make a polling URL differ from the previous one so a CDN cannot
/// answer it from a stale copy. Not a clock anyone reads.
pub fn epoch_millis() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

/// Parses an ISO-8601 / RFC-3339 timestamp, tolerating the date-only form
/// Speedrun.com uses for a run's `date` field.
pub fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // "2026-08-10" — treat as midnight UTC.
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| dt.and_utc())
}

/// Whole days between two timestamps, or `None` if either is unparseable.
pub fn days_between(earlier: &str, later: &str) -> Option<i64> {
    let a = parse_timestamp(earlier)?;
    let b = parse_timestamp(later)?;
    Some((b - a).num_days())
}

/// Formats a run duration the way speedrunners read it: `1:23:45.670`,
/// `12:34.560`, `9.120`. Milliseconds are dropped when zero.
pub fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "—".to_string();
    }
    let total_ms = (seconds * 1000.0).round() as i64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let (h, m, s) = (total_s / 3600, (total_s % 3600) / 60, total_s % 60);

    let base = if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else if m > 0 {
        format!("{m}:{s:02}")
    } else {
        format!("{s}")
    };

    if ms == 0 {
        base
    } else {
        format!("{base}.{ms:03}")
    }
}

/// Strips control characters and clamps length.
///
/// Newlines and tabs survive because run comments and category rules are
/// genuinely multi-line; everything else in the C0/C1 range is removed.
pub fn sanitize_text(raw: &str, max_chars: usize) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Single-line variant for names, titles and other inline fields.
pub fn sanitize_line(raw: &str, max_chars: usize) -> String {
    let flattened: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    // Collapse the runs of whitespace the flattening just created.
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Percentage improvement of `new_time` over `old_time`, positive when faster.
pub fn improvement_percent(old_time: f64, new_time: f64) -> Option<f64> {
    if old_time <= 0.0 || new_time <= 0.0 || !old_time.is_finite() || !new_time.is_finite() {
        return None;
    }
    Some((old_time - new_time) / old_time * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_like_a_leaderboard() {
        assert_eq!(format_duration(9.12), "9.120");
        assert_eq!(format_duration(754.56), "12:34.560");
        assert_eq!(format_duration(5025.67), "1:23:45.670");
        assert_eq!(format_duration(60.0), "1:00");
        assert_eq!(format_duration(0.0), "0");
        assert_eq!(format_duration(-1.0), "—");
        assert_eq!(format_duration(f64::NAN), "—");
    }

    #[test]
    fn timestamps_accept_both_src_shapes() {
        assert!(parse_timestamp("2026-08-10T14:03:11Z").is_some());
        assert!(parse_timestamp("2026-08-10").is_some());
        assert!(parse_timestamp("").is_none());
        assert!(parse_timestamp("not a date").is_none());
    }

    #[test]
    fn day_gaps_are_signed() {
        assert_eq!(days_between("2026-08-01", "2026-08-10"), Some(9));
        assert_eq!(days_between("2026-08-10", "2026-08-01"), Some(-9));
    }

    #[test]
    fn sanitising_removes_control_characters_but_keeps_newlines() {
        assert_eq!(sanitize_text("hello\u{0}\u{7}world", 100), "helloworld");
        assert_eq!(sanitize_text("line one\nline two", 100), "line one\nline two");
        assert_eq!(sanitize_line("line one\nline two", 100), "line one line two");
        assert_eq!(sanitize_line("  spaced   out  ", 100), "spaced out");
    }

    #[test]
    fn sanitising_clamps_length() {
        let long = "a".repeat(500);
        let out = sanitize_text(&long, 10);
        assert_eq!(out.chars().count(), 11); // 10 + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn improvement_is_positive_when_faster() {
        assert_eq!(improvement_percent(100.0, 90.0), Some(10.0));
        assert_eq!(improvement_percent(100.0, 110.0), Some(-10.0));
        assert_eq!(improvement_percent(0.0, 90.0), None);
    }

    #[test]
    fn now_is_utc_iso8601() {
        let now = now_iso8601();
        assert!(now.ends_with('Z'), "{now}");
        assert!(parse_timestamp(&now).is_some());
    }
}
