use crate::subtitles::iso639_2;
use crate::text::is_js_whitespace;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamProbe {
    pub video_streams: u64,
    pub audio_streams: u64,
    pub subtitle_streams: u64,
    pub attachment_streams: u64,
    pub has_attached_picture: bool,
    pub has_cover_attachment: bool,
}

impl Default for MediaStreamProbe {
    fn default() -> Self {
        Self {
            video_streams: 0,
            audio_streams: 0,
            subtitle_streams: 0,
            attachment_streams: 0,
            has_attached_picture: false,
            has_cover_attachment: false,
        }
    }
}

fn consume_ascii_case(text: &str, position: usize, expected: &[u8]) -> Option<usize> {
    let end = position.checked_add(expected.len())?;
    text.as_bytes()
        .get(position..end)
        .filter(|candidate| candidate.eq_ignore_ascii_case(expected))
        .map(|_| end)
}

fn skip_js_whitespace(text: &str, mut position: usize) -> usize {
    while position < text.len() {
        let character = text[position..].chars().next().unwrap();
        if !is_js_whitespace(character) {
            break;
        }
        position += character.len_utf8();
    }
    position
}

/// Parse the prefix accepted by
/// /^\s*Stream #\d+:\d+(?:\([^)]*\))?:\s*(Video|Audio|Subtitle|Attachment|Data):/i.
fn stream_kind(line: &str) -> Option<&'static str> {
    let bytes = line.as_bytes();
    let mut position = skip_js_whitespace(line, 0);
    position = consume_ascii_case(line, position, b"Stream #")?;

    let digits = position;
    while bytes.get(position).is_some_and(|byte| byte.is_ascii_digit()) {
        position += 1;
    }
    if position == digits || bytes.get(position) != Some(&b':') {
        return None;
    }
    position += 1;
    let digits = position;
    while bytes.get(position).is_some_and(|byte| byte.is_ascii_digit()) {
        position += 1;
    }
    if position == digits {
        return None;
    }

    if bytes.get(position) == Some(&b'(') {
        let close = line[position + 1..].find(')')?;
        position = position + 1 + close + 1;
    }
    if bytes.get(position) != Some(&b':') {
        return None;
    }
    position = skip_js_whitespace(line, position + 1);

    for kind in ["Video", "Audio", "Subtitle", "Attachment", "Data"] {
        if let Some(end) = consume_ascii_case(line, position, kind.as_bytes()) {
            if bytes.get(end) == Some(&b':') {
                return Some(kind);
            }
        }
    }
    None
}

