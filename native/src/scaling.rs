use crate::text::is_js_whitespace;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotTargetInput {
    current: f64,
    backlog: f64,
    in_flight: f64,
    min_workers: f64,
    max_workers: f64,
    ramp_step: f64,
    agg_bps: f64,
    cap_bps: f64,
    now: f64,
    last_scale_down_at: f64,
    #[serde(default)]
    cooldown_ms: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlotTargetResult {
    target: f64,
    bandwidth_shed: bool,
}

/// One pure autoscaling decision. Database queries and live slot sets remain
/// in TypeScript; this function has no ambient state.
pub fn next_slot_target(input: SlotTargetInput) -> SlotTargetResult {
    let floor = 1.0f64.max(input.min_workers);
    let ceiling = floor.max(input.max_workers);
    let demand = 0.0f64.max(input.in_flight) + 0.0f64.max(input.backlog);
    let cooldown_ms = input.cooldown_ms.unwrap_or(30_000.0);
    let mut target = ceiling.min(floor.max(input.current));

    if demand == 0.0 {
        return SlotTargetResult {
            target: floor,
            bandwidth_shed: false,
        };
    }
    if input.cap_bps > 0.0 && input.agg_bps > input.cap_bps * 0.9 && target > floor {
        return SlotTargetResult {
            target: target - 1.0,
            bandwidth_shed: true,
        };
    }

    let wanted = floor.max(ceiling.min(demand));
    if target > wanted {
        return SlotTargetResult {
            target: wanted,
            bandwidth_shed: false,
        };
    }
    let headroom = input.cap_bps == 0.0 || input.agg_bps < input.cap_bps * 0.7;
    let cooled = input.now - input.last_scale_down_at > cooldown_ms;
    if input.backlog > 0.0 && target < ceiling && headroom && cooled {
        target = (target + 1.0f64.max(input.ramp_step))
            .min(demand)
            .min(ceiling);
    }
    SlotTargetResult {
        target,
        bandwidth_shed: false,
    }
}

/// Share an engine-wide connection/fragment budget without crossing the
/// configured per-download ceiling or the four-transfer floor.
pub fn per_download_transfers(configured: f64, active_slots: f64, budget: f64) -> f64 {
    let wanted = 1.0f64.max(configured.floor());
    let slots = 1.0f64.max(active_slots.floor());
    let share = (budget / slots).floor();
    1.0f64.max(wanted.min(4.0f64.max(share)))
}

/// Parse aria2c's K/M/G split-size spelling, using binary multipliers.
pub fn parse_aria2c_split_size_bytes(size: &str) -> Option<f64> {
    let size = size.trim_matches(is_js_whitespace);
    let bytes = size.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == 0 {
        return None;
    }
    if cursor < bytes.len() && bytes[cursor] == b'.' {
        cursor += 1;
        let fraction_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == fraction_start {
            return None;
        }
    }
    let number = size[..cursor].parse::<f64>().ok()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }

    let remainder = &size[cursor..];
    let unit_start = remainder
        .char_indices()
        .find_map(|(index, character)| (!is_js_whitespace(character)).then_some(index))
        .unwrap_or(remainder.len());
    let multiplier = match remainder[unit_start..].to_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0 * 1024.0,
        "g" | "gb" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier).floor())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> SlotTargetInput {
        SlotTargetInput {
            current: 1.0,
            backlog: 0.0,
            in_flight: 0.0,
            min_workers: 1.0,
            max_workers: 10.0,
            ramp_step: 2.0,
            agg_bps: 0.0,
            cap_bps: 0.0,
            now: 1_000_000.0,
            last_scale_down_at: 0.0,
            cooldown_ms: None,
        }
    }

    #[test]
    fn scaling_respects_demand_bandwidth_and_cooldown() {
        let mut value = input();
        value.backlog = 20.0;
        assert_eq!(next_slot_target(value).target, 3.0);

        let mut value = input();
        value.current = 4.0;
        value.backlog = 10.0;
        value.cap_bps = 1000.0;
        value.agg_bps = 950.0;
        let result = next_slot_target(value);
        assert_eq!(result.target, 3.0);
        assert!(result.bandwidth_shed);

        let mut value = input();
        value.current = 2.0;
        value.backlog = 10.0;
        value.last_scale_down_at = value.now - 5_000.0;
        assert_eq!(next_slot_target(value).target, 2.0);
    }

    #[test]
    fn transfer_budget_and_split_sizes_match_the_typescript_policy() {
        assert_eq!(per_download_transfers(32.0, 10.0, 128.0), 12.0);
        assert_eq!(per_download_transfers(64.0, 40.0, 128.0), 4.0);
        assert_eq!(parse_aria2c_split_size_bytes("1.5M"), Some(1_572_864.0));
        assert_eq!(parse_aria2c_split_size_bytes("512K"), Some(524_288.0));
        assert_eq!(parse_aria2c_split_size_bytes("1 MB"), Some(1_048_576.0));
        assert_eq!(parse_aria2c_split_size_bytes("banana"), None);
    }
}
