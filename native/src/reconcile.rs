use crate::claims;
use crate::retry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, PartialEq)]
pub struct StaleClaimThresholds {
    download: String,
    conversion: String,
    metadata: String,
}

pub fn stale_claim_thresholds(max_download_minutes: f64) -> StaleClaimThresholds {
    let minutes = if max_download_minutes.is_finite() {
        max_download_minutes
    } else {
        f64::NAN
    };
    StaleClaimThresholds {
        download: format!("-{} minutes", 20.0f64.max(minutes)),
        conversion: "-3 hours".to_string(),
        metadata: "-15 minutes".to_string(),
    }
}

pub fn stale_claim_condition(stage: &str, modifier: &str, alias: &str) -> Result<String, String> {
    let columns = claims::claim_columns(stage).ok_or_else(|| "invalid claim stage".to_string())?;
    let heartbeat = format!(
        "COALESCE({alias}{}, {alias}{})",
        columns.heartbeat, columns.at
    );
    Ok(format!(
        "({heartbeat} IS NULL OR {heartbeat} < datetime('now', '{modifier}'))"
    ))
}

pub fn partial_sidecars(partial_path: &str) -> Vec<String> {
    vec![partial_path.to_string(), format!("{partial_path}.aria2")]
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialCleanupRequest {
    pub status: String,
    #[serde(default)]
    pub retries: f64,
    pub last_error: Option<String>,
    pub age_ms: f64,
    #[serde(default)]
    pub cap: f64,
    #[serde(default)]
    pub has_config: bool,
    #[serde(default)]
    pub requeue_failed_after_minutes: f64,
    #[serde(default = "default_partial_max_age")]
    pub partial_max_age_ms: f64,
}

fn default_partial_max_age() -> f64 {
    7.0 * 24.0 * 60.0 * 60.0 * 1000.0
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartialCleanupDecision {
    waiting_for_cooldown_retry: bool,
    waiting_for_cookies: bool,
    may_resume: bool,
    exhausted: bool,
    abandoned: bool,
    ancient: bool,
    remove: bool,
}

pub fn partial_cleanup_decision(request: &PartialCleanupRequest) -> PartialCleanupDecision {
    let error = request.last_error.as_deref().unwrap_or("");
    let failed = request.status == "failed";
    let waiting_for_cooldown_retry = failed
        && request.has_config
        && request.requeue_failed_after_minutes > 0.0
        && !retry::is_permanent_download_error(error);
    let waiting_for_cookies = failed && retry::is_credential_blocked_error(error);
    let may_resume = waiting_for_cooldown_retry || waiting_for_cookies;
    let exhausted = failed && request.cap > 0.0 && request.retries >= request.cap && !may_resume;
    let resumable = matches!(
        request.status.as_str(),
        "pending" | "downloading" | "paused" | "waiting_live"
    );
    let abandoned = !resumable && !may_resume;
    let ancient = abandoned && request.age_ms > request.partial_max_age_ms;
    PartialCleanupDecision {
        waiting_for_cooldown_retry,
        waiting_for_cookies,
        may_resume,
        exhausted,
        abandoned,
        ancient,
        remove: exhausted || ancient,
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCleanupDecision {
    remove: bool,
}

pub fn orphan_cleanup_decision(
    age_ms: f64,
    max_age_ms: f64,
    owned: bool,
    belongs_to_active_job: bool,
) -> OrphanCleanupDecision {
    OrphanCleanupDecision {
        remove: !owned && !belongs_to_active_job && age_ms > max_age_ms,
    }
}

pub fn requeue_cooldown_modifier(minutes: f64, ignore_cooldown: bool) -> String {
    if ignore_cooldown {
        String::new()
    } else {
        format!(
            "AND updated_at < datetime('now', '-{} minutes')",
            minutes.floor()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_predicates_use_heartbeat_then_claim_timestamp() {
        let thresholds = stale_claim_thresholds(45.0);
        assert_eq!(thresholds.download, "-45 minutes");
        assert_eq!(
            stale_claim_condition("download", &thresholds.download, "j.").unwrap(),
            "(COALESCE(j.download_heartbeat_at, j.download_claimed_at) IS NULL OR COALESCE(j.download_heartbeat_at, j.download_claimed_at) < datetime('now', '-45 minutes'))"
        );
        assert_eq!(
            partial_sidecars("video.part"),
            vec!["video.part".to_string(), "video.part.aria2".to_string()]
        );
    }

    #[test]
    fn cleanup_preserves_cooldown_cookie_and_resumable_partials() {
        let cooldown = partial_cleanup_decision(&PartialCleanupRequest {
            status: "failed".to_string(),
            retries: 99.0,
            last_error: Some("timeout".to_string()),
            age_ms: default_partial_max_age() * 2.0,
            cap: 4.0,
            has_config: true,
            requeue_failed_after_minutes: 30.0,
            partial_max_age_ms: default_partial_max_age(),
        });
        assert!(cooldown.may_resume);
        assert!(!cooldown.remove);
        let terminal = partial_cleanup_decision(&PartialCleanupRequest {
            status: "failed".to_string(),
            retries: 4.0,
            last_error: Some("Private video".to_string()),
            age_ms: 0.0,
            cap: 4.0,
            has_config: false,
            requeue_failed_after_minutes: 0.0,
            partial_max_age_ms: default_partial_max_age(),
        });
        assert!(terminal.exhausted);
        assert!(terminal.remove);
    }
}
