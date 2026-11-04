use serde::Deserialize;
use serde_json::{Map, Value};

pub const METADATA_KINDS: [&str; 4] = ["subtitles", "thumbnail", "description", "infoJson"];

const SUBTITLE_SUFFIXES: [&str; 8] = [
    ".vtt", ".srt", ".ass", ".lrc", ".ttml", ".srv1", ".srv2", ".srv3",
];
const THUMBNAIL_SUFFIXES: [&str; 5] = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const DESCRIPTION_SUFFIXES: [&str; 1] = [".description"];
const INFO_JSON_SUFFIXES: [&str; 1] = [".info.json"];
const SIDECAR_SUFFIXES: [&str; 15] = [
    ".vtt",
    ".srt",
    ".ass",
    ".lrc",
    ".ttml",
    ".srv1",
    ".srv2",
    ".srv3",
    ".description",
    ".info.json",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
];

fn suffixes_for(kind: &str) -> &'static [&'static str] {
    match kind {
        "subtitles" => &SUBTITLE_SUFFIXES,
        "thumbnail" => &THUMBNAIL_SUFFIXES,
        "description" => &DESCRIPTION_SUFFIXES,
        "infoJson" => &INFO_JSON_SUFFIXES,
        _ => &[],
    }
}

/// Filter in directory order. Lowercasing is deliberately performed before
/// both prefix and suffix checks, as in the original JavaScript implementation.
pub fn find_sidecar_files(
    entries: Vec<String>,
    media_base: &str,
    media_filename: &str,
) -> Vec<String> {
    let prefix = format!("{}.", media_base.to_lowercase());
    let media = media_filename.to_lowercase();
    entries
        .into_iter()
        .filter(|filename| {
            let lower = filename.to_lowercase();
            lower != media
                && lower.starts_with(prefix.as_str())
                && SIDECAR_SUFFIXES
                    .iter()
                    .any(|suffix| lower.ends_with(*suffix))
        })
        .collect()
}

/// Unknown, malformed and non-array values are not persisted terminal states.
pub fn parse_unavailable_metadata_kinds(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(value) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for kind in items.iter().filter_map(Value::as_str) {
        if METADATA_KINDS.contains(&kind)
            && !result.iter().any(|present| present.as_str() == kind)
        {
            result.push(kind.to_string());
        }
    }
    result
}

pub fn has_metadata_kind(sidecars: &[String], kind: &str) -> bool {
    let suffixes = suffixes_for(kind);
    sidecars.iter().any(|filename| {
        let lower = filename.to_lowercase();
        suffixes.iter().any(|suffix| lower.ends_with(*suffix))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUnavailableRequest {
    pub sidecars: Vec<String>,
    pub previously_unavailable: Option<String>,
    pub attempted: Vec<String>,
}

/// A Vec plus explicit membership checks retains JavaScript Set insertion order.
pub fn update_unavailable_metadata_kinds(request: UpdateUnavailableRequest) -> Vec<String> {
    let mut unavailable = Vec::new();
    for kind in parse_unavailable_metadata_kinds(request.previously_unavailable.as_deref()) {
        if !has_metadata_kind(&request.sidecars, &kind) {
            unavailable.push(kind);
        }
    }
    for kind in request.attempted {
        if !has_metadata_kind(&request.sidecars, &kind)
            && !unavailable.iter().any(|present| present == &kind)
        {
            unavailable.push(kind);
        }
    }
    unavailable
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingMetadataRequest {
    pub sidecars: Vec<String>,
    pub requested: Map<String, Value>,
    #[serde(default)]
    pub unavailable: Vec<String>,
}

pub fn missing_metadata_kinds(request: MissingMetadataRequest) -> Vec<String> {
    METADATA_KINDS
        .into_iter()
        .filter(|kind| {
            truthy(request.requested.get(*kind))
                && !has_metadata_kind(&request.sidecars, *kind)
                && !request
                    .unavailable
                    .iter()
                    .any(|present| present.as_str() == *kind)
        })
        .map(|kind| kind.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn discovers_only_case_insensitive_sidecars_for_the_exact_media_base() {
        assert_eq!(
            find_sidecar_files(
                strings(&[
                    "001.en.SRT",
                    "001.INFO.JSON",
                    "001.jpg",
                    "0012.jpg",
                    "002.jpg",
                    "001.MP4",
                ]),
                "001",
                "001.mp4",
            ),
            strings(&["001.en.SRT", "001.INFO.JSON", "001.jpg"])
        );
    }

    #[test]
    fn unavailable_values_are_filtered_deduplicated_and_ordered() {
        assert_eq!(
            parse_unavailable_metadata_kinds(Some(
                r#"["thumbnail","unknown","thumbnail",1,"subtitles"]"#
            )),
            strings(&["thumbnail", "subtitles"])
        );
        assert!(parse_unavailable_metadata_kinds(Some("not-json")).is_empty());
        assert!(parse_unavailable_metadata_kinds(Some("null")).is_empty());
    }

    #[test]
    fn unavailable_updates_drop_files_that_have_since_landed() {
        let request = UpdateUnavailableRequest {
            sidecars: strings(&["001.jpg"]),
            previously_unavailable: Some(r#"["thumbnail","subtitles"]"#.to_string()),
            attempted: strings(&["thumbnail", "description"]),
        };
        assert_eq!(
            update_unavailable_metadata_kinds(request),
            strings(&["subtitles", "description"])
        );
    }

    #[test]
    fn missing_kinds_follow_fixed_public_order_and_truthiness() {
        let request = MissingMetadataRequest {
            sidecars: strings(&["001.en.srt"]),
            requested: json!({
                "subtitles": true,
                "thumbnail": true,
                "description": true,
                "infoJson": true
            })
            .as_object()
            .unwrap()
            .clone(),
            unavailable: strings(&["thumbnail"]),
        };
        assert_eq!(
            missing_metadata_kinds(request),
            strings(&["description", "infoJson"])
        );
    }
}
