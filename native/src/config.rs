use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const COOKIE_BROWSER_NAMES: [&str; 8] = [
    "firefox", "chrome", "brave", "edge", "chromium", "opera", "vivaldi", "safari",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Issue {
    pub code: String,
    pub message: String,
    pub path: Vec<String>,
}

impl Issue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            code: "custom".to_string(),
            message: message.into(),
            path: if path.is_empty() {
                Vec::new()
            } else {
                vec![path]
            },
        }
    }

    fn indexed(parent: &str, index: usize, message: impl Into<String>) -> Self {
        Self {
            code: "custom".to_string(),
            message: message.into(),
            path: vec![parent.to_string(), index.to_string()],
        }
    }
}

#[derive(Debug)]
pub struct ConfigError {
    pub issues: Vec<Issue>,
}

impl ConfigError {
    fn syntax(message: impl Into<String>) -> Self {
        Self {
            issues: vec![Issue::new("", message)],
        }
    }

    fn deserialization(path: String, message: impl Into<String>) -> Self {
        Self {
            issues: vec![Issue::new(path, message)],
        }
    }
}

/// Runtime representation of config.json. Numeric fields stay f64 because the
/// original Zod schema constrains ranges, not integer-ness.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub playlists: Vec<String>,
    pub channels: Vec<String>,
    pub channel_playlists: Vec<String>,
    pub offline_mode: bool,
    pub max_concurrent_downloads: f64,
    pub max_concurrent_converts: f64,
    pub max_download_workers: f64,
    pub min_download_workers: f64,
    pub max_metadata_workers: f64,
    #[serde(rename = "maxBandwidthKBps")]
    pub max_bandwidth_kbps: f64,
    pub autoscale_enabled: bool,
    pub autoscale_ramp_step: f64,
    pub use_aria2c: bool,
    pub connections_per_download: f64,
    pub min_split_size: String,
    pub concurrent_fragments: f64,
    pub sleep_interval: f64,
    pub max_sleep_interval: f64,
    pub fragment_retries: f64,
    pub http_chunk_size: String,
    pub buffer_size: String,
    pub user_agent: String,
    pub yt_dlp_path: String,
    pub ffmpeg_path: String,
    pub aria2c_path: String,
    pub deno_path: String,
    pub validate_cookies_on_start: bool,
    pub output_root: String,
    pub archive_file: String,
    pub cookies_file: String,
    pub cookie_browsers: Vec<String>,
    pub delete_source_after_convert: bool,
    pub video_quality: String,
    pub target_format: String,
    pub subtitle_format: String,
    pub multi_audio_mode: String,
    pub audio_track_languages: Vec<String>,
    pub download_subtitles: bool,
    pub subtitle_languages: String,
    pub embed_subtitles: bool,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub write_info_json: bool,
    pub write_description: bool,
    pub write_thumbnail: bool,
    pub archive_live_streams: bool,
    pub verify_integrity: bool,
    pub skip_shorts: bool,
    pub download_shorts: bool,
    pub max_retry_attempts: f64,
    pub max_failures: f64,
    pub max_failures_per_video: f64,
    pub retry_backoff_base_seconds: f64,
    pub retry_backoff_max_seconds: f64,
    pub max_resume_attempts: f64,
    pub requeue_failed_after_minutes: f64,
    pub verify_existing_files: bool,
    pub download_timeout_minutes: f64,
    pub max_download_minutes: f64,
    #[serde(rename = "minFreeSpaceGB")]
    pub min_free_space_gb: f64,
    pub secondary_storage_path: String,
    pub daemon_mode: bool,
    pub web_port: f64,
    pub web_bind: String,
    pub web_token: String,
    pub rss_enabled: bool,
    pub rss_poll_interval_minutes: f64,
    pub rescan_interval_hours: f64,
    pub network_monitor_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            playlists: vec![],
            channels: vec![],
            channel_playlists: vec![],
            offline_mode: false,
            max_concurrent_downloads: 2.0,
            max_concurrent_converts: 2.0,
            max_download_workers: 2.0,
            min_download_workers: 1.0,
            max_metadata_workers: 2.0,
            max_bandwidth_kbps: 0.0,
            autoscale_enabled: false,
            autoscale_ramp_step: 2.0,
            use_aria2c: true,
            connections_per_download: 8.0,
            min_split_size: "1M".to_string(),
            concurrent_fragments: 8.0,
            sleep_interval: 0.0,
            max_sleep_interval: 0.0,
            fragment_retries: 10.0,
            http_chunk_size: String::new(),
            buffer_size: String::new(),
            user_agent: String::new(),
            yt_dlp_path: String::new(),
            ffmpeg_path: String::new(),
            aria2c_path: String::new(),
            deno_path: String::new(),
            validate_cookies_on_start: true,
            output_root: "./downloads".to_string(),
            archive_file: "downloaded_videos.txt".to_string(),
            cookies_file: "cookies.txt".to_string(),
            cookie_browsers: vec![
                "firefox".to_string(),
                "chrome".to_string(),
                "brave".to_string(),
            ],
            delete_source_after_convert: true,
            video_quality: "1080p".to_string(),
            target_format: "mp4".to_string(),
            subtitle_format: "srt".to_string(),
            multi_audio_mode: "off".to_string(),
            audio_track_languages: vec![],
            download_subtitles: true,
            subtitle_languages: "all".to_string(),
            embed_subtitles: true,
            embed_thumbnail: true,
            embed_metadata: true,
            write_info_json: true,
            write_description: true,
            write_thumbnail: true,
            archive_live_streams: false,
            verify_integrity: true,
            skip_shorts: true,
            download_shorts: false,
            max_retry_attempts: 3.0,
            max_failures: 10.0,
            max_failures_per_video: 4.0,
            retry_backoff_base_seconds: 30.0,
            retry_backoff_max_seconds: 900.0,
            max_resume_attempts: 5.0,
            requeue_failed_after_minutes: 30.0,
            verify_existing_files: true,
            download_timeout_minutes: 15.0,
            max_download_minutes: 180.0,
            min_free_space_gb: 10.0,
            secondary_storage_path: String::new(),
            daemon_mode: false,
            web_port: 3000.0,
            web_bind: "127.0.0.1".to_string(),
            web_token: String::new(),
            rss_enabled: true,
            rss_poll_interval_minutes: 15.0,
            rescan_interval_hours: 24.0,
            network_monitor_enabled: true,
        }
    }
}

