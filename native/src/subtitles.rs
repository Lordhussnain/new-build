use crate::text::js_trim;
use serde::Deserialize;

pub const EMBEDDABLE_SUBTITLE_EXTENSIONS: [&str; 4] = [".srt", ".vtt", ".ass", ".ssa"];

/// Equivalent to /live[_-]?chat/i without Unicode case folding: the original
/// JavaScript expression is intentionally non-Unicode.
fn contains_live_chat(base: &str) -> bool {
    let bytes = base.as_bytes();
    for start in 0..bytes.len() {
        let Some(after_live) = start.checked_add(4) else {
            continue;
        };
        if !bytes
            .get(start..after_live)
            .is_some_and(|value| value.eq_ignore_ascii_case(b"live"))
        {
            continue;
        }
        for separator in [0usize, 1usize] {
            if separator == 1
                && !bytes
                    .get(after_live)
                    .is_some_and(|byte| *byte == b'_' || *byte == b'-')
            {
                continue;
            }
            let chat_start = after_live + separator;
            let chat_end = chat_start + 3;
            if bytes
                .get(chat_start..chat_end)
                .is_some_and(|value| value.eq_ignore_ascii_case(b"chat"))
            {
                return true;
            }
        }
    }
    false
}

pub fn subtitle_selector(languages: &str) -> String {
    let languages = js_trim(languages);
    let selected = if languages.is_empty() || languages.to_lowercase() == "all" {
        "all.*"
    } else {
        languages
    };
    let base = selected.trim_end_matches(',');
    if contains_live_chat(base) {
        base.to_string()
    } else {
        format!("{base},-live_chat")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleArgsConfig {
    pub subtitle_languages: String,
    pub subtitle_format: String,
}

pub fn subtitle_args(config: SubtitleArgsConfig) -> Vec<String> {
    vec![
        "--write-subs".to_string(),
        "--write-auto-subs".to_string(),
        "--sub-langs".to_string(),
        subtitle_selector(&config.subtitle_languages),
        "--convert-subs".to_string(),
        if config.subtitle_format.is_empty() {
            "srt".to_string()
        } else {
            config.subtitle_format
        },
    ]
}

pub fn is_embeddable_subtitle_file(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    EMBEDDABLE_SUBTITLE_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(*extension))
}

fn plausible_language_tag(tag: &str) -> bool {
    let mut parts = tag.split(|character| character == '-' || character == '_');
    let Some(primary) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&primary.len())
        || !primary.bytes().all(|byte| byte.is_ascii_lowercase())
    {
        return false;
    }
    parts.all(|part| {
        (2..=8).contains(&part.len())
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

pub fn parse_subtitle_language(filename: &str, media_base: &str) -> Option<String> {
    let prefix = format!("{}.", media_base.to_lowercase());
    let lower = filename.to_lowercase();
    let rest = lower.strip_prefix(prefix.as_str())?;
    if !is_embeddable_subtitle_file(rest) {
        return None;
    }
    let tag = rest.rfind('.').map(|index| &rest[..index]).unwrap_or(rest);
    if tag.is_empty() || !plausible_language_tag(tag) {
        return None;
    }
    Some(tag.to_string())
}

/// ISO 639-1 -> ISO 639-2/B, including legacy codes emitted by YouTube.
fn iso639_1_to_2(base: &str) -> Option<&'static str> {
    Some(match base {
        "aa" => "aar", "ab" => "abk", "af" => "afr", "ak" => "aka",
        "am" => "amh", "ar" => "ara", "as" => "asm", "ay" => "aym",
        "az" => "aze", "ba" => "bak", "be" => "bel", "bg" => "bul",
        "bm" => "bam", "bn" => "ben", "bo" => "bod", "br" => "bre",
        "bs" => "bos", "ca" => "cat", "co" => "cos", "cs" => "ces",
        "cy" => "cym", "da" => "dan", "de" => "deu", "dv" => "div",
        "dz" => "dzo", "el" => "ell", "en" => "eng", "eo" => "epo",
        "es" => "spa", "et" => "est", "eu" => "eus", "fa" => "fas",
        "ff" => "ful", "fi" => "fin", "fil" => "fil", "fo" => "fao",
        "fr" => "fra", "fy" => "fry", "ga" => "gle", "gd" => "gla",
        "gl" => "glg", "gn" => "grn", "gu" => "guj", "ha" => "hau",
        "he" => "heb", "hi" => "hin", "hr" => "hrv", "ht" => "hat",
        "hu" => "hun", "hy" => "hye", "id" => "ind", "ig" => "ibo",
        "is" => "isl", "it" => "ita", "iu" => "iku", "ja" => "jpn",
        "jv" => "jav", "ka" => "kat", "kk" => "kaz", "kl" => "kal",
        "km" => "khm", "kn" => "kan", "ko" => "kor", "ks" => "kas",
        "ku" => "kur", "ky" => "kir", "la" => "lat", "lb" => "ltz",
        "lg" => "lug", "ln" => "lin", "lo" => "lao", "lt" => "lit",
        "lu" => "lub", "lv" => "lav", "mg" => "mlg", "mi" => "mri",
        "mk" => "mkd", "ml" => "mal", "mn" => "mon", "mr" => "mar",
        "ms" => "msa", "mt" => "mlt", "my" => "mya", "nb" => "nob",
        "ne" => "nep", "nl" => "nld", "nn" => "nno", "no" => "nor",
        "or" => "ori", "pa" => "pan", "pl" => "pol", "ps" => "pus",
        "pt" => "por", "qu" => "que", "ro" => "ron", "ru" => "rus",
        "rw" => "kin", "sa" => "san", "sd" => "snd", "si" => "sin",
        "sk" => "slk", "sl" => "slv", "sn" => "sna", "so" => "som",
        "sq" => "sqi", "sr" => "srp", "st" => "sot", "su" => "sun",
        "sv" => "swe", "sw" => "swa", "ta" => "tam", "te" => "tel",
        "tg" => "tgk", "th" => "tha", "ti" => "tir", "tk" => "tuk",
        "tl" => "tgl", "tn" => "tsn", "to" => "ton", "tr" => "tur",
        "tt" => "tat", "ug" => "uig", "uk" => "ukr", "ur" => "urd",
        "uz" => "uzb", "vi" => "vie", "wo" => "wol", "xh" => "xho",
        "yi" => "yid", "yo" => "yor", "zh" => "zho", "zu" => "zul",
        "iw" => "heb", "in" => "ind", "ji" => "yid", "jw" => "jav",
        "mo" => "ron",
        _ => return None,
    })
}

pub fn iso639_2(language: Option<&str>) -> String {
    let Some(language) = language.filter(|language| !language.is_empty()) else {
        return "und".to_string();
    };
    let lower = language.to_lowercase();
    let base = lower
        .split(|character| character == '-' || character == '_')
        .next()
        .map(js_trim)
        .unwrap_or("");
    if base.is_empty() {
        return "und".to_string();
    }
    // String#length is UTF-16, not UTF-8. This matters for unusual direct API
    // inputs even though normal language tags are ASCII.
    if base.encode_utf16().count() == 3 {
        return base.to_string();
    }
    iso639_1_to_2(base).unwrap_or("und").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_preserves_explicit_live_chat_and_trailing_comma_contracts() {
        assert_eq!(subtitle_selector("all"), "all.*,-live_chat");
        assert_eq!(subtitle_selector("  "), "all.*,-live_chat");
        assert_eq!(subtitle_selector("en,es,ja"), "en,es,ja,-live_chat");
        assert_eq!(subtitle_selector("en,,"), "en,-live_chat");
        assert_eq!(subtitle_selector("LIVE-CHAT"), "LIVE-CHAT");
        assert_eq!(subtitle_selector("all.*,-live_chat"), "all.*,-live_chat");
        assert!(!contains_live_chat("ſive_chat"));
    }

    #[test]
    fn subtitle_sidecar_names_require_an_embeddable_extension_and_plausible_tag() {
        assert_eq!(
            parse_subtitle_language("001 - Video.zh-Hans.vtt", "001 - Video"),
            Some("zh-hans".to_string())
        );
        assert_eq!(
            parse_subtitle_language("001 - Video.en-orig.srt", "001 - Video"),
            Some("en-orig".to_string())
        );
        assert_eq!(parse_subtitle_language("001 - Video.srt", "001 - Video"), None);
        assert_eq!(parse_subtitle_language("001 - Video.2.srt", "001 - Video"), None);
        assert_eq!(parse_subtitle_language("001 - Video.en.lrc", "001 - Video"), None);
        assert!(is_embeddable_subtitle_file("A.EN.SSA"));
    }

    #[test]
    fn iso_conversion_keeps_three_letter_and_legacy_codes() {
        assert_eq!(iso639_2(Some("en-US")), "eng");
        assert_eq!(iso639_2(Some("zh-Hans")), "zho");
        assert_eq!(iso639_2(Some("iw")), "heb");
        assert_eq!(iso639_2(Some("fil")), "fil");
        assert_eq!(iso639_2(Some("zz")), "und");
        assert_eq!(iso639_2(Some(" en -US")), "eng");
        assert_eq!(iso639_2(Some("😀a")), "😀a");
        assert_eq!(iso639_2(None), "und");
    }
}
