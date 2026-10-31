use crate::text::{js_string, js_trim};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    format_id: String,
    language: String,
    label: String,
    tbr: Option<f64>,
    acodec: Option<String>,
    is_default: bool,
}

/// Track index encoded in a YouTube audio format id (`251-2` -> 2).
fn track_index_of(format_id: &str) -> f64 {
    let Some((_, suffix)) = format_id.rsplit_once('-') else {
        return 0.0;
    };
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return 0.0;
    }
    // parseInt can also produce Infinity for an extraordinarily long suffix.
    suffix.parse::<f64>().unwrap_or(f64::INFINITY)
}

fn track_label(format: &serde_json::Map<String, Value>, language: &str) -> String {
    let Some(audio_track) = format.get("audio_track") else {
        return language.to_string();
    };
    if let Some(label) = audio_track.as_str().map(js_trim).filter(|v| !v.is_empty()) {
        return label.to_string();
    }
    if let Some(object) = audio_track.as_object() {
        for key in ["display_name", "displayName", "name", "id"] {
            if let Some(label) = object
                .get(key)
                .and_then(Value::as_str)
                .map(js_trim)
                .filter(|value| !value.is_empty())
            {
                return label.to_string();
            }
        }
    }
    language.to_string()
}

/// Best stream first: bitrate, then Opus, then a deterministic tie-break.
fn prefer_stream(a: &AudioTrack, b: &AudioTrack) -> Ordering {
    let ta = a.tbr.unwrap_or(-1.0);
    let tb = b.tbr.unwrap_or(-1.0);
    tb.partial_cmp(&ta)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            let a_opus = a
                .acodec
                .as_deref()
                .is_some_and(|codec| codec.contains("opus"));
            let b_opus = b
                .acodec
                .as_deref()
                .is_some_and(|codec| codec.contains("opus"));
            b_opus.cmp(&a_opus)
        })
        .then_with(|| a.format_id.cmp(&b.format_id))
}

/// Collapse yt-dlp's quality/codec variants into one best stream per track.
pub fn extract_audio_tracks(info: &Value) -> Vec<AudioTrack> {
    let Some(formats) = info.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };
    // A Vec, rather than a HashMap, retains the same insertion-order guarantee
    // as JavaScript's Map before the final deterministic sort.
    let mut groups: Vec<((String, u64), Vec<AudioTrack>)> = Vec::new();
    for format in formats.iter().filter_map(Value::as_object) {
        let format_id = format
            .get("format_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if format_id.is_empty() || format_id.to_lowercase().ends_with("-drc") {
            continue;
        }
        let acodec = format.get("acodec").and_then(Value::as_str).unwrap_or("");
        let vcodec = format.get("vcodec").and_then(Value::as_str).unwrap_or("");
        if acodec.is_empty() || acodec == "none" || (!vcodec.is_empty() && vcodec != "none") {
            continue;
        }

        let track_index = track_index_of(format_id);
        let language = format
            .get("language")
            .and_then(Value::as_str)
            .map(js_trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("und")
            .to_string();
        let track = AudioTrack {
            format_id: format_id.to_string(),
            label: track_label(format, &language),
            language: language.clone(),
            tbr: format
                .get("tbr")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite()),
            acodec: Some(acodec.to_string()),
            is_default: track_index == 0.0,
        };
        // JavaScript's numeric interpolation has one representation for each
        // finite f64; bits give the same grouping without float formatting.
        let key = (language.to_lowercase(), track_index.to_bits());
        let existing = groups.iter().position(|(candidate, _)| candidate == &key);
        if let Some(index) = existing {
            groups[index].1.push(track);
        } else {
            groups.push((key, vec![track]));
        }
    }

    let mut tracks: Vec<AudioTrack> = groups
        .into_iter()
        .filter_map(|(_, mut bucket)| {
            bucket.sort_by(prefer_stream);
            bucket.into_iter().next()
        })
        .collect();
    tracks.sort_by(|a, b| {
        track_index_of(&a.format_id)
            .partial_cmp(&track_index_of(&b.format_id))
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.language.cmp(&b.language))
    });
    tracks
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRequest {
    tracks: Vec<Value>,
    mode: String,
    #[serde(default)]
    wanted_languages: Vec<Value>,
    #[serde(default)]
    job_selection: Option<Vec<Value>>,
}

