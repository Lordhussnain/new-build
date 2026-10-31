use crate::text::{is_js_whitespace, js_trim};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const TERMINAL_ERROR_MARKER: &str = "[terminal]";
const GENERIC_TERMINAL_LABEL: &str = "Video not downloadable";
const FORMAT_FALLBACK_LADDER: [&str; 6] = ["4k", "1440p", "1080p", "720p", "480p", "highest"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalErrorInfo {
    pub code: String,
    pub label: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredTerminalError {
    label: String,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryClassification {
    pub n_challenge: bool,
    pub signature_challenge: bool,
    pub disk_full: bool,
    pub permanent: bool,
    pub format_availability: bool,
    pub terminal: Option<TerminalErrorInfo>,
    pub terminal_message: bool,
    pub credential_blocked: bool,
    pub transient: bool,
    pub unrecoverable_resume: bool,
    pub downloader_args: bool,
}

fn compile_patterns(patterns: &[&str]) -> Vec<Regex> {
    patterns
        .iter()
        .map(|pattern| Regex::new(&format!("(?i){pattern}")).unwrap())
        .collect()
}

fn permanent_patterns() -> &'static [Regex] {
    static REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        compile_patterns(&[
            r"video unavailable",
            r"video is unavailable",
            r"video (?:is )?no longer available",
            r"content is (?:not|no longer) available",
            r"video (?:has been|was) (?:deleted|removed)",
            r"video (?:is )?not available\b",
            r"video is private",
            r"private video",
            r"premium members",
            r"requires payment",
            r"members[- ]only",
            r"join this channel to get access",
            r"available to .*\bmembers\b",
            r"sign in to confirm your age",
            r"age[- ]restricted",
            r"age verification required",
            r"inappropriate for some users",
            r"removed by the uploader",
            r"video has been removed",
            r"has been terminated",
            r"account associated with this video has been terminated",
            r"this video does not exist",
            r"no video formats",
            r"requested format is not available",
            r"unsupported url",
            r"is not a valid url",
            r"http error 404",
            r"http error 410",
            r"copyright",
            r"blocked it in your (?:country|region|location)",
            r"not available (?:in|from) your (?:country|region|location)",
            r"unavailable (?:in|from) your (?:country|region|location)",
            r"not made this video available in your (?:country|region|location)",
            r"geo[- ]?restrict(?:ed|ion)",
            r"geo[- ]?blocked",
            r"blocked (?:in|from) your (?:country|region|location)",
        ])
    })
}

fn signature_patterns() -> &'static [Regex] {
    static REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        compile_patterns(&[
            r"signature extraction failed",
            r"nsig extraction failed",
            r"unable to extract (?:the )?(?:signature|nsig)(?: function)?",
            r"failed to extract (?:the )?(?:signature|nsig)(?: function)?",
            r"(?:signature|nsig) decipher(?:ing)? failed",
            r"could not find (?:the )?(?:signature|nsig) function",
        ])
    })
}

fn disk_patterns() -> &'static [Regex] {
    static REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        compile_patterns(&[
            r"\b(?:enospc|error_disk_full)\b",
            r"no space left on (?:the )?(?:device|disk|filesystem)",
            r"(?:disk|storage) quota exceeded",
            r"\b(?:disk|drive|storage|volume)\s+(?:is\s+)?full\b",
            r"not enough (?:free )?space (?:on|in) (?:the )?(?:disk|drive|device|filesystem)",
            r"winerror\s*112\b",
        ])
    })
}

fn credential_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)sign[ -]?in to confirm|not a bot|\b(?:log ?in|sign[ -]?in|authentication)\b.{0,80}\b(?:required|needed|to (?:view|watch|confirm|continue))\b").unwrap()
    })
}

fn cookie_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)cookies?").unwrap())
}

fn cookie_problem_pattern() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)invalid|not valid|expired|required|authentication").unwrap()
    })
}

struct TerminalRule {
    code: &'static str,
    label: &'static str,
    pattern: Regex,
}

