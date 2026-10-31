mod archive;
mod audio;
mod claims;
mod config;
mod download_args;
mod download_output;
mod lease;
mod reconcile;
mod retry;
mod runtime;
mod scaling;
mod scanner;
mod settings;
mod sources;
mod text;
mod tools;

use config::{ConfigError, Issue};
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

const YTA_CORE_ABI_VERSION: u32 = 4;

#[derive(Serialize)]
struct ErrorBody {
    code: String,
    message: String,
    path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issues: Option<Vec<Issue>>,
}

fn success<T: Serialize>(value: T) -> String {
    serde_json::to_string(&serde_json::json!({"ok": true, "value": value})).unwrap_or_else(
        |error| {
            failure_with_code(
                "NATIVE_SERIALIZATION",
                format!("Could not serialize native result: {error}"),
            )
        },
    )
}

fn failure_with_code(code: &str, message: impl Into<String>) -> String {
    let body = ErrorBody {
        code: code.to_string(),
        message: message.into(),
        path: Vec::new(),
        issues: None,
    };
    serde_json::to_string(&serde_json::json!({"ok": false, "error": body}))
        .expect("serializing a static error cannot fail")
}

fn failure(message: impl Into<String>) -> String {
    failure_with_code("NATIVE_ERROR", message)
}

fn config_failure(error: ConfigError) -> String {
    let first = error
        .issues
        .first()
        .cloned()
        .unwrap_or_else(|| Issue::new("", "invalid configuration"));
    let body = ErrorBody {
        code: "CONFIG_VALIDATION".to_string(),
        message: first.message,
        path: first.path,
        issues: Some(error.issues),
    };
    serde_json::to_string(&serde_json::json!({"ok": false, "error": body}))
        .expect("serializing validation issues cannot fail")
}

/// Never let a Rust panic unwind through N-API into Bun. The TypeScript bridge
/// treats this as an operational native failure, not as invalid user input.
fn guarded(operation: impl FnOnce() -> String) -> String {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        failure_with_code(
            "NATIVE_PANIC",
            "Rust native core operation failed unexpectedly",
        )
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str(raw).map_err(|error| error.to_string())
}

#[napi(js_name = "abiVersion")]
pub fn native_abi_version() -> u32 {
    YTA_CORE_ABI_VERSION
}

#[napi(js_name = "validateConfig")]
pub fn native_validate_config(raw: String) -> String {
    guarded(|| match config::validate_config_json(&raw) {
        Ok(config) => success(config),
        Err(error) => config_failure(error),
    })
}

#[napi(js_name = "defaultConfig")]
pub fn native_default_config() -> String {
    guarded(|| success(config::Config::default()))
}

#[napi(js_name = "prepareSettings")]
pub fn native_prepare_settings(current: String, patch: String, fields: String) -> String {
    guarded(|| {
        let result: Result<settings::PreparedSettings, String> = (|| {
            let current = parse_json::<Value>(&current)?;
            let patch = parse_json::<Value>(&patch)?;
            let fields = parse_json::<Vec<settings::SettingField>>(&fields)?;
            settings::prepare_settings(current, patch, fields)
        })();
        match result {
            Ok(prepared) => success(prepared),
            Err(error) => failure(error),
        }
    })
}

