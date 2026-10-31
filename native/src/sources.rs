use crate::text::js_trim;
use serde::Serialize;
use url::Url;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SourceUrl {
    pub url: String,
    pub key: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BatchOutcome {
    Source { source: SourceUrl },
    Error { error: String },
}

fn word_and_hyphen(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn query_value(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn channel_base(path: &str) -> bool {
    if let Some(handle) = path.strip_prefix("/@") {
        return !handle.is_empty() && !handle.contains('/');
    }
    ["/channel/", "/c/", "/user/"].iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|name| !name.is_empty() && !name.contains('/'))
    })
}

fn channel_tab(path: &str) -> Option<Option<&'static str>> {
    const TABS: [&str; 6] = [
        "featured",
        "videos",
        "shorts",
        "streams",
        "playlists",
        "live",
    ];
    if let Some((base, tab)) = path.rsplit_once('/') {
        if TABS.contains(&tab) && channel_base(base) {
            // This static mapping avoids returning a borrow into the temporary
            // canonical URL while retaining the exact original path.
            let tab = match tab {
                "featured" => "featured",
                "videos" => "videos",
                "shorts" => "shorts",
                "streams" => "streams",
                "playlists" => "playlists",
                "live" => "live",
                _ => unreachable!(),
            };
            return Some(Some(tab));
        }
    }
    channel_base(path).then_some(None)
}

pub fn parse_source_url(input: &str, single_video: bool) -> Result<SourceUrl, String> {
    let text = js_trim(input);
    if text.is_empty() {
        return Err("YouTube URL required".to_string());
    }
    if text.encode_utf16().count() > 8192
        || text.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}')
    {
        return Err("Invalid YouTube URL".to_string());
    }
    let parsed = Url::parse(text)
        .map_err(|_| "Enter a full YouTube URL starting with https://".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let short = host == "youtu.be" || host == "www.youtu.be";
    let youtube = host == "youtube.com" || host.ends_with(".youtube.com");
    if (!short && !youtube)
        || !["https", "http"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed
            .password()
            .is_some_and(|password| !password.is_empty())
        || parsed.port().is_some()
    {
        return Err("Enter a YouTube playlist, channel or video URL".to_string());
    }

    let path = parsed.path().trim_end_matches('/');
    let video = if short {
        Some(path.strip_prefix('/').unwrap_or(path).to_string())
    } else if path == "/watch" {
        query_value(&parsed, "v")
    } else {
        ["/shorts/", "/live/", "/embed/"].iter().find_map(|prefix| {
            path.strip_prefix(prefix)
                .and_then(|id| (word_and_hyphen(id) && !id.contains('/')).then(|| id.to_string()))
        })
    };
    let has_video = video
        .as_ref()
        .is_some_and(|video| video.len() >= 6 && word_and_hyphen(video));

    if single_video && has_video {
        return Ok(SourceUrl {
            key: "playlists",
            url: format!("https://www.youtube.com/watch?v={}", video.unwrap()),
        });
    }

    if let Some(list) = query_value(&parsed, "list") {
        if !word_and_hyphen(&list) {
            return Err("Invalid YouTube playlist id".to_string());
        }
        return Ok(SourceUrl {
            key: "playlists",
            url: format!("https://www.youtube.com/playlist?list={list}"),
        });
    }
    if has_video {
        return Ok(SourceUrl {
            key: "playlists",
            url: format!("https://www.youtube.com/watch?v={}", video.unwrap()),
        });
    }
    if youtube {
        if let Some(tab) = channel_tab(path) {
            return Ok(SourceUrl {
                key: if tab == Some("playlists") {
                    "channelPlaylists"
                } else {
                    "channels"
                },
                url: format!("https://www.youtube.com{path}"),
            });
        }
    }
    Err("Enter a YouTube playlist, channel or video URL".to_string())
}

pub fn parse_source_urls(inputs: Vec<String>, single_video: bool) -> Vec<BatchOutcome> {
    inputs
        .iter()
        .map(|input| match parse_source_url(input, single_video) {
            Ok(source) => BatchOutcome::Source { source },
            Err(error) => BatchOutcome::Error { error },
        })
        .collect()
}

pub fn source_identity(input: &str) -> String {
    let trimmed = js_trim(input);
    parse_source_url(trimmed, false)
        .map(|source| source.url)
        .unwrap_or_else(|_| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_playlists_videos_and_channels() {
        assert_eq!(
            parse_source_url(
                " https://m.youtube.com/watch?v=AbCdEf12345&list=PL_saved&index=2 ",
                false
            )
            .unwrap(),
            SourceUrl {
                key: "playlists",
                url: "https://www.youtube.com/playlist?list=PL_saved".to_string()
            }
        );
        assert_eq!(
            parse_source_url("https://youtu.be/AbCdEf12345?list=PL_saved", true)
                .unwrap()
                .url,
            "https://www.youtube.com/watch?v=AbCdEf12345"
        );
        assert_eq!(
            parse_source_url("http://m.youtube.com/@Teacher/playlists/?si=share", false).unwrap(),
            SourceUrl {
                key: "channelPlaylists",
                url: "https://www.youtube.com/@Teacher/playlists".to_string()
            }
        );
        // "playlists" can be the name of a /c/ or /user/ channel.
        assert_eq!(
            parse_source_url("https://youtube.com/c/playlists", false)
                .unwrap()
                .key,
            "channels"
        );
    }

    #[test]
    fn rejects_unsupported_hosts_credentials_ports_and_bad_ids() {
        for input in [
            "https://youtube.com.evil.example/@Teacher",
            "https://user:pass@youtube.com/@Teacher",
            "https://youtube.com:8080/@Teacher",
            "https://www.youtube.com/playlist?list=",
            "not a URL",
        ] {
            assert!(parse_source_url(input, false).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn identity_preserves_legacy_entries() {
        assert_eq!(source_identity("  legacy-entry  "), "legacy-entry");
    }
}
