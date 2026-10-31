use crate::scaling;
use crate::text::js_trim;
use serde::Serialize;
use serde_json::Value;

pub fn resolve_downloader_engine(use_aria2c: bool, aria2c_available: bool) -> &'static str {
    if use_aria2c && aria2c_available {
        "aria2c"
    } else {
        "native"
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveDownloadFormat {
    quality: String,
    target_format: String,
}

pub fn effective_download_format(
    job_quality: Option<&str>,
    job_target: Option<&str>,
    config_quality: &str,
    config_target: &str,
    valid_qualities_json: &str,
) -> Result<EffectiveDownloadFormat, String> {
    let valid: Value = serde_json::from_str(valid_qualities_json)
        .map_err(|error| format!("Invalid quality list JSON: {error}"))?;
    let valid = valid
        .as_array()
        .ok_or_else(|| "Quality list must be an array".to_string())?;
    let quality = job_quality
        .filter(|quality| {
            valid
                .iter()
                .any(|candidate| candidate.as_str() == Some(*quality))
        })
        .unwrap_or(config_quality)
        .to_string();
    let stored = job_target.map(js_trim).unwrap_or("").to_lowercase();
    let target_format = if !stored.is_empty() {
        stored
    } else if quality == "audio" {
        "mp3".to_string()
    } else if config_target.is_empty() {
        "mp4".to_string()
    } else {
        config_target.to_lowercase()
    };
    Ok(EffectiveDownloadFormat {
        quality,
        target_format,
    })
}

pub fn build_aria2c_args(
    connections_per_download: f64,
    active_slots: f64,
    connection_budget: f64,
    split: &str,
) -> String {
    let n =
        scaling::per_download_transfers(connections_per_download, active_slots, connection_budget);
    let x = n.min(16.0);
    let mut parts = vec![format!("-x {x}"), format!("-s {n}"), format!("-j {n}")];
    let bytes = if split.is_empty() {
        None
    } else {
        scaling::parse_aria2c_split_size_bytes(split)
    };
    if !split.is_empty() && bytes.is_none() {
        parts.push(format!("--min-split-size {split}"));
    } else if bytes.map(|bytes| bytes > 1_048_576.0).unwrap_or(false) {
        parts.push(format!("--min-split-size {split}"));
    }
    parts.join(" ")
}

pub fn compute_per_worker_limit(max_bandwidth_kbps: f64, active_slots: f64) -> Option<f64> {
    if max_bandwidth_kbps <= 0.0 {
        return None;
    }
    let slots = 1.0f64.max(active_slots.floor());
    Some(1.0f64.max((max_bandwidth_kbps * 1024.0 / slots).floor()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_and_format_overrides_follow_the_same_defaults() {
        assert_eq!(resolve_downloader_engine(true, false), "native");
        assert_eq!(resolve_downloader_engine(true, true), "aria2c");
        let formats = r#"["audio","1080p","highest"]"#;
        assert_eq!(
            effective_download_format(Some("bogus"), None, "audio", "mp4", formats).unwrap(),
            EffectiveDownloadFormat {
                quality: "audio".to_string(),
                target_format: "mp3".to_string()
            }
        );
        assert_eq!(
            effective_download_format(Some("1080p"), Some(" MKV "), "audio", "mp4", formats)
                .unwrap(),
            EffectiveDownloadFormat {
                quality: "1080p".to_string(),
                target_format: "mkv".to_string()
            }
        );
    }

    #[test]
    fn aria2_and_bandwidth_plans_keep_invalid_values_visible() {
        assert_eq!(
            build_aria2c_args(32.0, 1.0, 128.0, "2M"),
            "-x 16 -s 32 -j 32 --min-split-size 2M"
        );
        assert_eq!(
            build_aria2c_args(32.0, 1.0, 128.0, "512K"),
            "-x 16 -s 32 -j 32"
        );
        assert_eq!(
            build_aria2c_args(32.0, 1.0, 128.0, "banana"),
            "-x 16 -s 32 -j 32 --min-split-size banana"
        );
        assert_eq!(compute_per_worker_limit(100.0, 4.0), Some(25_600.0));
        assert_eq!(compute_per_worker_limit(0.0, 4.0), None);
    }
}
