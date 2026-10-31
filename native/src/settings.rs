use crate::config::{validate_config_value, Config, ConfigError};
use crate::text::{js_number, js_string, js_trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
pub struct SettingField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct PreparedSettings {
    pub config: Config,
    pub coerced: Map<String, Value>,
}

fn config_message(error: ConfigError) -> String {
    let Some(issue) = error.issues.first() else {
        return "invalid configuration".to_string();
    };
    if issue.path.is_empty() {
        issue.message.clone()
    } else {
        format!("{}: {}", issue.path.join("."), issue.message)
    }
}

fn boolean(raw: &Value) -> Option<bool> {
    match raw {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => match value.as_f64() {
            Some(number) if number == 1.0 => Some(true),
            Some(number) if number == 0.0 => Some(false),
            _ => None,
        },
        Value::String(value) => match js_trim(value).to_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn list(raw: &Value) -> Vec<String> {
    let values = match raw {
        Value::Array(values) => values.clone(),
        Value::Null => vec![Value::String(String::new())],
        _ => vec![Value::String(js_string(raw))],
    };
    values
        .iter()
        .filter_map(|value| value.as_str())
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn prepare_settings(
    current: Value,
    patch: Value,
    fields: Vec<SettingField>,
) -> Result<PreparedSettings, String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "Expected a JSON object of settings".to_string())?;
    let unknown = patch
        .keys()
        .filter(|key| !fields.iter().any(|field| &field.key == *key))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(format!(
            "Not editable from the dashboard: {}",
            unknown.join(", ")
        ));
    }

    let mut coerced = Map::new();
    for field in fields {
        let Some(raw) = patch.get(&field.key) else {
            continue;
        };
        let value = match field.kind.as_str() {
            "number" => {
                let Some(number) = js_number(raw) else {
                    return Err(format!("{} must be a number", field.label));
                };
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or_else(|| format!("{} must be a number", field.label))?
            }
            "boolean" => {
                let Some(value) = boolean(raw) else {
                    return Err(format!("{} must be true or false", field.label));
                };
                Value::Bool(value)
            }
            "list" => Value::Array(list(raw).into_iter().map(Value::String).collect()),
            _ => Value::String(match raw {
                Value::String(value) => js_trim(value).to_string(),
                _ => js_string(raw),
            }),
        };
        coerced.insert(field.key, value);
    }

    let mut merged = current
        .as_object()
        .cloned()
        .ok_or_else(|| "invalid configuration".to_string())?;
    for (key, value) in &coerced {
        merged.insert(key.clone(), value.clone());
    }
    let config = validate_config_value(Value::Object(merged)).map_err(config_message)?;
    Ok(PreparedSettings { config, coerced })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields() -> Vec<SettingField> {
        serde_json::from_value(json!([
            {"key":"connectionsPerDownload","label":"Connections per download","type":"number"},
            {"key":"useAria2c","label":"Use aria2c","type":"boolean"},
            {"key":"audioTrackLanguages","label":"Audio track languages","type":"list"},
            {"key":"retryBackoffMaxSeconds","label":"Backoff max","type":"number"}
        ]))
        .unwrap()
    }

    #[test]
    fn coerces_form_values_and_validates_the_whole_config() {
        let current = serde_json::to_value(Config::default()).unwrap();
        let prepared = prepare_settings(
            current,
            json!({"connectionsPerDownload":"8", "useAria2c":"off", "audioTrackLanguages":"en, ja ,"}),
            fields(),
        )
        .unwrap();
        assert_eq!(prepared.config.connections_per_download, 8.0);
        assert!(!prepared.config.use_aria2c);
        assert_eq!(prepared.config.audio_track_languages, vec!["en", "ja"]);
    }

    #[test]
    fn rejects_unknown_keys_and_invalid_booleans() {
        let current = serde_json::to_value(Config::default()).unwrap();
        let error =
            prepare_settings(current.clone(), json!({"webToken":"secret"}), fields()).unwrap_err();
        assert!(error.contains("webToken"));
        let error = prepare_settings(current, json!({"useAria2c":"maybe"}), fields()).unwrap_err();
        assert!(error.contains("true or false"));
    }

    #[test]
    fn retains_cross_field_validation() {
        let current = serde_json::to_value(Config::default()).unwrap();
        let error =
            prepare_settings(current, json!({"retryBackoffMaxSeconds":5}), fields()).unwrap_err();
        assert!(error.contains("retryBackoffMaxSeconds"));
    }
}
