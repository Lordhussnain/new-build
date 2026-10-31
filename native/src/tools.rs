use crate::text::{js_string, js_trim};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCandidateRequest {
    pub cfg_path: String,
    pub posix_names: Vec<String>,
    pub win_names: Vec<String>,
    pub cwd: String,
    pub exe_dir: String,
    pub platform: String,
    pub home: String,
    pub env: Option<Map<String, Value>>,
    pub env_is_injected: bool,
}

fn env_string(env: &Option<Map<String, Value>>, key: &str) -> Option<String> {
    env.as_ref()?.get(key).and_then(|value| {
        if value.is_null() {
            None
        } else {
            Some(js_string(value))
        }
    })
}

fn path_lookup_available(env: &Option<Map<String, Value>>, injected: bool) -> bool {
    if !injected {
        return true;
    }
    let Some(env) = env else { return false };
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .and_then(|(_, value)| {
            if value.is_null() {
                None
            } else {
                Some(js_string(value))
            }
        })
        .is_some_and(|value| !js_trim(&value).is_empty())
}

fn join(base: &str, parts: &[&str]) -> String {
    let mut path = PathBuf::from(base);
    for part in parts {
        path.push(part);
    }
    // node:path.join normalizes redundant separators and '.' components.
    let normalized: PathBuf = path.components().collect();
    normalized.to_string_lossy().into_owned()
}

pub fn tool_candidates(request: ToolCandidateRequest) -> Vec<String> {
    let mut candidates = Vec::new();
    let configured = js_trim(&request.cfg_path);
    if !configured.is_empty() {
        candidates.push(configured.to_string());
    }
    let bare_name_works = path_lookup_available(&request.env, request.env_is_injected);
    for name in &request.posix_names {
        if bare_name_works {
            candidates.push(name.clone());
        }
        candidates.push(join(&request.cwd, &[name]));
        candidates.push(join(&request.exe_dir, &[name]));
    }
    if request.platform == "win32" {
        let program_data = env_string(&request.env, "ProgramData")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "C:\\ProgramData".to_string());
        let local_app_data = env_string(&request.env, "LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| join(&request.home, &["AppData", "Local"]));
        for name in &request.win_names {
            candidates.push(join(&request.cwd, &[name]));
            candidates.push(join(&request.exe_dir, &[name]));
            candidates.push(join(&program_data, &["chocolatey", "bin", name]));
            candidates.push(join(&request.home, &["scoop", "shims", name]));
            candidates.push(join(
                &local_app_data,
                &["Microsoft", "WinGet", "Links", name],
            ));
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

pub fn bun_interpreter_path(exec_path: &str) -> Option<String> {
    let basename = Path::new(exec_path).file_name()?.to_str()?;
    let stem = if basename.len() >= 4 && basename[basename.len() - 4..].eq_ignore_ascii_case(".exe")
    {
        &basename[..basename.len() - 4]
    } else {
        basename
    };
    (stem.to_lowercase() == "bun").then(|| exec_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_injected_environment_disables_bare_path_candidates() {
        let candidates = tool_candidates(ToolCandidateRequest {
            cfg_path: String::new(),
            posix_names: vec!["aria2c".to_string()],
            win_names: vec!["aria2c.exe".to_string()],
            cwd: "/empty".to_string(),
            exe_dir: "/empty".to_string(),
            platform: "linux".to_string(),
            home: "/home/test".to_string(),
            env: Some(Map::new()),
            env_is_injected: true,
        });
        assert_eq!(candidates, vec!["/empty/aria2c"]);
    }

    #[test]
    fn explicit_path_wins_and_candidates_are_deduplicated() {
        let candidates = tool_candidates(ToolCandidateRequest {
            cfg_path: " /opt/custom ".to_string(),
            posix_names: vec!["ffmpeg".to_string()],
            win_names: vec![],
            cwd: "/app".to_string(),
            exe_dir: "/app".to_string(),
            platform: "linux".to_string(),
            home: "/home/test".to_string(),
            env: Some(json!({"PATH":"/bin"}).as_object().unwrap().clone()),
            env_is_injected: true,
        });
        assert_eq!(candidates, vec!["/opt/custom", "ffmpeg", "/app/ffmpeg"]);
    }

    #[test]
    fn recognizes_only_the_bun_interpreter() {
        assert_eq!(
            bun_interpreter_path("/usr/local/bin/bun"),
            Some("/usr/local/bin/bun".to_string())
        );
        assert_eq!(
            bun_interpreter_path("C:/Users/me/bun.exe"),
            Some("C:/Users/me/bun.exe".to_string())
        );
        assert_eq!(bun_interpreter_path("/opt/youtube-archive"), None);
    }
}