fn contains_ascii_case(text: &str, needle: &[u8]) -> bool {
    text.as_bytes()
        .windows(needle.len())
        .any(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Match /attachment:\s*cover\b/i with JavaScript's ASCII \b and ECMAScript
/// whitespace. Searching bytes is safe because every literal is ASCII.
fn has_cover_attachment(line: &str) -> bool {
    let bytes = line.as_bytes();
    for start in 0..bytes.len() {
        let Some(after_attachment) = consume_ascii_case(line, start, b"attachment:") else {
            continue;
        };
        let cover = skip_js_whitespace(line, after_attachment);
        let Some(after_cover) = consume_ascii_case(line, cover, b"cover") else {
            continue;
        };
        match bytes.get(after_cover) {
            Some(byte) if ascii_word(*byte) => {}
            _ => return true,
        }
    }
    false
}

pub fn parse_media_stream_probe(banner: &str) -> MediaStreamProbe {
    let mut probe = MediaStreamProbe::default();
    // Splitting only on LF is equivalent here to /\r?\n/: a retained CR cannot
    // affect the prefix, attached-pic substring, or attachment classification.
    for line in banner.split('\n') {
        let Some(kind) = stream_kind(line) else {
            continue;
        };
        match kind {
            "Video" => {
                if contains_ascii_case(line, b"(attached pic)") {
                    probe.has_attached_picture = true;
                } else {
                    probe.video_streams += 1;
                }
            }
            "Audio" => probe.audio_streams += 1,
            "Subtitle" => probe.subtitle_streams += 1,
            "Attachment" => {
                probe.attachment_streams += 1;
                if has_cover_attachment(line) {
                    probe.has_cover_attachment = true;
                }
            }
            _ => {}
        }
    }
    probe
}

pub fn subtitle_codec_for(container: &str) -> Option<&'static str> {
    match container {
        "mp4" => Some("mov_text"),
        "webm" => Some("webvtt"),
        "mkv" => Some("copy"),
        _ => None,
    }
}

pub fn supports_cover_art(container: &str) -> bool {
    matches!(container, "mp4" | "mkv" | "m4a" | "mp3")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleEmbedInput {
    pub path: String,
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxInput {
    pub source_path: String,
    pub output_path: String,
    pub container: String,
    pub probe: MediaStreamProbe,
    pub subtitles: Vec<SubtitleEmbedInput>,
    pub cover_path: Option<String>,
}

pub fn build_remux_args(input: RemuxInput) -> Vec<String> {
    let subtitle_codec = subtitle_codec_for(&input.container);
    let empty_subtitles: Vec<SubtitleEmbedInput> = Vec::new();
    let subtitle_inputs = if subtitle_codec.is_some() {
        &input.subtitles
    } else {
        &empty_subtitles
    };

    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input.source_path.clone(),
    ];
    for subtitle in subtitle_inputs {
        args.push("-i".to_string());
        args.push(subtitle.path.clone());
    }
    let cover_input = 1 + subtitle_inputs.len();
    let add_cover = input
        .cover_path
        .as_ref()
        .is_some_and(|path| !path.is_empty())
        && supports_cover_art(&input.container);
    if add_cover {
        args.push("-i".to_string());
        args.push(input.cover_path.clone().unwrap());
    }

    let keep_source_subtitles = subtitle_inputs.is_empty() && input.probe.subtitle_streams > 0;
    let keep_source_cover = !add_cover
        && (supports_cover_art(&input.container) || !input.probe.has_attached_picture);

    args.push("-map".to_string());
    args.push((if keep_source_cover { "0:v?" } else { "0:V?" }).to_string());
    args.push("-map".to_string());
    args.push("0:a?".to_string());
    if keep_source_subtitles {
        args.push("-map".to_string());
        args.push("0:s?".to_string());
    }
    if input.container == "mkv" && !add_cover && input.probe.attachment_streams > 0 {
        args.push("-map".to_string());
        args.push("0:t?".to_string());
    }
    if add_cover {
        args.push("-map".to_string());
        args.push(format!("{cover_input}:v"));
        args.push(format!("-disposition:v:{}", input.probe.video_streams));
        args.push("attached_pic".to_string());
    }
    for index in 0..subtitle_inputs.len() {
        args.push("-map".to_string());
        args.push(format!("{}:s:0", index + 1));
    }
    for (index, subtitle) in subtitle_inputs.iter().enumerate() {
        let language = iso639_2(subtitle.language.as_deref());
        if language != "und" {
            args.push(format!("-metadata:s:s:{index}"));
            args.push(format!("language={language}"));
        }
    }

    args.push("-c:v".to_string());
    args.push("copy".to_string());
    args.push("-c:a".to_string());
    args.push((if input.container == "mp4" { "aac" } else { "copy" }).to_string());
    if let Some(codec) = subtitle_codec {
        if keep_source_subtitles || !subtitle_inputs.is_empty() {
            args.push("-c:s".to_string());
            args.push(codec.to_string());
        }
    }
    args.extend([
        "-map_metadata".to_string(),
        "0".to_string(),
        "-map_chapters".to_string(),
        "0".to_string(),
    ]);
    if input.container == "mp4" {
        args.push("-movflags".to_string());
        args.push("+faststart".to_string());
    }
    args.push(input.output_path);
    args
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp3Input {
    pub source_path: String,
    pub output_path: String,
    pub probe: MediaStreamProbe,
    pub cover_path: Option<String>,
}

pub fn build_mp3_args(input: Mp3Input) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input.source_path,
        "-map".to_string(),
        "0:a:0".to_string(),
    ];
    let add_cover = input
        .cover_path
        .as_ref()
        .is_some_and(|path| !path.is_empty());
    if add_cover {
        args.push("-i".to_string());
        args.push(input.cover_path.unwrap());
        args.push("-map".to_string());
        args.push("1:v".to_string());
    } else if input.probe.has_attached_picture {
        args.push("-map".to_string());
        args.push("0:v:0?".to_string());
    }
    if add_cover || input.probe.has_attached_picture {
        args.extend([
            "-c:v".to_string(),
            "copy".to_string(),
            "-disposition:v:0".to_string(),
            "attached_pic".to_string(),
        ]);
    }
    args.extend([
        "-c:a".to_string(),
        "libmp3lame".to_string(),
        "-q:a".to_string(),
        "2".to_string(),
        "-map_metadata".to_string(),
        "0".to_string(),
        "-id3v2_version".to_string(),
        "3".to_string(),
        input.output_path,
    ]);
    args
}

pub fn cover_needs_jpeg(cover_path: &str) -> bool {
    let bytes = cover_path.as_bytes();
    ![".jpg", ".jpeg"].iter().any(|extension| {
        bytes
            .get(bytes.len().saturating_sub(extension.len())..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(extension.as_bytes()))
    })
}

pub fn cover_to_jpeg_args(source_path: &str, output_path: &str) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "-q:v".to_string(),
        "2".to_string(),
        output_path.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(overrides: MediaStreamProbe) -> MediaStreamProbe {
        overrides
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value)
    }

    #[test]
    fn parses_real_streams_attached_pictures_and_cover_boundaries() {
        let banner = concat!(
            "Input #0, matroska,webm, from 'video.mkv':\n",
            "  Stream #0:0: Video: vp9, yuv420p, 1920x1080\n",
            "  Stream #0:1: Audio: opus, 48000 Hz\n",
            "  Stream #0:2(eng): Subtitle: subrip (srt)\n",
            "  Stream #0:3: Video: mjpeg, 320x180 (ATTACHED PIC)\n",
            "  Stream #0:4: Attachment: cover.jpg\n",
            "  Stream #0:5: Attachment: cover_next.jpg\n",
            "  Stream #0:6: Data: bin_data\n"
        );
        assert_eq!(parse_media_stream_probe(banner), MediaStreamProbe {
            video_streams: 1,
            audio_streams: 1,
            subtitle_streams: 1,
            attachment_streams: 2,
            has_attached_picture: true,
            has_cover_attachment: true,
        });
        assert_eq!(parse_media_stream_probe("unreadable"), MediaStreamProbe::default());
    }

    #[test]
    fn stream_prefix_uses_ascii_digits_and_non_unicode_case_matching() {
        assert!(stream_kind("  stream #0:12(en): video: h264").is_some());
        assert!(stream_kind("\u{00a0}Stream #0:1(): Audio: aac").is_some());
        assert!(stream_kind("Stream #٠:0: Audio: aac").is_none());
        assert!(stream_kind("ſtream #0:0: Audio: aac").is_none());
        assert!(stream_kind("Stream #0:0 (eng): Audio: aac").is_none());
    }

    #[test]
    fn remux_plan_replaces_subtitles_and_cover_without_reencoding_video() {
        let args = build_remux_args(RemuxInput {
            source_path: "in.mkv".to_string(),
            output_path: "out.mp4".to_string(),
            container: "mp4".to_string(),
            probe: probe(MediaStreamProbe {
                video_streams: 1,
                audio_streams: 2,
                subtitle_streams: 2,
                attachment_streams: 0,
                has_attached_picture: false,
                has_cover_attachment: false,
            }),
            subtitles: vec![
                SubtitleEmbedInput { path: "001.en.srt".to_string(), language: Some("en".to_string()) },
                SubtitleEmbedInput { path: "001.es.srt".to_string(), language: Some("es".to_string()) },
            ],
            cover_path: Some("001.jpg".to_string()),
        });
        assert_eq!(args, vec![
            "-y", "-i", "in.mkv", "-i", "001.en.srt", "-i", "001.es.srt", "-i", "001.jpg",
            "-map", "0:V?", "-map", "0:a?", "-map", "3:v", "-disposition:v:1", "attached_pic",
            "-map", "1:s:0", "-map", "2:s:0", "-metadata:s:s:0", "language=eng",
            "-metadata:s:s:1", "language=spa", "-c:v", "copy", "-c:a", "aac", "-c:s", "mov_text",
            "-map_metadata", "0", "-map_chapters", "0", "-movflags", "+faststart", "out.mp4"
        ].into_iter().map(String::from).collect::<Vec<_>>());
    }

    #[test]
    fn unsupported_containers_ignore_sidecars_and_webm_drops_attached_art() {
        let args = build_remux_args(RemuxInput {
            source_path: "in.mkv".to_string(),
            output_path: "out.webm".to_string(),
            container: "webm".to_string(),
            probe: MediaStreamProbe {
                video_streams: 1,
                has_attached_picture: true,
                ..MediaStreamProbe::default()
            },
            subtitles: vec![SubtitleEmbedInput {
                path: "001.en.vtt".to_string(),
                language: Some("en".to_string()),
            }],
            cover_path: Some("001.jpg".to_string()),
        });
        assert!(has_pair(&args, "-map", "0:V?"));
        assert!(has_pair(&args, "-map", "1:s:0"));
        assert!(has_pair(&args, "-c:s", "webvtt"));
        assert!(!args.iter().any(|arg| arg == "001.jpg"));
    }

    #[test]
    fn mp3_and_cover_plans_keep_attached_art_and_exact_codec_flags() {
        let args = build_mp3_args(Mp3Input {
            source_path: "in.m4a".to_string(),
            output_path: "out.mp3".to_string(),
            probe: MediaStreamProbe {
                has_attached_picture: true,
                ..MediaStreamProbe::default()
            },
            cover_path: None,
        });
        assert!(has_pair(&args, "-map", "0:v:0?"));
        assert!(!args.iter().any(|arg| arg == "-vn"));
        assert!(!cover_needs_jpeg("001.JPEG"));
        assert!(cover_needs_jpeg("001.webp"));
        assert_eq!(cover_to_jpeg_args("in.webp", "out.jpg"), vec![
            "-y", "-i", "in.webp", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "out.jpg"
        ].into_iter().map(String::from).collect::<Vec<_>>());
    }
}