fn number(issues: &mut Vec<Issue>, path: &str, value: f64, min: f64, max: Option<f64>) {
    if !value.is_finite() {
        issues.push(Issue::new(path, "must be a finite number"));
    } else if value < min {
        issues.push(Issue::new(path, format!("must be >= {min}")));
    } else if max.is_some_and(|limit| value > limit) {
        issues.push(Issue::new(path, format!("must be <= {}", max.unwrap())));
    }
}

fn allowed(issues: &mut Vec<Issue>, path: &str, value: &str, choices: &[&str]) {
    if !choices.contains(&value) {
        issues.push(Issue::new(
            path,
            format!("must be one of: {}", choices.join(", ")),
        ));
    }
}

pub fn validate(config: &Config) -> Vec<Issue> {
    let mut issues = Vec::new();
    number(
        &mut issues,
        "maxConcurrentDownloads",
        config.max_concurrent_downloads,
        1.0,
        Some(20.0),
    );
    number(
        &mut issues,
        "maxConcurrentConverts",
        config.max_concurrent_converts,
        1.0,
        Some(10.0),
    );
    number(
        &mut issues,
        "maxDownloadWorkers",
        config.max_download_workers,
        1.0,
        Some(20.0),
    );
    number(
        &mut issues,
        "minDownloadWorkers",
        config.min_download_workers,
        1.0,
        Some(20.0),
    );
    number(
        &mut issues,
        "maxMetadataWorkers",
        config.max_metadata_workers,
        1.0,
        Some(10.0),
    );
    number(
        &mut issues,
        "maxBandwidthKBps",
        config.max_bandwidth_kbps,
        0.0,
        None,
    );
    number(
        &mut issues,
        "autoscaleRampStep",
        config.autoscale_ramp_step,
        1.0,
        Some(10.0),
    );
    number(
        &mut issues,
        "connectionsPerDownload",
        config.connections_per_download,
        1.0,
        Some(64.0),
    );
    number(
        &mut issues,
        "concurrentFragments",
        config.concurrent_fragments,
        1.0,
        Some(64.0),
    );
    number(
        &mut issues,
        "sleepInterval",
        config.sleep_interval,
        0.0,
        Some(60.0),
    );
    number(
        &mut issues,
        "maxSleepInterval",
        config.max_sleep_interval,
        0.0,
        Some(60.0),
    );
    number(
        &mut issues,
        "fragmentRetries",
        config.fragment_retries,
        1.0,
        Some(50.0),
    );
    number(
        &mut issues,
        "maxRetryAttempts",
        config.max_retry_attempts,
        1.0,
        None,
    );
    number(&mut issues, "maxFailures", config.max_failures, 1.0, None);
    number(
        &mut issues,
        "maxFailuresPerVideo",
        config.max_failures_per_video,
        1.0,
        None,
    );
    number(
        &mut issues,
        "retryBackoffBaseSeconds",
        config.retry_backoff_base_seconds,
        1.0,
        Some(3600.0),
    );
    number(
        &mut issues,
        "retryBackoffMaxSeconds",
        config.retry_backoff_max_seconds,
        1.0,
        Some(86_400.0),
    );
    number(
        &mut issues,
        "maxResumeAttempts",
        config.max_resume_attempts,
        0.0,
        Some(100.0),
    );
    number(
        &mut issues,
        "requeueFailedAfterMinutes",
        config.requeue_failed_after_minutes,
        0.0,
        Some(20_160.0),
    );
    number(
        &mut issues,
        "downloadTimeoutMinutes",
        config.download_timeout_minutes,
        1.0,
        Some(240.0),
    );
    number(
        &mut issues,
        "maxDownloadMinutes",
        config.max_download_minutes,
        1.0,
        Some(2880.0),
    );
    number(
        &mut issues,
        "minFreeSpaceGB",
        config.min_free_space_gb,
        1.0,
        None,
    );
    number(&mut issues, "webPort", config.web_port, 1.0, Some(65_535.0));
    number(
        &mut issues,
        "rssPollIntervalMinutes",
        config.rss_poll_interval_minutes,
        1.0,
        None,
    );
    number(
        &mut issues,
        "rescanIntervalHours",
        config.rescan_interval_hours,
        0.0,
        None,
    );

    if config.user_agent.encode_utf16().count() > 512 {
        issues.push(Issue::new(
            "userAgent",
            "must contain at most 512 characters",
        ));
    }
    if config
        .user_agent
        .chars()
        .any(|c| (c as u32) <= 0x1f || c == '\u{7f}')
    {
        issues.push(Issue::new(
            "userAgent",
            "userAgent must be a single-line string",
        ));
    }

    for (index, browser) in config.cookie_browsers.iter().enumerate() {
        if !COOKIE_BROWSER_NAMES.contains(&browser.as_str()) {
            issues.push(Issue::indexed(
                "cookieBrowsers",
                index,
                format!("unsupported browser: {browser}"),
            ));
        }
    }
    allowed(
        &mut issues,
        "videoQuality",
        &config.video_quality,
        &["highest", "4k", "1440p", "1080p", "720p", "480p", "audio"],
    );
    allowed(
        &mut issues,
        "targetFormat",
        &config.target_format,
        &["mp4", "mkv", "webm", "mp3", "m4a"],
    );
    allowed(
        &mut issues,
        "subtitleFormat",
        &config.subtitle_format,
        &["srt", "vtt", "ass", "lrc"],
    );
    allowed(
        &mut issues,
        "multiAudioMode",
        &config.multi_audio_mode,
        &["off", "all", "languages"],
    );

    // Match Zod's object-first behavior: cross-field refinements run only when
    // the underlying object itself is valid.
    if issues.is_empty() {
        if config.retry_backoff_max_seconds < config.retry_backoff_base_seconds {
            issues.push(Issue::new(
                "retryBackoffMaxSeconds",
                "retryBackoffMaxSeconds must be >= retryBackoffBaseSeconds",
            ));
        }
        if config.max_download_minutes < config.download_timeout_minutes {
            issues.push(Issue::new(
                "maxDownloadMinutes",
                "maxDownloadMinutes must be >= downloadTimeoutMinutes",
            ));
        }
        if config.min_download_workers > config.max_download_workers {
            issues.push(Issue::new(
                "minDownloadWorkers",
                "minDownloadWorkers must be <= maxDownloadWorkers",
            ));
        }
    }
    issues
}