fn terminal_rules() -> &'static [TerminalRule] {
    static RULES: OnceLock<Vec<TerminalRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let definitions = [
            ("private", "Private video", r"private video|video is private|video is set to private"),
            ("members_only", "Members-only video", r"members[- ]only|member[- ]only|premium members|only available to .*\bmembers?\b|join this channel to get access|available to .*\bmembers\b"),
            ("age_restricted", "Age-restricted video", r"sign in to confirm your age|age[- ]restricted|age verification required|inappropriate for some users"),
            ("sign_in_required", "Sign-in required (bot check)", r"sign in to confirm (?:you'?re not a bot|your age)|confirm you'?re not a bot"),
            ("payment_required", "Paid video", r"requires payment|payment required|available for rent or purchase|rent or buy"),
            ("copyright", "Blocked by a copyright claim", r"copyright"),
            ("terminated", "Channel terminated", r"has been terminated|terminated the account"),
            ("removed", "Removed by the uploader", r"removed by the uploader|video has been removed|been removed for violating|community guidelines|video (?:has been|was) deleted"),
            ("geo_blocked", "Not available in your region", r"blocked (?:it )?(?:in|from) your (?:country|region|location)|not available (?:in|from) your (?:country|region|location)|unavailable (?:in|from) your (?:country|region|location)|not made this video available in your (?:country|region|location)|geo[- ]?restrict(?:ed|ion)?|geo[- ]?blocked"),
            ("not_found", "Video not found", r"http error 404|http error 410|does not exist|is not a valid url|unsupported url"),
            ("format_unavailable", "Requested format not available", r"requested format is not available|no matching formats|unable to find a video format"),
            ("no_formats", "No downloadable formats", r"no video formats|no formats found"),
            ("unavailable", "Video unavailable", r"video unavailable|video is unavailable|video (?:is )?(?:not available|no longer available)|no longer available|content is (?:not|no longer) available|this video does not exist"),
        ];
        definitions
            .into_iter()
            .map(|(code, label, pattern)| TerminalRule {
                code,
                label,
                pattern: Regex::new(&format!("(?i){pattern}")).unwrap(),
            })
            .collect()
    })
}

fn credential_never_rescue(code: &str) -> bool {
    matches!(
        code,
        "private"
            | "removed"
            | "geo_blocked"
            | "not_found"
            | "terminated"
            | "copyright"
            | "payment_required"
    )
}

fn credential_rescuable(code: &str) -> bool {
    matches!(code, "age_restricted" | "sign_in_required" | "members_only")
}

pub fn is_n_challenge_error(message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    let message = message.to_lowercase();
    [
        "n challenge",
        "nchallengeinput",
        "javascript runtime",
        "js runtime",
        "challenge solver",
        "remote-components",
    ]
    .into_iter()
    .any(|part| message.contains(part))
}

pub fn is_signature_challenge_error(message: &str) -> bool {
    !message.is_empty()
        && signature_patterns()
            .iter()
            .any(|pattern| pattern.is_match(message))
}

pub fn is_disk_full_error(message: &str) -> bool {
    !message.is_empty()
        && disk_patterns()
            .iter()
            .any(|pattern| pattern.is_match(message))
}

pub fn is_terminal_error_message(message: &str) -> bool {
    message
        .trim_start_matches(is_js_whitespace)
        .to_lowercase()
        .starts_with(TERMINAL_ERROR_MARKER)
}

pub fn parse_stored_terminal_error(message: &str) -> Option<StoredTerminalError> {
    if !is_terminal_error_message(message) {
        return None;
    }
    let rest =
        js_trim(&message.trim_start_matches(is_js_whitespace)[TERMINAL_ERROR_MARKER.len()..]);
    let mut parts = rest.split(" — ");
    let label = js_trim(parts.next().unwrap_or("")).to_string();
    let detail = js_trim(&parts.collect::<Vec<_>>().join(" — ")).to_string();
    Some(StoredTerminalError { label, detail })
}

pub fn classify_terminal_download_error(message: &str) -> Option<TerminalErrorInfo> {
    if message.is_empty() {
        return None;
    }
    if let Some(rule) = terminal_rules()
        .iter()
        .find(|rule| credential_never_rescue(rule.code) && rule.pattern.is_match(message))
    {
        return Some(TerminalErrorInfo {
            code: rule.code.to_string(),
            label: rule.label.to_string(),
        });
    }
    terminal_rules()
        .iter()
        .find(|rule| rule.pattern.is_match(message))
        .map(|rule| TerminalErrorInfo {
            code: rule.code.to_string(),
            label: rule.label.to_string(),
        })
}

pub fn is_format_availability_error(message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    let message = message.to_lowercase();
    [
        "requested format is not available",
        "no matching formats",
        "unable to find a video format",
    ]
    .into_iter()
    .any(|part| message.contains(part))
}

