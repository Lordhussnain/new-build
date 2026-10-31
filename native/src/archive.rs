use crate::text::{is_js_whitespace, js_trim};
use serde::Serialize;
use std::collections::HashSet;

/// The last whitespace-delimited field, matching JavaScript's
/// `line.trim().split(/\s+/).at(-1)`. In particular, U+0085 is not JavaScript
/// whitespace and an empty line has one empty field rather than no fields.
fn last_field(line: &str) -> &str {
    let trimmed = js_trim(line);
    if trimmed.is_empty() {
        return "";
    }
    trimmed
        .split(is_js_whitespace)
        .filter(|field| !field.is_empty())
        .last()
        .unwrap_or("")
}

/// Extract unique ids in first-appearance order. TypeScript constructs the
/// returned Set, preserving the same iteration order as the legacy loop.
pub fn parse_archive_ids(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for line in text.split('\n') {
        let id = last_field(line);
        if !id.is_empty() && seen.insert(id) {
            ids.push(id.to_string());
        }
    }
    ids
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ArchiveRemoval {
    pub text: String,
    pub changed: bool,
}

/// Filter complete LF-delimited records without normalizing their contents.
/// `changed` is based on removed line count, not on whether the text differs;
/// this retains the historical empty-video-id/blank-line behavior too.
pub fn remove_archive_id(text: &str, video_id: &str) -> ArchiveRemoval {
    let lines: Vec<&str> = text.split('\n').collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| last_field(line) != video_id)
        .collect();
    ArchiveRemoval {
        changed: kept.len() != lines.len(),
        text: kept.join("\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_last_fields_with_javascript_whitespace_and_stable_deduplication() {
        let text = "youtube first\nextractor\tsecond\r\n  youtube   first  \n\
                    \u{00a0}youtube\u{2003}third\u{feff}\n\n\u{0085}\n";
        assert_eq!(
            parse_archive_ids(text),
            vec!["first", "second", "third", "\u{0085}"]
        );
    }

    #[test]
    fn removal_preserves_records_line_endings_and_trailing_empty_fields() {
        let result = remove_archive_id(
            "youtube keep\r\nyoutube remove\nyoutube keeper\n",
            "remove",
        );
        assert_eq!(result.text, "youtube keep\r\nyoutube keeper\n");
        assert!(result.changed);

        let unchanged = remove_archive_id("youtube prefix-remove\n", "remove");
        assert_eq!(unchanged.text, "youtube prefix-remove\n");
        assert!(!unchanged.changed);
    }

    #[test]
    fn empty_id_retains_the_legacy_blank_line_removal_contract() {
        let result = remove_archive_id("youtube keep\n\n", "");
        assert_eq!(result.text, "youtube keep");
        assert!(result.changed);
        assert_eq!(remove_archive_id("", ""), ArchiveRemoval {
            text: String::new(),
            changed: true,
        });
    }
}
