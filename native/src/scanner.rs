use crate::text::{is_js_whitespace, js_trim};
use serde::{Deserialize, Serialize};
use url::Url;

/// JavaScript's non-Unicode /\w/ is ASCII-only. String#length is UTF-16, so the
/// initial eleven-code-unit check must not use UTF-8 byte length.
pub fn listing_entry_kind(id: &str) -> &'static str {
    if id.encode_utf16().count() <= 11 {
        return "video";
    }
    if id.starts_with("UC") {
        return "channel";
    }
    if ["PL", "UU", "OL", "FL", "LL", "RD", "VL", "EL"]
        .iter()
        .any(|prefix| id.starts_with(prefix))
    {
        return "playlist";
    }
    "video"
}

/// Match `\s+-\s+suffix$` using ECMAScript whitespace and non-Unicode ASCII
/// case folding. Rust's Unicode-aware `(?i)` would incorrectly accept characters
/// such as long-s that JavaScript's non-Unicode /i rejects.
fn suffix_start(text: &str, suffix: &str) -> Option<usize> {
    let suffix_start = text.len().checked_sub(suffix.len())?;
    if !text.get(suffix_start..)?.eq_ignore_ascii_case(suffix) {
        return None;
    }
    let before_suffix = &text[..suffix_start];
    let through_hyphen = before_suffix.trim_end_matches(is_js_whitespace);
    if through_hyphen.len() == before_suffix.len() {
        return None; // The suffix must be preceded by whitespace after '-'.
    }
    let before_hyphen = through_hyphen.strip_suffix('-')?;
    let match_start = before_hyphen.trim_end_matches(is_js_whitespace).len();
    if match_start == before_hyphen.len() {
        return None; // The '-' must also be preceded by whitespace.
    }
    Some(match_start)
}

pub fn shorts_tab_item(playlist: &str) -> bool {
    suffix_start(playlist, "Shorts").is_some()
}

