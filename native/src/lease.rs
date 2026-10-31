use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLeaseInput {
    pub owner: Option<String>,
    #[serde(default)]
    pub fencing: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CurrentLeaseInput {
    pub owner: String,
    pub fencing: f64,
}

pub fn lease_expired(lease_json: &str, expires_at_ms: f64, now_ms: f64) -> Result<bool, String> {
    let lease: Option<EngineLeaseInput> = serde_json::from_str(lease_json)
        .map_err(|error| format!("Invalid engine lease JSON: {error}"))?;
    let Some(lease) = lease else {
        return Ok(true);
    };
    if lease.owner.as_deref().unwrap_or("").is_empty() {
        return Ok(true);
    }
    if !expires_at_ms.is_finite() || expires_at_ms == 0.0 {
        return Ok(true);
    }
    Ok(expires_at_ms <= now_ms)
}

pub fn holds_lease(
    lease_json: &str,
    current_lease_json: &str,
    expires_at_ms: f64,
    now_ms: f64,
) -> Result<bool, String> {
    let lease: Option<EngineLeaseInput> = serde_json::from_str(lease_json)
        .map_err(|error| format!("Invalid engine lease JSON: {error}"))?;
    let current: Option<CurrentLeaseInput> = serde_json::from_str(current_lease_json)
        .map_err(|error| format!("Invalid current lease JSON: {error}"))?;
    let (Some(lease), Some(current)) = (lease, current) else {
        return Ok(false);
    };
    if lease.owner.as_deref() != Some(current.owner.as_str()) || lease.fencing != current.fencing {
        return Ok(false);
    }
    lease_expired(lease_json, expires_at_ms, now_ms).map(|expired| !expired)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseAcquisition {
    decision: &'static str,
    took_over: bool,
}

pub fn lease_acquisition(
    lease_json: &str,
    owner: &str,
    expires_at_ms: f64,
    now_ms: f64,
    owner_gone: bool,
) -> Result<LeaseAcquisition, String> {
    let lease: Option<EngineLeaseInput> = serde_json::from_str(lease_json)
        .map_err(|error| format!("Invalid engine lease JSON: {error}"))?;
    let expired = lease_expired(lease_json, expires_at_ms, now_ms)?;
    if let Some(existing) = &lease {
        if existing.owner.as_deref() == Some(owner) && !expired {
            return Ok(LeaseAcquisition {
                decision: "renew",
                took_over: false,
            });
        }
    }
    if lease.is_some() && !expired && !owner_gone {
        return Ok(LeaseAcquisition {
            decision: "refuse",
            took_over: false,
        });
    }
    let took_over = lease
        .as_ref()
        .and_then(|lease| lease.owner.as_deref())
        .map(|owner| !owner.is_empty())
        .unwrap_or(false);
    Ok(LeaseAcquisition {
        decision: "acquire",
        took_over,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_and_fencing_require_the_live_generation() {
        let lease = r#"{"owner":"owner-a","fencing":4}"#;
        let current = r#"{"owner":"owner-a","fencing":4}"#;
        let wrong = r#"{"owner":"owner-a","fencing":3}"#;
        assert!(!lease_expired(lease, 5000.0, 4000.0).unwrap());
        assert!(lease_expired(lease, 5000.0, 5000.0).unwrap());
        assert!(lease_expired("null", 5000.0, 4000.0).unwrap());
        assert!(holds_lease(lease, current, 5000.0, 4000.0).unwrap());
        assert!(!holds_lease(lease, wrong, 5000.0, 4000.0).unwrap());
    }

    #[test]
    fn acquisition_renews_refuses_or_fences_a_takeover() {
        let lease = r#"{"owner":"owner-a","fencing":4}"#;
        assert_eq!(
            lease_acquisition(lease, "owner-a", 5000.0, 4000.0, false).unwrap(),
            LeaseAcquisition {
                decision: "renew",
                took_over: false
            }
        );
        assert_eq!(
            lease_acquisition(lease, "owner-b", 5000.0, 4000.0, false).unwrap(),
            LeaseAcquisition {
                decision: "refuse",
                took_over: false
            }
        );
        assert_eq!(
            lease_acquisition(lease, "owner-b", 5000.0, 6000.0, false).unwrap(),
            LeaseAcquisition {
                decision: "acquire",
                took_over: true
            }
        );
        assert_eq!(
            lease_acquisition(lease, "owner-b", 5000.0, 4000.0, true).unwrap(),
            LeaseAcquisition {
                decision: "acquire",
                took_over: true
            }
        );
    }
}
