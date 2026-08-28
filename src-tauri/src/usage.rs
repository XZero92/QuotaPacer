use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Starting,
    Ready,
    Stale,
    NoLimits,
    CliMissing,
    CliUnsupported,
    LoginRequired,
    UnsupportedAuth,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageWindowKind {
    Regular,
    LunaReserve,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub bucket_id: String,
    pub bucket_label: Option<String>,
    pub kind: UsageWindowKind,
    pub used_percent: i32,
    pub remaining_percent: i32,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageViewState {
    pub connection: ConnectionState,
    pub windows: Vec<UsageWindow>,
    pub luna_reserve_active: bool,
    pub featured_window_id: Option<String>,
    pub fetched_at: Option<i64>,
    pub last_successful_at: Option<i64>,
    pub error_message: Option<String>,
}

impl UsageViewState {
    pub fn initial() -> Self {
        Self {
            connection: ConnectionState::Starting,
            windows: Vec::new(),
            luna_reserve_active: false,
            featured_window_id: None,
            fetched_at: None,
            last_successful_at: None,
            error_message: None,
        }
    }

    pub fn successful(windows: Vec<UsageWindow>) -> Self {
        let now = unix_timestamp();
        let featured_window_id = windows.first().map(|window| window.id.clone());
        Self {
            connection: if windows.is_empty() {
                ConnectionState::NoLimits
            } else {
                ConnectionState::Ready
            },
            luna_reserve_active: is_luna_reserve_active(&windows),
            windows,
            featured_window_id,
            fetched_at: Some(now),
            last_successful_at: Some(now),
            error_message: None,
        }
    }

    pub fn failure_from(
        previous: &Self,
        connection: ConnectionState,
        message: impl Into<String>,
    ) -> Self {
        let has_last_value = !previous.windows.is_empty() && previous.last_successful_at.is_some();
        Self {
            connection: if has_last_value {
                ConnectionState::Stale
            } else {
                connection
            },
            windows: previous.windows.clone(),
            luna_reserve_active: previous.luna_reserve_active,
            featured_window_id: previous.featured_window_id.clone(),
            fetched_at: previous.fetched_at,
            last_successful_at: previous.last_successful_at,
            error_message: Some(message.into()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRateLimitResponse {
    rate_limits: Option<RawRateLimitBucket>,
    rate_limits_by_limit_id: Option<HashMap<String, RawRateLimitBucket>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRateLimitBucket {
    limit_id: Option<String>,
    limit_name: Option<String>,
    primary: Option<RawRateLimitWindow>,
    secondary: Option<RawRateLimitWindow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRateLimitWindow {
    used_percent: i32,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

pub fn normalize_rate_limits(value: serde_json::Value) -> Result<Vec<UsageWindow>, String> {
    let response: RawRateLimitResponse = serde_json::from_value(value)
        .map_err(|error| format!("사용량 응답을 해석할 수 없습니다: {error}"))?;

    let mut buckets = if let Some(by_id) = response
        .rate_limits_by_limit_id
        .filter(|buckets| !buckets.is_empty())
    {
        by_id.into_iter().collect::<Vec<_>>()
    } else if let Some(bucket) = response.rate_limits {
        let id = bucket
            .limit_id
            .clone()
            .unwrap_or_else(|| "codex".to_string());
        vec![(id, bucket)]
    } else {
        Vec::new()
    };

    buckets.sort_by(|left, right| left.0.cmp(&right.0));

    let mut windows = Vec::new();
    for (map_id, bucket) in buckets {
        // `rateLimitsByLimitId` is the only identifier guaranteed to stay distinct
        // when a server payload reuses `limitId` for more than one bucket.
        let kind = usage_window_kind(&map_id, &bucket);
        if let Some(window) = bucket.primary {
            windows.push(to_usage_window(
                &map_id,
                bucket.limit_name.clone(),
                kind.clone(),
                "primary",
                window,
            ));
        }
        if let Some(window) = bucket.secondary {
            windows.push(to_usage_window(
                &map_id,
                bucket.limit_name.clone(),
                kind,
                "secondary",
                window,
            ));
        }
    }

    windows.sort_by(compare_windows);
    Ok(windows)
}

fn to_usage_window(
    bucket_id: &str,
    bucket_label: Option<String>,
    kind: UsageWindowKind,
    slot: &str,
    raw: RawRateLimitWindow,
) -> UsageWindow {
    let used_percent = raw.used_percent.clamp(0, 100);
    UsageWindow {
        id: format!("{bucket_id}:{slot}"),
        bucket_id: bucket_id.to_string(),
        bucket_label,
        kind,
        used_percent,
        remaining_percent: 100 - used_percent,
        window_duration_mins: raw.window_duration_mins,
        resets_at: raw.resets_at,
    }
}

fn usage_window_kind(map_id: &str, bucket: &RawRateLimitBucket) -> UsageWindowKind {
    if is_gpt_reserve_id(map_id)
        || bucket.limit_id.as_deref().is_some_and(is_gpt_reserve_id)
        || bucket.limit_name.as_deref().is_some_and(is_gpt_reserve_id)
    {
        UsageWindowKind::LunaReserve
    } else {
        UsageWindowKind::Regular
    }
}

fn is_gpt_reserve_id(value: &str) -> bool {
    value == "gpt-reserve"
}

pub fn is_luna_reserve(window: &UsageWindow) -> bool {
    window.kind == UsageWindowKind::LunaReserve
}

/// app-server does not expose whether Luna Reserve is currently selected. This is a
/// display-only inference: a remaining reserve window becomes preferred after any
/// regular window is exhausted.
pub fn is_luna_reserve_active(windows: &[UsageWindow]) -> bool {
    windows
        .iter()
        .any(|window| is_luna_reserve(window) && window.remaining_percent > 0)
        && windows
            .iter()
            .any(|window| !is_luna_reserve(window) && window.remaining_percent == 0)
}

fn compare_windows(left: &UsageWindow, right: &UsageWindow) -> Ordering {
    left.remaining_percent
        .cmp(&right.remaining_percent)
        .then_with(|| {
            left.resets_at
                .unwrap_or(i64::MAX)
                .cmp(&right.resets_at.unwrap_or(i64::MAX))
        })
        .then_with(|| {
            left.window_duration_mins
                .unwrap_or(i64::MAX)
                .cmp(&right.window_duration_mins.unwrap_or(i64::MAX))
        })
        .then_with(|| left.id.cmp(&right.id))
}

pub fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn weekly_only_is_a_valid_single_window() {
        let fixture = serde_json::from_str(include_str!("../fixtures/weekly-only.json")).unwrap();
        let windows = normalize_rate_limits(fixture).unwrap();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_duration_mins, Some(10_080));
        assert_eq!(windows[0].remaining_percent, 60);
        assert!(!windows
            .iter()
            .any(|window| window.id.ends_with("secondary")));
    }

    #[test]
    fn multi_window_response_is_sorted_by_lowest_remaining() {
        let windows = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 20, "windowDurationMins": 300, "resetsAt": 200 },
                    "secondary": { "usedPercent": 75, "windowDurationMins": 10080, "resetsAt": 300 }
                }
            }
        }))
        .unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].remaining_percent, 25);
        assert_eq!(windows[0].window_duration_mins, Some(10_080));
    }

    #[test]
    fn empty_multi_bucket_map_falls_back_to_single_bucket() {
        let windows = normalize_rate_limits(json!({
            "rateLimits": {
                "limitId": "fallback",
                "primary": { "usedPercent": 10, "windowDurationMins": 60, "resetsAt": null }
            },
            "rateLimitsByLimitId": {}
        }))
        .unwrap();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].bucket_id, "fallback");
    }

    #[test]
    fn secondary_only_and_multiple_limit_ids_remain_independent() {
        let windows = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "b": {
                    "primary": null,
                    "secondary": { "usedPercent": 30, "windowDurationMins": 10080 }
                },
                "a": {
                    "primary": { "usedPercent": 90, "windowDurationMins": 45 },
                    "secondary": null
                }
            }
        }))
        .unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "a:primary");
        assert_eq!(windows[1].id, "b:secondary");
        assert_eq!(windows[1].window_duration_mins, Some(10_080));
    }

    #[test]
    fn missing_windows_produces_no_limits_instead_of_fake_percentages() {
        let windows = normalize_rate_limits(json!({
            "rateLimits": { "limitId": "codex", "primary": null, "secondary": null }
        }))
        .unwrap();

        assert!(windows.is_empty());
        assert_eq!(
            UsageViewState::successful(windows).connection,
            ConnectionState::NoLimits
        );
    }

    #[test]
    fn percentages_are_clamped() {
        let windows = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "a": { "primary": { "usedPercent": 120 } },
                "b": { "primary": { "usedPercent": -4 } }
            }
        }))
        .unwrap();

        assert_eq!(windows[0].remaining_percent, 0);
        assert_eq!(windows[1].remaining_percent, 100);
    }

    #[test]
    fn luna_reserve_is_classified_and_activated_only_after_regular_exhaustion() {
        let windows = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": { "usedPercent": 100, "windowDurationMins": 300 },
                    "secondary": { "usedPercent": 20, "windowDurationMins": 10080 }
                },
                "gpt-reserve": {
                    "limitId": "codex",
                    "limitName": "gpt-reserve",
                    "primary": { "usedPercent": 10, "windowDurationMins": 10080 },
                    "secondary": { "usedPercent": 50, "windowDurationMins": 300 }
                }
            }
        }))
        .unwrap();

        assert_eq!(
            windows
                .iter()
                .filter(|window| is_luna_reserve(window))
                .count(),
            2
        );
        assert!(is_luna_reserve_active(&windows));
        assert!(UsageViewState::successful(windows.clone()).luna_reserve_active);
        assert!(windows
            .iter()
            .filter(|window| is_luna_reserve(window))
            .all(|window| window.id.starts_with("gpt-reserve:")));
    }

    #[test]
    fn luna_reserve_stays_inactive_without_remaining_reserve_or_regular_exhaustion() {
        let regular_remaining = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "codex": { "primary": { "usedPercent": 90 } },
                "gpt-reserve": { "primary": { "usedPercent": 10 } }
            }
        }))
        .unwrap();
        let reserve_exhausted = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "codex": { "primary": { "usedPercent": 100 } },
                "gpt-reserve": { "primary": { "usedPercent": 100 } }
            }
        }))
        .unwrap();

        assert!(!is_luna_reserve_active(&regular_remaining));
        assert!(!is_luna_reserve_active(&reserve_exhausted));
    }

    #[test]
    fn luna_reserve_can_be_identified_by_limit_name_when_the_map_key_is_opaque() {
        let windows = normalize_rate_limits(json!({
            "rateLimitsByLimitId": {
                "server-assigned-reserve": {
                    "limitId": "codex",
                    "limitName": "gpt-reserve",
                    "primary": { "usedPercent": 10, "windowDurationMins": 10080 }
                }
            }
        }))
        .unwrap();

        assert_eq!(windows[0].bucket_id, "server-assigned-reserve");
        assert!(is_luna_reserve(&windows[0]));
    }
}