#[napi(js_name = "parseSourceUrl")]
pub fn native_parse_source_url(input: String, single_video: bool) -> String {
    guarded(|| match sources::parse_source_url(&input, single_video) {
        Ok(source) => success(source),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "parseSourceUrls")]
pub fn native_parse_source_urls(inputs: String, single_video: bool) -> String {
    guarded(|| match parse_json::<Vec<String>>(&inputs) {
        Ok(inputs) => success(sources::parse_source_urls(inputs, single_video)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "sourceIdentity")]
pub fn native_source_identity(input: String) -> String {
    guarded(|| success(sources::source_identity(&input)))
}

#[napi(js_name = "parseOfflineSwitch")]
pub fn native_parse_offline_switch(raw: String) -> String {
    guarded(|| success(runtime::parse_offline_switch(&raw)))
}

#[napi(js_name = "offlineOverride")]
pub fn native_offline_override(argv: String, env: String) -> String {
    guarded(|| {
        let result: Result<Option<bool>, String> = (|| {
            let argv = parse_json::<Vec<String>>(&argv)?;
            let env = parse_json::<Option<Map<String, Value>>>(&env)?;
            Ok(runtime::offline_override(argv, env))
        })();
        match result {
            Ok(value) => success(value),
            Err(error) => failure(error),
        }
    })
}

#[napi(js_name = "lanOverride")]
pub fn native_lan_override(argv: String, env: String) -> String {
    guarded(|| {
        let result: Result<Option<bool>, String> = (|| {
            let argv = parse_json::<Vec<String>>(&argv)?;
            let env = parse_json::<Option<Map<String, Value>>>(&env)?;
            Ok(runtime::lan_override(argv, env))
        })();
        match result {
            Ok(value) => success(value),
            Err(error) => failure(error),
        }
    })
}

#[napi(js_name = "webPortOverride")]
pub fn native_web_port_override(argv: String) -> String {
    guarded(
        || match parse_json::<Vec<String>>(&argv).and_then(runtime::web_port_override) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "webTokenOverride")]
pub fn native_web_token_override(argv: String) -> String {
    guarded(
        || match parse_json::<Vec<String>>(&argv).and_then(runtime::web_token_override) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "toolCandidates")]
pub fn native_tool_candidates(request: String) -> String {
    guarded(
        || match parse_json::<tools::ToolCandidateRequest>(&request) {
            Ok(request) => success(tools::tool_candidates(request)),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "bunInterpreterPath")]
pub fn native_bun_interpreter_path(exec_path: String) -> String {
    guarded(|| success(tools::bun_interpreter_path(&exec_path)))
}

#[napi(js_name = "extractAudioTracks")]
pub fn native_extract_audio_tracks(info: String) -> String {
    guarded(|| match parse_json::<Value>(&info) {
        Ok(info) => success(audio::extract_audio_tracks(&info)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "selectAudioTracks")]
pub fn native_select_audio_tracks(request: String) -> String {
    guarded(|| match parse_json::<audio::SelectionRequest>(&request) {
        Ok(request) => success(audio::select_audio_tracks(request)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "multiAudioFormatSelector")]
pub fn native_multi_audio_format_selector(base_format: String, tracks: String) -> String {
    guarded(|| match parse_json::<Vec<Value>>(&tracks) {
        Ok(tracks) => success(audio::multi_audio_format_selector(&base_format, &tracks)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "parseDownloadPath")]
pub fn native_parse_download_path(line: String) -> String {
    guarded(|| success(download_output::parse_download_path(&line)))
}

#[napi(js_name = "parseAria2cReadout")]
pub fn native_parse_aria2c_readout(line: String) -> String {
    guarded(|| match download_output::parse_aria2c_readout(&line) {
        Ok(readout) => success(readout),
        Err(()) => failure_with_code(
            "NATIVE_UNSUPPORTED",
            "Non-finite aria2c readout requires TypeScript compatibility handling",
        ),
    })
}

#[napi(js_name = "nextSlotTarget")]
pub fn native_next_slot_target(input: String) -> String {
    guarded(|| match parse_json::<scaling::SlotTargetInput>(&input) {
        Ok(input) => success(scaling::next_slot_target(input)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "perDownloadTransfers")]
pub fn native_per_download_transfers(configured: f64, active_slots: f64, budget: f64) -> String {
    guarded(|| {
        success(scaling::per_download_transfers(
            configured,
            active_slots,
            budget,
        ))
    })
}

#[napi(js_name = "parseAria2cSplitSizeBytes")]
pub fn native_parse_aria2c_split_size_bytes(size: String) -> String {
    guarded(|| {
        let value = scaling::parse_aria2c_split_size_bytes(&size);
        if value.is_some_and(|number| !number.is_finite()) {
            failure_with_code(
                "NATIVE_UNSUPPORTED",
                "Non-finite split size requires TypeScript compatibility handling",
            )
        } else {
            success(value)
        }
    })
}

#[napi(js_name = "retryClassification")]
pub fn native_retry_classification(message: String) -> String {
    guarded(|| success(retry::classify_message(&message)))
}

#[napi(js_name = "formatTerminalErrorMessage")]
pub fn native_format_terminal_error_message(info: String, raw: String) -> String {
    guarded(|| match parse_json::<retry::TerminalErrorInfo>(&info) {
        Ok(info) => success(retry::format_terminal_error_message(info, &raw)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "parseStoredTerminalError")]
pub fn native_parse_stored_terminal_error(message: String) -> String {
    guarded(|| success(retry::parse_stored_terminal_error(&message)))
}

#[napi(js_name = "nextFormatFallback")]
pub fn native_next_format_fallback(current: String) -> String {
    guarded(|| success(retry::next_format_fallback(&current)))
}

#[napi(js_name = "formatSwitchMessage")]
pub fn native_format_switch_message(from: String, to: String) -> String {
    guarded(|| success(retry::format_switch_message(&from, &to)))
}

#[napi(js_name = "computeBackoffMs")]
pub fn native_compute_backoff_ms(
    attempt: f64,
    base_seconds: f64,
    max_seconds: f64,
    random: f64,
) -> String {
    guarded(|| {
        success(retry::compute_backoff_ms(
            attempt,
            base_seconds,
            max_seconds,
            random,
        ))
    })
}

#[napi(js_name = "computeDownloadTimeoutMs")]
pub fn native_compute_download_timeout_ms(
    duration_seconds: f64,
    min_minutes: f64,
    max_minutes: f64,
) -> String {
    guarded(|| {
        success(retry::compute_download_timeout_ms(
            duration_seconds,
            min_minutes,
            max_minutes,
        ))
    })
}

#[napi(js_name = "progressAwareRetryState")]
pub fn native_progress_aware_retry_state(
    retry_count: f64,
    best_progress: f64,
    progress: f64,
    retry_cap: f64,
) -> String {
    guarded(|| {
        success(retry::progress_aware_retry_state(
            retry_count,
            best_progress,
            progress,
            retry_cap,
        ))
    })
}

#[napi(js_name = "claimColumns")]
pub fn native_claim_columns(stage: String) -> String {
    guarded(|| success(claims::claim_columns(&stage)))
}

#[napi(js_name = "claimRef")]
pub fn native_claim_ref(stage: String, row: String) -> String {
    guarded(|| match claims::claim_ref(&stage, &row) {
        Ok(value) => success(value),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "claimUpdateSql")]
pub fn native_claim_update_sql(
    stage: String,
    set_clause: String,
    extra_condition: Option<String>,
) -> String {
    guarded(
        || match claims::claim_update_sql(&stage, &set_clause, extra_condition.as_deref()) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "claimReleaseSet")]
pub fn native_claim_release_set(stage: String, set_clause: String) -> String {
    guarded(|| match claims::claim_release_set(&stage, &set_clause) {
        Ok(value) => success(value),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "perVideoCap")]
pub fn native_per_video_cap(config: String) -> String {
    guarded(|| match claims::per_video_cap(&config) {
        Ok(value) => success(value),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "leaseExpired")]
pub fn native_lease_expired(lease: String, expires_at_ms: f64, now_ms: f64) -> String {
    guarded(
        || match lease::lease_expired(&lease, expires_at_ms, now_ms) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "holdsLease")]
pub fn native_holds_lease(
    lease: String,
    current_lease: String,
    expires_at_ms: f64,
    now_ms: f64,
) -> String {
    guarded(
        || match lease::holds_lease(&lease, &current_lease, expires_at_ms, now_ms) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "leaseAcquisition")]
pub fn native_lease_acquisition(
    lease: String,
    owner: String,
    expires_at_ms: f64,
    now_ms: f64,
    owner_gone: bool,
) -> String {
    guarded(
        || match lease::lease_acquisition(&lease, &owner, expires_at_ms, now_ms, owner_gone) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "staleClaimThresholds")]
pub fn native_stale_claim_thresholds(max_download_minutes: f64) -> String {
    guarded(|| success(reconcile::stale_claim_thresholds(max_download_minutes)))
}

#[napi(js_name = "staleClaimCondition")]
pub fn native_stale_claim_condition(stage: String, modifier: String, alias: String) -> String {
    guarded(
        || match reconcile::stale_claim_condition(&stage, &modifier, &alias) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "partialSidecars")]
pub fn native_partial_sidecars(partial_path: String) -> String {
    guarded(|| success(reconcile::partial_sidecars(&partial_path)))
}

#[napi(js_name = "partialCleanupDecision")]
pub fn native_partial_cleanup_decision(request: String) -> String {
    guarded(
        || match parse_json::<reconcile::PartialCleanupRequest>(&request) {
            Ok(request) => success(reconcile::partial_cleanup_decision(&request)),
            Err(error) => failure(error),
        },
    )
}

#[napi(js_name = "orphanCleanupDecision")]
pub fn native_orphan_cleanup_decision(
    age_ms: f64,
    max_age_ms: f64,
    owned: bool,
    belongs_to_active_job: bool,
) -> String {
    guarded(|| {
        success(reconcile::orphan_cleanup_decision(
            age_ms,
            max_age_ms,
            owned,
            belongs_to_active_job,
        ))
    })
}

#[napi(js_name = "requeueCooldownModifier")]
pub fn native_requeue_cooldown_modifier(minutes: f64, ignore_cooldown: bool) -> String {
    guarded(|| {
        success(reconcile::requeue_cooldown_modifier(
            minutes,
            ignore_cooldown,
        ))
    })
}

#[napi(js_name = "resolveDownloaderEngine")]
pub fn native_resolve_downloader_engine(use_aria2c: bool, aria2c_available: bool) -> String {
    guarded(|| {
        success(download_args::resolve_downloader_engine(
            use_aria2c,
            aria2c_available,
        ))
    })
}

#[napi(js_name = "effectiveDownloadFormat")]
pub fn native_effective_download_format(
    job_quality: Option<String>,
    job_target: Option<String>,
    config_quality: String,
    config_target: String,
    valid_qualities: String,
) -> String {
    guarded(|| {
        match download_args::effective_download_format(
            job_quality.as_deref(),
            job_target.as_deref(),
            &config_quality,
            &config_target,
            &valid_qualities,
        ) {
            Ok(value) => success(value),
            Err(error) => failure(error),
        }
    })
}

#[napi(js_name = "buildAria2cArgs")]
pub fn native_build_aria2c_args(
    connections_per_download: f64,
    active_slots: f64,
    connection_budget: f64,
    split: String,
) -> String {
    guarded(|| {
        success(download_args::build_aria2c_args(
            connections_per_download,
            active_slots,
            connection_budget,
            &split,
        ))
    })
}

#[napi(js_name = "computePerWorkerLimitBytesPerSec")]
pub fn native_compute_per_worker_limit(max_bandwidth_kbps: f64, active_slots: f64) -> String {
    guarded(|| {
        success(download_args::compute_per_worker_limit(
            max_bandwidth_kbps,
            active_slots,
        ))
    })
}

#[napi(js_name = "parseListingLines")]
pub fn native_parse_listing_lines(lines: String) -> String {
    guarded(|| match parse_json::<Vec<String>>(&lines) {
        Ok(lines) => success(scanner::parse_listing_lines(lines)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "listingEntryKind")]
pub fn native_listing_entry_kind(id: String) -> String {
    guarded(|| success(scanner::listing_entry_kind(&id)))
}

#[napi(js_name = "channelFolderName")]
pub fn native_channel_folder_name(playlist: String, channel: Option<String>) -> String {
    guarded(|| success(scanner::channel_folder_name(&playlist, channel.as_deref())))
}

#[napi(js_name = "isShortsTabItem")]
pub fn native_is_shorts_tab_item(playlist: String) -> String {
    guarded(|| success(scanner::shorts_tab_item(&playlist)))
}

#[napi(js_name = "normalizeVideoUrl")]
pub fn native_normalize_video_url(url: String) -> String {
    guarded(|| success(scanner::normalize_video_url(&url)))
}

#[napi(js_name = "prepareIngestBatch")]
pub fn native_prepare_ingest_batch(request: String) -> String {
    guarded(|| match parse_json::<scanner::IngestRequest>(&request) {
        Ok(request) => success(scanner::prepare_ingest(request)),
        Err(error) => failure(error),
    })
}

#[napi(js_name = "parseArchiveIds")]
pub fn native_parse_archive_ids(text: String) -> String {
    guarded(|| success(archive::parse_archive_ids(&text)))
}

#[napi(js_name = "removeArchiveId")]
pub fn native_remove_archive_id(text: String, video_id: String) -> String {
    guarded(|| success(archive::remove_archive_id(&text, &video_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_is_contained_and_reported_as_an_operational_error() {
        let response = guarded(|| panic!("intentional test panic"));
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["ok"], Value::Bool(false));
        assert_eq!(
            value["error"]["code"],
            Value::String("NATIVE_PANIC".to_string())
        );
    }
}