fn normalized_languages(values: &[Value]) -> Vec<String> {
    let mut normalized = Vec::new();
    for language in values.iter().filter_map(Value::as_str) {
        let language = js_trim(language).to_lowercase();
        if !language.is_empty() && !normalized.contains(&language) {
            normalized.push(language);
        }
    }
    normalized
}

fn track_language(track: &Value) -> Option<String> {
    track
        .get("language")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
}

/// Apply a per-job selection, then the global all/languages/off policy.
pub fn select_audio_tracks(request: SelectionRequest) -> Vec<Value> {
    let SelectionRequest {
        tracks,
        mode,
        wanted_languages,
        job_selection,
    } = request;
    let selection = normalized_languages(job_selection.as_deref().unwrap_or(&[]));
    if !selection.is_empty() {
        return tracks
            .into_iter()
            .filter(|track| {
                track_language(track).is_some_and(|language| selection.contains(&language))
            })
            .collect();
    }
    if mode == "all" {
        return tracks;
    }
    if mode == "languages" {
        let wanted = normalized_languages(&wanted_languages);
        if wanted.is_empty() {
            return Vec::new();
        }
        return tracks
            .into_iter()
            .filter(|track| {
                track_language(track).is_some_and(|language| wanted.contains(&language))
            })
            .collect();
    }
    Vec::new()
}

/// Splice selected format ids into the video side of a quality preset.
pub fn multi_audio_format_selector(base_format: &str, tracks: &[Value]) -> String {
    let mut parts = base_format.split('/');
    let primary = parts.next().unwrap_or("");
    let fallback = parts.collect::<Vec<_>>().join("/");
    let video_side = primary.split('+').next().unwrap_or("");
    let ids = tracks
        .iter()
        .map(|track| match track.get("formatId") {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_string(value),
        })
        .collect::<Vec<_>>()
        .join("+");
    if fallback.is_empty() {
        format!("{video_side}+{ids}")
    } else {
        format!("{video_side}+{ids}/{fallback}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info() -> Value {
        json!({"formats": [
            {"format_id":"18", "vcodec":"avc1", "acodec":"mp4a", "tbr":500},
            {"format_id":"251-0", "vcodec":"none", "acodec":"opus", "tbr":160, "language":"en", "audio_track":{"display_name":"English (original)"}},
            {"format_id":"249-0", "vcodec":"none", "acodec":"opus", "tbr":70, "language":"en"},
            {"format_id":"251-0-drc", "vcodec":"none", "acodec":"opus", "tbr":160, "language":"en"},
            {"format_id":"251-1", "vcodec":"none", "acodec":"opus", "tbr":150, "language":"es"}
        ]})
    }

    #[test]
    fn extracts_only_the_best_non_drc_audio_streams() {
        let tracks = extract_audio_tracks(&info());
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].format_id, "251-0");
        assert_eq!(tracks[0].label, "English (original)");
        assert_eq!(tracks[0].tbr, Some(160.0));
        assert!(tracks[0].is_default);
        assert_eq!(tracks[1].language, "es");
    }

    #[test]
    fn per_job_languages_override_the_global_mode() {
        let tracks = serde_json::to_value(extract_audio_tracks(&info())).unwrap();
        let selected = select_audio_tracks(SelectionRequest {
            tracks: tracks.as_array().unwrap().clone(),
            mode: "off".to_string(),
            wanted_languages: Vec::new(),
            job_selection: Some(vec![json!(" ES ")]),
        });
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["language"], "es");
    }

    #[test]
    fn selector_preserves_the_video_side_and_fallback() {
        let tracks = serde_json::to_value(extract_audio_tracks(&info())).unwrap();
        assert_eq!(
            multi_audio_format_selector(
                "bv[height<=1080]+ba/b[height<=1080]",
                tracks.as_array().unwrap(),
            ),
            "bv[height<=1080]+251-0+251-1/b[height<=1080]"
        );
    }
}
