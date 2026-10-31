use crate::text::{js_string, js_trim};
use serde_json::{Map, Value};

pub fn parse_offline_switch(raw: &str) -> Option<bool> {
    match js_trim(raw).to_lowercase().as_str() {
        "" | "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_value(env: &Option<Map<String, Value>>, key: &str) -> Option<String> {
    env.as_ref()?.get(key).and_then(|value| {
        if value.is_null() {
            None
        } else {
            Some(js_string(value))
        }
    })
}

pub fn offline_override(argv: Vec<String>, env: Option<Map<String, Value>>) -> Option<bool> {
    let mut from_argv = None;
    for raw in argv {
        let arg = js_trim(&raw).to_lowercase();
        if arg == "--offline" {
            from_argv = Some(true);
        } else if let Some(value) = arg.strip_prefix("--offline=") {
            if let Some(parsed) = parse_offline_switch(value) {
                from_argv = Some(parsed);
            }
        }
    }
    if from_argv.is_some() {
        return from_argv;
    }
    env_value(&env, "YTA_OFFLINE").and_then(|value| parse_offline_switch(&value))
}

pub fn lan_override(argv: Vec<String>, env: Option<Map<String, Value>>) -> Option<bool> {
    let mut from_argv = None;
    for raw in argv {
        let arg = js_trim(&raw).to_lowercase();
        if arg == "--lan" {
            from_argv = Some(true);
        } else if arg == "--no-lan" {
            from_argv = Some(false);
        } else if let Some(value) = arg.strip_prefix("--lan=") {
            if let Some(parsed) = parse_offline_switch(value) {
                from_argv = Some(parsed);
            }
        }
    }
    if from_argv.is_some() {
        return from_argv;
    }
    env_value(&env, "YTA_LAN").and_then(|value| parse_offline_switch(&value))
}

fn invalid_port(raw: &str) -> String {
    format!(
        "Invalid value for --port: {}. Port must be an integer from 1 to 65535.",
        serde_json::to_string(raw).unwrap_or_else(|_| "\"\"".to_string())
    )
}

fn parse_port(raw: &str) -> Result<u16, String> {
    let value = js_trim(raw);
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_port(raw));
    }
    let port = value.parse::<u32>().map_err(|_| invalid_port(raw))?;
    if !(1..=65_535).contains(&port) {
        return Err(invalid_port(raw));
    }
    Ok(port as u16)
}

pub fn web_port_override(argv: Vec<String>) -> Result<Option<u16>, String> {
    let mut override_port = None;
    let mut index = 0;
    while index < argv.len() {
        let arg = js_trim(&argv[index]);
        if arg == "--port" {
            let Some(next) = argv.get(index + 1) else {
                return Err(
                    "Missing value for --port (expected an integer from 1 to 65535).".to_string(),
                );
            };
            if js_trim(next).starts_with("--") {
                return Err(
                    "Missing value for --port (expected an integer from 1 to 65535).".to_string(),
                );
            }
            override_port = Some(parse_port(next)?);
            index += 1;
        } else if let Some(value) = arg.strip_prefix("--port=") {
            override_port = Some(parse_port(value)?);
        }
        index += 1;
    }
    Ok(override_port)
}

fn parse_web_token(raw: &str) -> Result<String, String> {
    let value = js_trim(raw);
    if value.is_empty() {
        Err("Invalid value for --webtoken: the token must not be empty.".to_string())
    } else {
        Ok(value.to_string())
    }
}

pub fn web_token_override(argv: Vec<String>) -> Result<Option<String>, String> {
    let mut override_token = None;
    let mut index = 0;
    while index < argv.len() {
        let arg = js_trim(&argv[index]);
        let lower = arg.to_lowercase();
        if lower == "--webtoken" {
            let Some(next) = argv.get(index + 1) else {
                return Err(
                    "Missing value for --webtoken (example: --webtoken 789654).".to_string()
                );
            };
            if js_trim(next).starts_with("--") {
                return Err(
                    "Missing value for --webtoken (example: --webtoken 789654).".to_string()
                );
            }
            override_token = Some(parse_web_token(next)?);
            index += 1;
        } else if lower.starts_with("--webtoken=") {
            override_token = Some(parse_web_token(&arg["--webtoken=".len()..])?);
        }
        index += 1;
    }
    Ok(override_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn command_line_wins_and_last_switch_wins() {
        let env = json!({"YTA_OFFLINE":"1", "YTA_LAN":"1"})
            .as_object()
            .cloned();
        assert_eq!(
            offline_override(strings(&["--offline=false"]), env),
            Some(false)
        );
        assert_eq!(
            lan_override(strings(&["--lan", "--no-lan"]), None),
            Some(false)
        );
        assert_eq!(parse_offline_switch("maybe"), None);
        assert_eq!(parse_offline_switch(""), Some(true));
    }

    #[test]
    fn validates_ports_and_tokens() {
        assert_eq!(
            web_port_override(strings(&["--port", "3010", "--port=3020"])).unwrap(),
            Some(3020)
        );
        assert!(web_port_override(strings(&["--port="])).is_err());
        assert!(web_port_override(strings(&["--port", "--offline"])).is_err());
        assert_eq!(
            web_token_override(strings(&["--webtoken", "  AbC-123  "])).unwrap(),
            Some("AbC-123".to_string())
        );
        assert!(web_token_override(strings(&["--webtoken="])).is_err());
    }
}