pub fn validate_config_value(value: Value) -> Result<Config, ConfigError> {
    let config = serde_path_to_error::deserialize(value).map_err(|error| {
        ConfigError::deserialization(error.path().to_string(), error.inner().to_string())
    })?;
    let issues = validate(&config);
    if issues.is_empty() {
        Ok(config)
    } else {
        Err(ConfigError { issues })
    }
}

pub fn validate_config_json(raw: &str) -> Result<Config, ConfigError> {
    let value: Value =
        serde_json::from_str(raw).map_err(|error| ConfigError::syntax(error.to_string()))?;
    validate_config_value(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shipped_defaults_are_valid() {
        assert!(validate(&Config::default()).is_empty());
    }

    #[test]
    fn enforces_ranges_enums_and_cross_field_rules() {
        let mut config = Config::default();
        config.web_port = 99_999.0;
        assert_eq!(validate(&config)[0].path, vec!["webPort"]);

        let mut config = Config::default();
        config.retry_backoff_base_seconds = 600.0;
        config.retry_backoff_max_seconds = 60.0;
        assert_eq!(validate(&config)[0].path, vec!["retryBackoffMaxSeconds"]);

        let value = serde_json::to_value(Config::default()).unwrap();
        let mut object = value.as_object().unwrap().clone();
        object.insert("targetFormat".to_string(), json!("avi"));
        let error = validate_config_value(Value::Object(object)).unwrap_err();
        assert_eq!(error.issues[0].path, vec!["targetFormat"]);
    }

    #[test]
    fn type_errors_keep_the_field_path_out_of_the_inner_message() {
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("webPort".to_string(), json!("not-a-number"));
        let error = validate_config_value(value).unwrap_err();
        assert_eq!(error.issues[0].path, vec!["webPort"]);
        assert!(!error.issues[0].message.contains("webPort:"));
    }

    #[test]
    fn unknown_keys_are_stripped_like_zod() {
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("futureSetting".to_string(), json!(true));
        let config = validate_config_value(value).unwrap();
        assert!(!serde_json::to_value(config)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("futureSetting"));
    }
}
