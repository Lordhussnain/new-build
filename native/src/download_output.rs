use crate::text::js_trim;
use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

const DOWNLOAD_PATH_PREFIX: &str = "FILEPATH:";
const MAX_DOWNLOAD_PATH_LENGTH: usize = 4096;

/// Only accept the explicit after_move record. UTF-16 length intentionally
/// matches JavaScript's String.length budget for non-ASCII paths.
pub fn parse_download_path(line: &str) -> Option<String> {
    let path = line.strip_prefix(DOWNLOAD_PATH_PREFIX)?;
    if js_trim(path).is_empty()
        || path.encode_utf16().count() > MAX_DOWNLOAD_PATH_LENGTH
        || path.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    {
        return None;
    }
    Some(path.to_string())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Aria2cReadout {
    percent: f64,
    speed_bps: f64,
    eta_seconds: f64,
    total_bytes: f64,
    downloaded_bytes: f64,
}

fn readout_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)^\[#([0-9a-f]{6})\s+([^\]]*)\]").unwrap())
}

fn sizes_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        const BYTES: &str = r"[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:[KMGT]i?)?B";
        Regex::new(&format!(r"(?i)({BYTES})/({BYTES})")).unwrap()
    })
}

fn percent_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\(([0-9]+(?:\.[0-9]+)?)%\)").unwrap())
}

fn speed_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?:^|\s)DL:(\S+)(?:\s|$)").unwrap())
}

fn eta_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?:^|\s)ETA:((?:[0-9]+h)?(?:[0-9]+m)?(?:[0-9]+s)?)(?:\s|$)").unwrap()
    })
}

fn eta_parts_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$").unwrap())
}

fn speed_value_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)([0-9.]+)\s*([KMGT]?i?B)").unwrap())
}

/// JavaScript parseFloat consumes the valid prefix rather than rejecting a
/// string such as `1.2.3` outright. aria2 normally emits simple decimals, but
/// retaining this behavior keeps the compatibility boundary exact.
fn parse_float_prefix(value: &str) -> f64 {
    let bytes = value.as_bytes();
    let mut end = 0;
    let mut dots = 0;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte.is_ascii_digit() {
            end = index + 1;
        } else if byte == b'.' && dots == 0 {
            dots += 1;
            end = index + 1;
        } else {
            break;
        }
    }
    value[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// Parse a yt-dlp/aria2 size or speed token into bytes.
fn parse_speed_to_bytes_per_sec(speed: &str) -> f64 {
    if speed.is_empty() || js_trim(speed).is_empty() || speed.to_lowercase() == "na" {
        return 0.0;
    }
    let Some(captures) = speed_value_regex().captures(speed) else {
        return 0.0;
    };
    let value = parse_float_prefix(&captures[1]);
    let unit = captures[2].to_lowercase().replace("ib", "b");
    let multiplier = match unit.as_str() {
        "kb" => 1024.0,
        "mb" => 1024.0 * 1024.0,
        "gb" => 1024.0 * 1024.0 * 1024.0,
        "tb" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    value * multiplier
}

fn parse_aria2c_size(size: &str) -> f64 {
    parse_speed_to_bytes_per_sec(&size.replace(',', ""))
}

fn parse_aria2c_eta(eta: &str) -> f64 {
    let Some(captures) = eta_parts_regex().captures(eta) else {
        return 0.0;
    };
    let part = |index| {
        captures
            .get(index)
            .and_then(|value| value.as_str().parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    part(1) * 3600.0 + part(2) * 60.0 + part(3)
}

/// Parse one single-group aria2c console record. The error variant is reserved
/// for non-finite results that JSON cannot faithfully carry back to JavaScript;
/// the TypeScript wrapper handles that compatibility case locally.
pub fn parse_aria2c_readout(line: &str) -> Result<Option<Aria2cReadout>, ()> {
    let text = js_trim(line);
    if !text.starts_with("[#") {
        return Ok(None);
    }
    let Some(group) = readout_regex().captures(text) else {
        return Ok(None);
    };
    let body = group.get(2).map(|value| value.as_str()).unwrap_or("");

    let sizes = sizes_regex().captures(body);
    let downloaded_bytes = sizes
        .as_ref()
        .and_then(|captures| captures.get(1))
        .map(|value| parse_aria2c_size(value.as_str()))
        .unwrap_or(0.0);
    let total_bytes = sizes
        .as_ref()
        .and_then(|captures| captures.get(2))
        .map(|value| parse_aria2c_size(value.as_str()))
        .unwrap_or(0.0);

    let mut percent = percent_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<f64>().ok())
        .unwrap_or(f64::NAN);
    if percent.is_nan() && total_bytes > 0.0 {
        percent = (downloaded_bytes / total_bytes) * 100.0;
    }
    if !percent.is_finite() {
        return Ok(None);
    }

    let speed_bps = speed_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|value| parse_speed_to_bytes_per_sec(value.as_str()))
        .unwrap_or(0.0);
    let eta_seconds = eta_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|value| parse_aria2c_eta(value.as_str()))
        .unwrap_or(0.0);
    if ![speed_bps, eta_seconds, total_bytes, downloaded_bytes]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err(());
    }
    Ok(Some(Aria2cReadout {
        percent,
        speed_bps,
        eta_seconds,
        total_bytes,
        downloaded_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_require_the_marker_and_respect_utf16_limits() {
        assert_eq!(
            parse_download_path("FILEPATH:C:\\Downloads\\数学 🧮.mp4"),
            Some("C:\\Downloads\\数学 🧮.mp4".to_string())
        );
        assert_eq!(parse_download_path("log FILEPATH:video.mp4"), None);
        assert_eq!(parse_download_path("FILEPATH:file\n.mp4"), None);
        assert_eq!(
            parse_download_path(&format!("FILEPATH:{}", "x".repeat(4097))),
            None
        );
    }

    #[test]
    fn parses_sizes_speed_percentage_and_eta() {
        let readout =
            parse_aria2c_readout(" [#208c72 1.4MiB/3.0MiB(48%) CN:16 DL:1.2MiB ETA:2m30s] ")
                .unwrap()
                .unwrap();
        assert_eq!(readout.percent, 48.0);
        assert_eq!(readout.speed_bps, 1.2 * 1024.0 * 1024.0);
        assert_eq!(readout.eta_seconds, 150.0);
        assert_eq!(readout.total_bytes, 3.0 * 1024.0 * 1024.0);
        assert_eq!(readout.downloaded_bytes, 1.4 * 1024.0 * 1024.0);
    }

    #[test]
    fn derives_percentage_and_rejects_unknown_or_multi_group_records() {
        let readout = parse_aria2c_readout("[#a1b2c3 524288B/10485760B CN:4 DL:671088B ETA:3s]")
            .unwrap()
            .unwrap();
        assert_eq!(readout.percent, 5.0);
        assert!(parse_aria2c_readout("[#a1b2c3 0B/0B CN:1 DL:0B]")
            .unwrap()
            .is_none());
        assert!(parse_aria2c_readout("[DL:1.2MiB][#208c72 1MiB/2MiB(50%)]")
            .unwrap()
            .is_none());
    }
}
