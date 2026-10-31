use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimColumns {
    pub status: &'static str,
    pub claimed_status: &'static str,
    pub by: &'static str,
    pub at: &'static str,
    pub token: &'static str,
    pub heartbeat: &'static str,
}

pub fn claim_columns(stage: &str) -> Option<ClaimColumns> {
    match stage {
        "download" => Some(ClaimColumns {
            status: "download_status",
            claimed_status: "downloading",
            by: "download_claimed_by",
            at: "download_claimed_at",
            token: "download_claim_token",
            heartbeat: "download_heartbeat_at",
        }),
        "conversion" => Some(ClaimColumns {
            status: "conversion_status",
            claimed_status: "in_progress",
            by: "conversion_claimed_by",
            at: "conversion_claimed_at",
            token: "conversion_claim_token",
            heartbeat: "conversion_heartbeat_at",
        }),
        "metadata" => Some(ClaimColumns {
            status: "metadata_status",
            claimed_status: "in_progress",
            by: "metadata_claimed_by",
            at: "metadata_claimed_at",
            token: "metadata_claim_token",
            heartbeat: "metadata_heartbeat_at",
        }),
        _ => None,
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ClaimRef {
    by: Option<String>,
    token: Option<String>,
}

pub fn claim_ref(stage: &str, row_json: &str) -> Result<ClaimRef, String> {
    let columns = claim_columns(stage).ok_or_else(|| "invalid claim stage".to_string())?;
    let row: Value =
        serde_json::from_str(row_json).map_err(|error| format!("Invalid job row JSON: {error}"))?;
    let object = row.as_object();
    let value = |column: &str| -> Option<String> {
        object
            .and_then(|row| row.get(column))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    Ok(ClaimRef {
        by: value(columns.by),
        token: value(columns.token),
    })
}

pub fn claim_update_sql(
    stage: &str,
    set_clause: &str,
    extra_condition: Option<&str>,
) -> Result<String, String> {
    let columns = claim_columns(stage).ok_or_else(|| "invalid claim stage".to_string())?;
    let extra = extra_condition
        .filter(|condition| !condition.is_empty())
        .map(|condition| format!(" AND ({condition})"))
        .unwrap_or_default();
    Ok(format!(
        "UPDATE jobs SET {set_clause} WHERE id = ? AND {} IS ? AND {} IS ?{extra}",
        columns.token, columns.by
    ))
}

pub fn claim_release_set(stage: &str, set_clause: &str) -> Result<String, String> {
    let columns = claim_columns(stage).ok_or_else(|| "invalid claim stage".to_string())?;
    let release = [
        format!("{} = NULL", columns.by),
        format!("{} = NULL", columns.at),
        format!("{} = NULL", columns.token),
        format!("{} = NULL", columns.heartbeat),
        "updated_at = CURRENT_TIMESTAMP".to_string(),
    ]
    .join(", ");
    Ok([set_clause, release.as_str()]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(", "))
}

pub fn per_video_cap(config_json: &str) -> Result<f64, String> {
    let config: Value = serde_json::from_str(config_json)
        .map_err(|error| format!("Invalid config JSON: {error}"))?;
    let attempts = config.get("maxRetryAttempts").and_then(Value::as_f64);
    let failures = config.get("maxFailuresPerVideo").and_then(Value::as_f64);
    match (attempts, failures) {
        (Some(attempts), Some(failures)) => Ok(attempts.min(failures)),
        _ => Err("Invalid retry cap config".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_and_cas_sql_match_the_claimed_stage() {
        let columns = claim_columns("conversion").unwrap();
        assert_eq!(columns.token, "conversion_claim_token");
        assert_eq!(columns.by, "conversion_claimed_by");
        assert_eq!(
            claim_update_sql("conversion", "conversion_status = 'pending'", Some("conversion_heartbeat_at IS NULL")).unwrap(),
            "UPDATE jobs SET conversion_status = 'pending' WHERE id = ? AND conversion_claim_token IS ? AND conversion_claimed_by IS ? AND (conversion_heartbeat_at IS NULL)"
        );
        assert!(claim_release_set("metadata", "metadata_status = 'done'")
            .unwrap()
            .contains("metadata_claim_token = NULL"));
    }

    #[test]
    fn refs_keep_legacy_null_claims_and_caps_use_the_smaller_limit() {
        assert_eq!(
            claim_ref(
                "download",
                r#"{"download_claimed_by":null,"download_claim_token":null}"#
            )
            .unwrap(),
            ClaimRef {
                by: None,
                token: None
            }
        );
        assert_eq!(
            per_video_cap(r#"{"maxRetryAttempts":7,"maxFailuresPerVideo":4}"#).unwrap(),
            4.0
        );
    }
}