pub fn channel_folder_name(playlist: &str, channel: Option<&str>) -> String {
    if let Some(channel) = channel.map(js_trim).filter(|channel| !channel.is_empty()) {
        return channel.to_string();
    }
    const TABS: [&str; 10] = [
        "Videos",
        "Shorts",
        "Live",
        "Streams",
        "Playlists",
        "Home",
        "Featured",
        "Posts",
        "Community",
        "Releases",
    ];
    for tab in TABS {
        if let Some(start) = suffix_start(playlist, tab) {
            return js_trim(&playlist[..start]).to_string();
        }
    }
    js_trim(playlist).to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListingLineItem {
    pub title: String,
    pub id: String,
    pub playlist: String,
    /// Kept as text so TypeScript can apply the actual ECMAScript parseFloat.
    /// JSON cannot faithfully carry NaN, infinities, or signed zero.
    pub duration_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_playlist: Option<bool>,
}

pub fn parse_listing_line(line: &str) -> Option<ListingLineItem> {
    if js_trim(line).is_empty() {
        return None;
    }
    // Only the first five fields are observed; yt-dlp delimiters in any later
    // field are ignored just as Array destructuring ignored them historically.
    let mut fields = line.split("|||");
    let playlist_field = fields.next().unwrap_or("");
    let id_field = fields.next();
    let title_field = fields.next();
    let duration_field = fields.next();
    let channel_field = fields.next();

    let id = js_trim(id_field.unwrap_or(""));
    if id.is_empty() {
        return None;
    }
    let kind = listing_entry_kind(id);
    if kind == "channel" {
        return None;
    }
    let playlist = js_trim(playlist_field);
    let title_field = title_field.unwrap_or("");
    let title = if title_field.is_empty() {
        "video"
    } else {
        title_field
    };
    let channel = js_trim(channel_field.unwrap_or(""));
    Some(ListingLineItem {
        title: js_trim(title).to_string(),
        id: id.to_string(),
        playlist: if playlist == "NA" {
            String::new()
        } else {
            playlist.to_string()
        },
        duration_text: duration_field.unwrap_or("NaN").to_string(),
        channel: if channel.is_empty() || channel == "NA" {
            None
        } else {
            Some(channel.to_string())
        },
        is_playlist: (kind == "playlist").then_some(true),
    })
}

pub fn parse_listing_lines(lines: Vec<String>) -> Vec<ListingLineItem> {
    lines.iter().filter_map(|line| parse_listing_line(line)).collect()
}

fn query_value(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn canonical_video_id(value: &str) -> bool {
    value.len() >= 6
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn normalize_video_url(input: &str) -> String {
    let trimmed = js_trim(input);
    if trimmed.is_empty() {
        return String::new();
    }
    let parsed = match Url::parse(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => return trimmed.to_string(),
    };
    let short_match = (parsed.host_str() == Some("youtu.be")).then(|| {
        let path = parsed.path();
        path.strip_prefix('/')
            .unwrap_or(path)
            .split('/')
            .next()
            .unwrap_or("")
            .to_string()
    });
    // A nonempty youtu.be path takes precedence even when it is not a valid id;
    // only an empty path falls through to ?v=, matching JavaScript's `||`.
    let id = match short_match {
        Some(value) if !value.is_empty() => Some(value),
        _ => query_value(&parsed, "v"),
    };
    if let Some(id) = id {
        if canonical_video_id(&id) {
            return format!("https://www.youtube.com/watch?v={id}");
        }
    }
    trimmed.to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestItemInput {
    pub id: String,
    pub playlist: String,
    pub duration: Option<f64>,
    #[serde(default)]
    pub is_playlist: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRequest {
    pub items: Vec<IngestItemInput>,
    pub video_quality: String,
    pub target_format: String,
    pub download_subtitles: bool,
    pub embed_subtitles: bool,
    pub write_thumbnail: bool,
    pub embed_thumbnail: bool,
    pub write_description: bool,
    pub write_info_json: bool,
    pub skip_shorts: bool,
    pub download_shorts: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IngestItemPlan {
    pub is_playlist: bool,
    pub short: bool,
    pub skip_short: bool,
    pub url: String,
    pub duration: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedIngest {
    pub target_format: String,
    pub want_subtitles: u8,
    pub want_thumbnail: u8,
    pub want_description: u8,
    pub conversion_status: &'static str,
    pub metadata_status: &'static str,
    pub items: Vec<IngestItemPlan>,
}

pub fn prepare_ingest(request: IngestRequest) -> PreparedIngest {
    let target_format = if request.video_quality == "audio" {
        "mp3".to_string()
    } else if request.target_format.is_empty() {
        "mp4".to_string()
    } else {
        request.target_format.clone()
    };
    let want_subtitles = u8::from(request.download_subtitles || request.embed_subtitles);
    let want_thumbnail = u8::from(request.write_thumbnail || request.embed_thumbnail);
    let want_description = u8::from(request.write_description);
    let embed_wanted = request.embed_subtitles || request.embed_thumbnail;
    let conversion_status = if request.video_quality == "audio"
        || target_format != "mp4"
        || embed_wanted
    {
        "pending"
    } else {
        "not_needed"
    };
    let metadata_status = if want_subtitles != 0
        || want_thumbnail != 0
        || want_description != 0
        || request.write_info_json
    {
        "pending"
    } else {
        "not_needed"
    };
    let reject_shorts = request.skip_shorts && !request.download_shorts;
    let items = request
        .items
        .iter()
        .map(|item| {
            let short = match item.duration {
                Some(duration) if duration.is_finite() && duration > 0.0 => duration < 60.0,
                _ => shorts_tab_item(&item.playlist),
            };
            IngestItemPlan {
                is_playlist: item.is_playlist,
                short,
                skip_short: reject_shorts && short,
                url: normalize_video_url(&format!("https://www.youtube.com/watch?v={}", item.id)),
                duration: item.duration.filter(|duration| duration.is_finite() && *duration > 0.0),
            }
        })
        .collect();
    PreparedIngest {
        target_format,
        want_subtitles,
        want_thumbnail,
        want_description,
        conversion_status,
        metadata_status,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_kinds_use_utf16_length_and_case_sensitive_prefixes() {
        assert_eq!(listing_entry_kind("UCshort"), "video");
        assert_eq!(listing_entry_kind("UCabcdefghij"), "channel");
        assert_eq!(listing_entry_kind("PLabcdefghij"), "playlist");
        assert_eq!(listing_entry_kind("plabcdefghij"), "video");
        assert_eq!(listing_entry_kind("😀😀😀😀😀"), "video");
        assert_eq!(listing_entry_kind("😀😀😀😀😀😀"), "video");
    }

    #[test]
    fn parses_listing_fields_without_losing_javascript_duration_semantics() {
        assert_eq!(parse_listing_line(" \u{feff}\n"), None);
        assert_eq!(parse_listing_line("P|||UCabcdefghij|||Channel|||NA"), None);
        assert_eq!(
            parse_listing_line(" NA |||PLabcdefghij||| Season |||NA||| NA "),
            Some(ListingLineItem {
                title: "Season".to_string(),
                id: "PLabcdefghij".to_string(),
                playlist: String::new(),
                duration_text: "NA".to_string(),
                channel: None,
                is_playlist: Some(true),
            })
        );
        let item = parse_listing_line("P|||vid00000001|||   ||| 12.5junk ||| Channel ").unwrap();
        assert_eq!(item.title, ""); // The fallback applies before trim, not after it.
        assert_eq!(item.duration_text, " 12.5junk ");
        assert_eq!(item.channel.as_deref(), Some("Channel"));
        assert_eq!(parse_listing_line("P|||vid00000001").unwrap().title, "video");
        assert_eq!(parse_listing_line("P|||vid00000001").unwrap().duration_text, "NaN");
    }

    #[test]
    fn suffixes_match_ecmascript_not_unicode_case_folding() {
        assert!(shorts_tab_item("Channel \u{00a0}-\tSHORTS"));
        assert!(!shorts_tab_item("Channel - Shorts\n"));
        assert!(!shorts_tab_item("Channel - ſhorts"));
        assert!(!shorts_tab_item("Channel \u{0085}- Shorts"));
        assert_eq!(channel_folder_name(" Channel - Videos ", None), "Channel");
        assert_eq!(channel_folder_name("Ignored - Live", Some(" Uploads ")), "Uploads");
        assert_eq!(channel_folder_name("Ignored - Live", Some("  ")), "Ignored");
        assert_eq!(channel_folder_name("Plain Playlist", None), "Plain Playlist");
    }

    #[test]
    fn canonicalizes_only_urls_with_a_valid_video_id() {
        assert_eq!(
            normalize_video_url(" HTTPS://YOUTU.BE/AbCdEf12345?t=10 "),
            "https://www.youtube.com/watch?v=AbCdEf12345"
        );
        assert_eq!(
            normalize_video_url("https://example.test/watch?v=%41%42%43%44%45%46&list=P"),
            "https://www.youtube.com/watch?v=ABCDEF"
        );
        assert_eq!(
            normalize_video_url("https://youtu.be/bad!?v=AbCdEf12345"),
            "https://youtu.be/bad!?v=AbCdEf12345"
        );
        assert_eq!(normalize_video_url("not a url"), "not a url");
    }

    #[test]
    fn prepares_status_shorts_duration_and_url_without_side_effects() {
        let request: IngestRequest = serde_json::from_value(serde_json::json!({
            "items": [
                {"id":"short00001","playlist":"Channel - Shorts","duration":null},
                {"id":"long000001","playlist":"Channel - Videos","duration":60.0},
                {"id":"PLabcdefghij","playlist":"Playlists","duration":30.0,"isPlaylist":true}
            ],
            "videoQuality":"1080p",
            "targetFormat":"mp4",
            "downloadSubtitles":false,
            "embedSubtitles":false,
            "writeThumbnail":false,
            "embedThumbnail":false,
            "writeDescription":false,
            "writeInfoJson":false,
            "skipShorts":true,
            "downloadShorts":false
        })).unwrap();
        let prepared = prepare_ingest(request);
        assert_eq!(prepared.conversion_status, "not_needed");
        assert_eq!(prepared.metadata_status, "not_needed");
        assert!(prepared.items[0].skip_short);
        assert_eq!(prepared.items[0].duration, None);
        assert!(!prepared.items[1].short);
        assert_eq!(prepared.items[1].duration, Some(60.0));
        assert!(prepared.items[2].is_playlist);
        assert_eq!(prepared.items[2].url, "https://www.youtube.com/watch?v=PLabcdefghij");
    }
}