pub fn is_credential_blocked_error(message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    let stored = parse_stored_terminal_error(message);
    let detail = stored
        .as_ref()
        .map(|stored| stored.detail.as_str())
        .unwrap_or(message);
    if terminal_rules()
        .iter()
        .any(|rule| credential_never_rescue(rule.code) && rule.pattern.is_match(detail))
    {
        return false;
    }
    if let Some(stored) = &stored {
        if stored.label == "Sign-in or cookies required" {
            return true;
        }
        let rule = terminal_rules()
            .iter()
            .find(|rule| rule.label == stored.label);
        if let Some(rule) = rule {
            if credential_never_rescue(rule.code) {
                return false;
            }
            if credential_rescuable(rule.code) {
                return true;
            }
            if rule.code != "unavailable" {
                return false;
            }
        } else if stored.label != GENERIC_TERMINAL_LABEL {
            return false;
        }
    }
    let info = classify_terminal_download_error(detail);
    if let Some(info) = &info {
        if credential_rescuable(&info.code) {
            return true;
        }
        if info.code != "unavailable" {
            return false;
        }
    }
    credential_pattern().is_match(detail)
        || (cookie_pattern().is_match(detail) && cookie_problem_pattern().is_match(detail))
}

pub fn is_permanent_download_error(message: &str) -> bool {
    if is_terminal_error_message(message) {
        return true;
    }
    if message.is_empty() || is_n_challenge_error(message) {
        return false;
    }
    classify_terminal_download_error(message).is_some()
        || permanent_patterns()
            .iter()
            .any(|pattern| pattern.is_match(message))
}

pub fn is_transient_download_error(message: &str) -> bool {
    if is_disk_full_error(message) {
        return false;
    }
    if is_n_challenge_error(message) || is_signature_challenge_error(message) {
        return true;
    }
    let message = message.to_lowercase();
    [
        "unable to download",
        "connection reset",
        "connection refused",
        "timeout",
        "timed out",
        "stalled",
        "network is unreachable",
        "err_connection",
        "temporary failure",
        "temporarily unavailable",
        "could not connect",
        "too many requests",
        "rate limit",
        "rate-limit",
        "http error 408",
        "http error 425",
        "http error 429",
        "http error 5",
        "service unavailable",
        "sigabrt",
        "aborted",
        "ssl",
        "eof",
        "broken pipe",
        "giving up after",
        "read error",
        "write error",
    ]
    .into_iter()
    .any(|part| message.contains(part))
}

pub fn is_unrecoverable_resume_error(message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    let message = message.to_lowercase();
    [
        "requested range not satisfiable",
        "http error 416",
        "status code 416",
        "exists, but a control file(*.aria2) does not exist",
    ]
    .into_iter()
    .any(|part| message.contains(part))
}

pub fn is_downloader_args_error(message: &str) -> bool {
    if message.is_empty() {
        return false;
    }
    let message = message.to_lowercase();
    [
        "exited with code 28",
        "unrecognized option",
        "possible values:",
    ]
    .into_iter()
    .any(|part| message.contains(part))
}

pub fn classify_message(message: &str) -> RetryClassification {
    RetryClassification {
        n_challenge: is_n_challenge_error(message),
        signature_challenge: is_signature_challenge_error(message),
        disk_full: is_disk_full_error(message),
        permanent: is_permanent_download_error(message),
        format_availability: is_format_availability_error(message),
        terminal: classify_terminal_download_error(message),
        terminal_message: is_terminal_error_message(message),
        credential_blocked: is_credential_blocked_error(message),
        transient: is_transient_download_error(message),
        unrecoverable_resume: is_unrecoverable_resume_error(message),
        downloader_args: is_downloader_args_error(message),
    }
}

fn whitespace_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\s+").unwrap())
}

fn utf16_prefix(value: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (index, character) in value.char_indices() {
        let next = units + character.len_utf16();
        if next > max_units {
            return &value[..index];
        }
        units = next;
        if units == max_units {
            return &value[..index + character.len_utf8()];
        }
    }
    value
}

pub fn format_terminal_error_message(info: TerminalErrorInfo, raw: &str) -> String {
    let full_detail = js_trim(&whitespace_regex().replace_all(raw, " ")).to_string();
    let credential_blocked = is_credential_blocked_error(&format!(
        "{TERMINAL_ERROR_MARKER} {} — {full_detail}",
        info.label
    ));
    let label = if credential_blocked && !credential_rescuable(&info.code) {
        "Sign-in or cookies required"
    } else {
        info.label.as_str()
    };
    // The TypeScript wrapper retains its exact UTF-16 path for non-ASCII text.
    let detail = utf16_prefix(&full_detail, 300);
    let outcome = if credential_blocked {
        "skipped until fresh usable cookies are available."
    } else {
        "skipped, it will not be retried automatically."
    };
    if detail.is_empty() {
        format!("{TERMINAL_ERROR_MARKER} {label} — {outcome}")
    } else {
        format!("{TERMINAL_ERROR_MARKER} {label} — {outcome} yt-dlp: {detail}")
    }
}

pub fn next_format_fallback(current: &str) -> Option<String> {
    let key = js_trim(current).to_lowercase();
    if key.is_empty() || key == "audio" {
        return None;
    }
    let index = FORMAT_FALLBACK_LADDER
        .iter()
        .position(|rung| *rung == key)?;
    FORMAT_FALLBACK_LADDER
        .get(index + 1)
        .map(|rung| rung.to_string())
}

pub fn format_switch_message(from: &str, to: &str) -> String {
    format!("Requested quality {from} is not available for this video — switched to {to} automatically.")
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressAwareRetryState {
    retry_count: f64,
    best_progress: f64,
    made_progress: bool,
    exhausted: bool,
}

pub fn progress_aware_retry_state(
    retry_count: f64,
    best_progress: f64,
    progress: f64,
    retry_cap: f64,
) -> ProgressAwareRetryState {
    let count = 0.0f64.max(if retry_count.is_finite() {
        retry_count.floor()
    } else {
        0.0
    });
    let best = 100.0f64.min(0.0f64.max(if best_progress.is_finite() {
        best_progress
    } else {
        0.0
    }));
    let current = 100.0f64.min(0.0f64.max(if progress.is_finite() { progress } else { 0.0 }));
    let made_progress = current > best;
    let next_count = if made_progress { count } else { count + 1.0 };
    let cap = 1.0f64.max(if retry_cap.is_finite() {
        retry_cap.floor()
    } else {
        1.0
    });
    ProgressAwareRetryState {
        retry_count: next_count,
        best_progress: best.max(current),
        made_progress,
        exhausted: next_count >= cap,
    }
}

pub fn compute_backoff_ms(attempt: f64, base_seconds: f64, max_seconds: f64, random: f64) -> f64 {
    let attempt = 0.0f64.max(if attempt.is_finite() {
        attempt.floor()
    } else {
        0.0
    });
    let base = 1.0f64.max(base_seconds);
    let cap = base.max(max_seconds);
    let exponential = cap.min(base * 2.0f64.powf(attempt));
    let jittered = exponential * (1.0 + 0.3 * 1.0f64.min(0.0f64.max(random)));
    (jittered * 1000.0).round()
}

pub fn compute_download_timeout_ms(
    duration_seconds: f64,
    min_minutes: f64,
    max_minutes: f64,
) -> f64 {
    let min_ms = 1.0f64.max(min_minutes) * 60_000.0;
    let max_ms = (min_ms / 60_000.0).max(max_minutes) * 60_000.0;
    if duration_seconds == 0.0 || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return min_ms;
    }
    let scaled = (duration_seconds * 3.0 + 300.0) * 1000.0;
    min_ms.max(max_ms.min(scaled))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_failures_are_retryable_not_permanent() {
        let message =
            "NChallengeInput: n challenge solving failed; Requested format is not available";
        assert!(is_n_challenge_error(message));
        assert!(is_transient_download_error(message));
        assert!(is_format_availability_error(message));
        assert!(!is_permanent_download_error(message));
    }

    #[test]
    fn hard_terminal_evidence_wins_over_cookie_hints() {
        assert!(is_permanent_download_error("Private video. Login required"));
        assert!(!is_credential_blocked_error(
            "Private video. Login required"
        ));
        assert!(is_credential_blocked_error(
            "Video unavailable. Login required"
        ));
        assert_eq!(
            classify_terminal_download_error("This video is geo-restricted")
                .unwrap()
                .code,
            "geo_blocked"
        );
    }

    #[test]
    fn terminal_records_round_trip_and_fallbacks_bottom_out() {
        let stored = format_terminal_error_message(
            TerminalErrorInfo {
                code: "private".to_string(),
                label: "Private video".to_string(),
            },
            "ERROR: This video is private",
        );
        assert!(is_terminal_error_message(&stored));
        assert!(parse_stored_terminal_error(&stored)
            .unwrap()
            .detail
            .contains("This video is private"));
        assert_eq!(next_format_fallback("480p").as_deref(), Some("highest"));
        assert_eq!(next_format_fallback("highest"), None);
        assert_eq!(next_format_fallback("audio"), None);
    }

    #[test]
    fn progress_controls_retry_budget_and_timeouts_scale() {
        let state = progress_aware_retry_state(2.0, 20.0, 35.0, 4.0);
        assert_eq!(state.retry_count, 2.0);
        assert_eq!(state.best_progress, 35.0);
        assert!(state.made_progress);
        assert!(!state.exhausted);
        assert_eq!(compute_backoff_ms(2.0, 30.0, 900.0, 0.0), 120_000.0);
        assert_eq!(
            compute_download_timeout_ms(1800.0, 15.0, 180.0),
            95.0 * 60_000.0
        );
    }
}
