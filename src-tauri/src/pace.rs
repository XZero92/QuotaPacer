use crate::settings::{Language, PaceSettings, SettingsStore};
use crate::usage::{ConnectionState, UsageViewState, UsageWindow};
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

const SAMPLE_INTERVAL_SECONDS: i64 = 5 * 60;
const HISTORY_RETENTION_SECONDS: i64 = 25 * 60 * 60;
const RECENT_LOOKBACK_SECONDS: i64 = 24 * 60 * 60;
const MIN_RECENT_OBSERVATION_SECONDS: i64 = 6 * 60 * 60;
const MIN_CONFIDENT_PERIOD_USED_PERCENT: f64 = 5.0;
const WINDOW_RESET_TOLERANCE_SECONDS: i64 = 5 * 60;
const ALERT_CONFIRMATION_INTERVAL_SECONDS: i64 = 60;
const DAY_SECONDS: i64 = 24 * 60 * 60;
const WEEK_MINUTES: i64 = 7 * 24 * 60;
const PLAN_GRACE_PERCENT_POINTS: f64 = 1.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForecastBasis {
    Recent,
    PeriodAverage,
    #[default]
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaceStatus {
    Safe,
    PlanExceeded,
    ExhaustionRisk,
    #[default]
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PacePlanBreakdownKind {
    Weekly,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacePlanSegmentView {
    pub starts_at: i64,
    pub ends_at: i64,
    pub allocation_percent: f64,
    pub cumulative_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacePlanBreakdownView {
    pub kind: PacePlanBreakdownKind,
    pub current_segment_index: usize,
    pub segments: Vec<PacePlanSegmentView>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceWindowView {
    pub window_id: String,
    pub forecast_basis: ForecastBasis,
    pub observed_hours: Option<f64>,
    pub projected_exhaustion_at: Option<i64>,
    pub projected_end_percent: Option<f64>,
    pub planned_used_percent: Option<f64>,
    pub plan_delta_percent_points: Option<f64>,
    pub plan_breakdown: Option<PacePlanBreakdownView>,
    pub status: PaceStatus,
    pub early_estimate: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceViewState {
    pub windows: Vec<PaceWindowView>,
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaceSample {
    window_id: String,
    resets_at: i64,
    recorded_at: i64,
    used_percent: i32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertRecord {
    window_id: String,
    resets_at: i64,
    plan_notified: bool,
    exhaustion_notified: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaceHistoryFile {
    #[serde(default)]
    samples: Vec<PaceSample>,
    #[serde(default)]
    alerts: Vec<AlertRecord>,
}

#[derive(Clone, Debug)]
struct AlertConfirmationState {
    representative_resets_at: i64,
    plan_pending_since: Option<i64>,
    exhaustion_pending_since: Option<i64>,
}

#[derive(Default)]
struct PaceRuntime {
    history: PaceHistoryFile,
    view: PaceViewState,
    alert_confirmations: HashMap<String, AlertConfirmationState>,
}

#[derive(Clone)]
pub struct PaceService {
    runtime: Arc<Mutex<PaceRuntime>>,
    history_path: PathBuf,
    settings: SettingsStore,
    app: AppHandle,
}

struct NotificationRequest {
    title: String,
    body: String,
}

impl PaceService {
    pub fn new(app: AppHandle, settings: SettingsStore, history_path: PathBuf) -> PaceService {
        let history = fs::read_to_string(&history_path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default();
        PaceService {
            runtime: Arc::new(Mutex::new(PaceRuntime {
                history,
                ..PaceRuntime::default()
            })),
            history_path,
            settings,
            app,
        }
    }

    pub fn state(&self) -> PaceViewState {
        self.runtime
            .lock()
            .map(|runtime| runtime.view.clone())
            .unwrap_or_default()
    }

    pub fn process(&self, usage: &UsageViewState) {
        if !matches!(
            usage.connection,
            ConnectionState::Ready | ConnectionState::NoLimits
        ) {
            return;
        }
        let settings = self.settings.pace_settings();
        let Some(as_of) = usage.fetched_at else {
            return;
        };

        let (view, notifications) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            let mut history_changed = prune_history(&mut runtime.history, as_of);
            history_changed |= coalesce_alert_records(&mut runtime.history);
            history_changed |= record_samples(&mut runtime.history, usage, as_of);
            let view = calculate_state(usage, &settings, &runtime.history.samples);
            let notifications = advance_alerts_with_language(
                &mut runtime,
                usage,
                &view,
                settings.os_notifications_enabled,
                self.settings.language(),
            );
            runtime.view = view.clone();
            if history_changed || !notifications.is_empty() {
                let _ = self.save_history(&runtime.history);
            }
            (view, notifications)
        };

        let _ = self.app.emit("pace://state-changed", view);
        for notification in notifications {
            let _ = self
                .app
                .notification()
                .builder()
                .title(notification.title)
                .body(notification.body)
                .show();
        }
    }

    pub fn recompute(&self, usage: &UsageViewState) {
        let settings = self.settings.pace_settings();
        self.recompute_with_settings(usage, &settings);
    }

    pub fn settings_changed(
        &self,
        previous: &PaceSettings,
        next: &PaceSettings,
        usage: &UsageViewState,
    ) {
        if let Ok(mut runtime) = self.runtime.lock() {
            reset_confirmations_for_settings_change(&mut runtime, previous, next);
        }
        self.recompute_with_settings(usage, next);
    }

    fn recompute_with_settings(&self, usage: &UsageViewState, settings: &PaceSettings) {
        let view = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            let view = calculate_state(usage, settings, &runtime.history.samples);
            runtime.view = view.clone();
            view
        };
        let _ = self.app.emit("pace://state-changed", view);
    }

    pub fn clear_history(&self, usage: &UsageViewState) -> Result<(), String> {
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "페이스 이력을 잠글 수 없습니다.".to_string())?;
            runtime.history = PaceHistoryFile::default();
            runtime.alert_confirmations.clear();
            self.save_history(&runtime.history)?;
        }
        self.recompute(usage);
        Ok(())
    }

    fn save_history(&self, history: &PaceHistoryFile) -> Result<(), String> {
        if let Some(parent) = self.history_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("페이스 이력 폴더를 만들 수 없습니다: {error}"))?;
        }
        let contents = serde_json::to_string_pretty(history)
            .map_err(|error| format!("페이스 이력을 직렬화할 수 없습니다: {error}"))?;
        fs::write(&self.history_path, contents)
            .map_err(|error| format!("페이스 이력을 저장할 수 없습니다: {error}"))
    }
}

fn reset_confirmations_for_settings_change(
    runtime: &mut PaceRuntime,
    previous: &PaceSettings,
    next: &PaceSettings,
) {
    if previous.os_notifications_enabled != next.os_notifications_enabled {
        runtime.alert_confirmations.clear();
    } else if previous.weekday_weights != next.weekday_weights {
        for confirmation in runtime.alert_confirmations.values_mut() {
            confirmation.plan_pending_since = None;
        }
    }
}

fn prune_history(history: &mut PaceHistoryFile, as_of: i64) -> bool {
    let before_samples = history.samples.len();
    let before_alerts = history.alerts.len();
    let cutoff = as_of - HISTORY_RETENTION_SECONDS;
    history
        .samples
        .retain(|sample| sample.recorded_at >= cutoff && sample.recorded_at <= as_of);
    history.alerts.retain(|alert| alert.resets_at >= cutoff);
    before_samples != history.samples.len() || before_alerts != history.alerts.len()
}

fn same_window_generation(
    left_window_id: &str,
    left_resets_at: i64,
    right_window_id: &str,
    right_resets_at: i64,
) -> bool {
    left_window_id == right_window_id
        && left_resets_at.abs_diff(right_resets_at) <= WINDOW_RESET_TOLERANCE_SECONDS as u64
}

fn coalesce_alert_records(history: &mut PaceHistoryFile) -> bool {
    let before = history.alerts.len();
    let mut merged: Vec<AlertRecord> = Vec::with_capacity(before);
    for alert in history.alerts.drain(..) {
        if let Some(existing) = merged.iter_mut().find(|existing| {
            same_window_generation(
                &existing.window_id,
                existing.resets_at,
                &alert.window_id,
                alert.resets_at,
            )
        }) {
            existing.plan_notified |= alert.plan_notified;
            existing.exhaustion_notified |= alert.exhaustion_notified;
        } else {
            merged.push(alert);
        }
    }
    history.alerts = merged;
    history.alerts.len() != before
}

fn record_samples(history: &mut PaceHistoryFile, usage: &UsageViewState, as_of: i64) -> bool {
    let mut changed = false;
    for window in &usage.windows {
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        let last_recorded = history
            .samples
            .iter()
            .filter(|sample| {
                same_window_generation(&sample.window_id, sample.resets_at, &window.id, resets_at)
            })
            .map(|sample| sample.recorded_at)
            .max();
        if last_recorded
            .map(|recorded_at| as_of - recorded_at < SAMPLE_INTERVAL_SECONDS)
            .unwrap_or(false)
        {
            continue;
        }
        history.samples.push(PaceSample {
            window_id: window.id.clone(),
            resets_at,
            recorded_at: as_of,
            used_percent: window.used_percent,
        });
        changed = true;
    }
    changed
}

fn calculate_state(
    usage: &UsageViewState,
    settings: &PaceSettings,
    samples: &[PaceSample],
) -> PaceViewState {
    let as_of = match usage.connection {
        ConnectionState::Stale => usage.last_successful_at,
        _ => usage.fetched_at.or(usage.last_successful_at),
    };
    let windows = as_of
        .map(|as_of| {
            usage
                .windows
                .iter()
                .map(|window| calculate_window(window, as_of, settings, samples, None))
                .collect()
        })
        .unwrap_or_default();
    PaceViewState {
        windows,
        updated_at: as_of,
    }
}

fn calculate_window(
    window: &UsageWindow,
    as_of: i64,
    settings: &PaceSettings,
    samples: &[PaceSample],
    start_weekday_override: Option<usize>,
) -> PaceWindowView {
    let used_percent = f64::from(window.used_percent.clamp(0, 100));
    let plan = planned_used_percent(window, as_of, settings, start_weekday_override);
    let plan_breakdown = weekly_plan_breakdown(window, as_of, settings, start_weekday_override);
    let forecast = recent_forecast(window, as_of, used_percent, samples)
        .or_else(|| period_average_forecast(window, as_of, used_percent));
    let plan_delta = plan.map(|planned| used_percent - planned);
    let exhaustion_risk = forecast
        .as_ref()
        .and_then(|forecast| forecast.projected_exhaustion_at)
        .zip(window.resets_at)
        .map(|(exhaustion_at, resets_at)| exhaustion_at < resets_at)
        .unwrap_or(false);
    let plan_exceeded = plan_delta
        .map(|delta| delta > PLAN_GRACE_PERCENT_POINTS)
        .unwrap_or(false);
    let status = if exhaustion_risk {
        PaceStatus::ExhaustionRisk
    } else if plan_exceeded {
        PaceStatus::PlanExceeded
    } else if forecast.is_some() {
        PaceStatus::Safe
    } else {
        PaceStatus::Unavailable
    };

    PaceWindowView {
        window_id: window.id.clone(),
        forecast_basis: forecast
            .as_ref()
            .map(|forecast| forecast.basis)
            .unwrap_or_default(),
        observed_hours: forecast.as_ref().map(|forecast| forecast.observed_hours),
        projected_exhaustion_at: forecast
            .as_ref()
            .and_then(|forecast| forecast.projected_exhaustion_at),
        projected_end_percent: forecast
            .as_ref()
            .map(|forecast| forecast.projected_end_percent),
        planned_used_percent: plan,
        plan_delta_percent_points: plan_delta,
        plan_breakdown,
        status,
        early_estimate: forecast
            .as_ref()
            .map(|forecast| forecast.early_estimate)
            .unwrap_or(false),
    }
}

struct Forecast {
    basis: ForecastBasis,
    observed_hours: f64,
    projected_exhaustion_at: Option<i64>,
    projected_end_percent: f64,
    early_estimate: bool,
}

fn recent_forecast(
    window: &UsageWindow,
    as_of: i64,
    used_percent: f64,
    samples: &[PaceSample],
) -> Option<Forecast> {
    let duration_seconds = window.window_duration_mins?.checked_mul(60)?;
    if duration_seconds < DAY_SECONDS {
        return None;
    }
    let resets_at = window.resets_at?;
    let cutoff = as_of - RECENT_LOOKBACK_SECONDS;
    let sample = samples
        .iter()
        .filter(|sample| {
            same_window_generation(&sample.window_id, sample.resets_at, &window.id, resets_at)
                && sample.recorded_at >= cutoff
                && sample.recorded_at < as_of
                && as_of - sample.recorded_at >= MIN_RECENT_OBSERVATION_SECONDS
                && sample.used_percent <= window.used_percent
        })
        .min_by_key(|sample| sample.recorded_at)?;
    let observed_seconds = as_of - sample.recorded_at;
    let used_delta = used_percent - f64::from(sample.used_percent);
    Some(project_forecast(
        ForecastBasis::Recent,
        used_percent,
        used_delta / observed_seconds as f64,
        as_of,
        resets_at,
        observed_seconds,
        false,
    ))
}

fn period_average_forecast(
    window: &UsageWindow,
    as_of: i64,
    used_percent: f64,
) -> Option<Forecast> {
    let duration_seconds = window.window_duration_mins?.checked_mul(60)?;
    if duration_seconds <= 0 {
        return None;
    }
    let resets_at = window.resets_at?;
    let starts_at = resets_at - duration_seconds;
    let observed_seconds = (as_of - starts_at).clamp(0, duration_seconds);
    if observed_seconds <= 0 {
        return None;
    }
    let confidence_threshold = (duration_seconds / 100).max(15 * 60);
    let early_estimate = observed_seconds < confidence_threshold
        || (duration_seconds >= DAY_SECONDS
            && (observed_seconds < MIN_RECENT_OBSERVATION_SECONDS
                || used_percent < MIN_CONFIDENT_PERIOD_USED_PERCENT));
    Some(project_forecast(
        ForecastBasis::PeriodAverage,
        used_percent,
        used_percent / observed_seconds as f64,
        as_of,
        resets_at,
        observed_seconds,
        early_estimate,
    ))
}

fn project_forecast(
    basis: ForecastBasis,
    used_percent: f64,
    rate_per_second: f64,
    as_of: i64,
    resets_at: i64,
    observed_seconds: i64,
    early_estimate: bool,
) -> Forecast {
    let remaining_seconds = (resets_at - as_of).max(0);
    let projected_end_percent = used_percent + rate_per_second * remaining_seconds as f64;
    let projected_exhaustion_at = if used_percent >= 100.0 {
        Some(as_of)
    } else if rate_per_second > 0.0 {
        Some(as_of + ((100.0 - used_percent) / rate_per_second).ceil() as i64)
            .filter(|timestamp| *timestamp <= resets_at)
    } else {
        None
    };
    Forecast {
        basis,
        observed_hours: observed_seconds as f64 / 3600.0,
        projected_exhaustion_at,
        projected_end_percent,
        early_estimate,
    }
}

fn planned_used_percent(
    window: &UsageWindow,
    as_of: i64,
    settings: &PaceSettings,
    start_weekday_override: Option<usize>,
) -> Option<f64> {
    let duration_minutes = window.window_duration_mins?;
    let resets_at = window.resets_at?;
    let duration_seconds = duration_minutes.checked_mul(60)?;
    if duration_seconds <= 0 {
        return None;
    }
    let starts_at = resets_at - duration_seconds;
    if as_of < starts_at {
        return Some(0.0);
    }
    if as_of >= resets_at {
        return Some(100.0);
    }
    if duration_minutes != WEEK_MINUTES {
        return Some(
            ((as_of - starts_at) as f64 / duration_seconds as f64 * 100.0).clamp(0.0, 100.0),
        );
    }

    let segment = ((as_of - starts_at) / DAY_SECONDS).clamp(0, 6) as usize;
    let start_weekday = start_weekday_override.unwrap_or_else(|| local_weekday_index(starts_at));
    let allocations = weekly_allocations(settings, start_weekday);
    let elapsed_in_segment = (as_of - starts_at) % DAY_SECONDS;
    let segment_progress = elapsed_in_segment as f64 / DAY_SECONDS as f64;
    Some(
        (allocations[..segment].iter().sum::<f64>() + allocations[segment] * segment_progress)
            .clamp(0.0, 100.0),
    )
}

fn weekly_plan_breakdown(
    window: &UsageWindow,
    as_of: i64,
    settings: &PaceSettings,
    start_weekday_override: Option<usize>,
) -> Option<PacePlanBreakdownView> {
    let duration_minutes = window.window_duration_mins?;
    if duration_minutes != WEEK_MINUTES {
        return None;
    }
    let resets_at = window.resets_at?;
    let starts_at = resets_at - duration_minutes.checked_mul(60)?;
    let start_weekday = start_weekday_override.unwrap_or_else(|| local_weekday_index(starts_at));
    let allocations = weekly_allocations(settings, start_weekday);
    let current_segment_index = ((as_of - starts_at) / DAY_SECONDS).clamp(0, 6) as usize;
    let mut cumulative = 0.0;
    let segments = allocations
        .into_iter()
        .enumerate()
        .map(|(index, allocation_percent)| {
            cumulative = (cumulative + allocation_percent).min(100.0);
            let segment_starts_at = starts_at + index as i64 * DAY_SECONDS;
            PacePlanSegmentView {
                starts_at: segment_starts_at,
                ends_at: segment_starts_at + DAY_SECONDS,
                allocation_percent,
                cumulative_percent: cumulative,
            }
        })
        .collect();
    Some(PacePlanBreakdownView {
        kind: PacePlanBreakdownKind::Weekly,
        current_segment_index,
        segments,
    })
}

fn weekly_allocations(settings: &PaceSettings, start_weekday: usize) -> [f64; 7] {
    let allocations = normalized_weekday_allocations(&settings.weekday_weights);
    std::array::from_fn(|offset| allocations[(start_weekday + offset) % 7])
}

fn normalized_weekday_allocations(weights: &[u8; 7]) -> [f64; 7] {
    let fallback = [5; 7];
    let effective_weights = if weights.iter().all(|weight| *weight == 0) {
        &fallback
    } else {
        weights
    };
    let total = effective_weights
        .iter()
        .map(|weight| u32::from(*weight))
        .sum::<u32>();
    let mut tenths = [0_u16; 7];
    let mut remainders = [0_u32; 7];

    for (index, weight) in effective_weights.iter().enumerate() {
        let scaled = u32::from(*weight) * 1000;
        tenths[index] = (scaled / total) as u16;
        remainders[index] = scaled % total;
    }

    let assigned = tenths.iter().map(|value| u32::from(*value)).sum::<u32>();
    let remaining = (1000 - assigned) as usize;
    let mut order = [0, 1, 2, 3, 4, 5, 6];
    order.sort_by(|left, right| {
        remainders[*right]
            .cmp(&remainders[*left])
            .then_with(|| left.cmp(right))
    });
    for index in order.into_iter().take(remaining) {
        tenths[index] += 1;
    }

    std::array::from_fn(|index| f64::from(tenths[index]) / 10.0)
}

fn local_weekday_index(timestamp: i64) -> usize {
    Local
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|datetime| datetime.weekday().num_days_from_monday() as usize)
        .unwrap_or(0)
}

fn advance_alerts_with_language(
    runtime: &mut PaceRuntime,
    usage: &UsageViewState,
    view: &PaceViewState,
    notifications_enabled: bool,
    language: Language,
) -> Vec<NotificationRequest> {
    if usage.connection == ConnectionState::Stale {
        return Vec::new();
    }
    if !notifications_enabled {
        runtime.alert_confirmations.clear();
        return Vec::new();
    }
    let Some(observed_at) = usage.fetched_at else {
        return Vec::new();
    };
    let mut notifications = Vec::new();
    for (window, pace) in usage.windows.iter().zip(&view.windows) {
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        let plan_candidate = pace
            .plan_delta_percent_points
            .map(|delta| delta > PLAN_GRACE_PERCENT_POINTS)
            .unwrap_or(false);
        let exhaustion_candidate =
            pace.status == PaceStatus::ExhaustionRisk && !pace.early_estimate;
        let confirmation = runtime
            .alert_confirmations
            .entry(window.id.clone())
            .or_insert_with(|| AlertConfirmationState {
                representative_resets_at: resets_at,
                plan_pending_since: None,
                exhaustion_pending_since: None,
            });
        if confirmation.representative_resets_at.abs_diff(resets_at)
            > WINDOW_RESET_TOLERANCE_SECONDS as u64
        {
            *confirmation = AlertConfirmationState {
                representative_resets_at: resets_at,
                plan_pending_since: None,
                exhaustion_pending_since: None,
            };
        }
        let plan_confirmed = confirm_alert_candidate(
            &mut confirmation.plan_pending_since,
            plan_candidate,
            observed_at,
        );
        let exhaustion_confirmed = confirm_alert_candidate(
            &mut confirmation.exhaustion_pending_since,
            exhaustion_candidate,
            observed_at,
        );
        let alert_index = runtime
            .history
            .alerts
            .iter()
            .position(|alert| {
                same_window_generation(&alert.window_id, alert.resets_at, &window.id, resets_at)
            })
            .unwrap_or_else(|| {
                runtime.history.alerts.push(AlertRecord {
                    window_id: window.id.clone(),
                    resets_at,
                    ..AlertRecord::default()
                });
                runtime.history.alerts.len() - 1
            });
        let alert = &mut runtime.history.alerts[alert_index];
        let notify_plan = plan_confirmed && !alert.plan_notified;
        let notify_exhaustion = exhaustion_confirmed && !alert.exhaustion_notified;
        if !notify_plan && !notify_exhaustion {
            continue;
        }

        let label = window_duration_label(window.window_duration_mins, language);
        let title = if notify_plan && notify_exhaustion {
            match language {
                Language::Ko => format!("QuotaPacer · {label} 계획·소진 경고"),
                Language::En => format!("QuotaPacer · {label} plan and exhaustion alert"),
            }
        } else if notify_exhaustion {
            match language {
                Language::Ko => format!("QuotaPacer · {label} 초기화 전 소진 예상"),
                Language::En => format!("QuotaPacer · {label} limit may run out before reset"),
            }
        } else {
            match language {
                Language::Ko => format!("QuotaPacer · {label} 사용 계획 초과"),
                Language::En => format!("QuotaPacer · {label} usage is ahead of plan"),
            }
        };
        let mut parts = Vec::new();
        if notify_plan {
            if let Some(delta) = pace.plan_delta_percent_points {
                parts.push(match language {
                    Language::Ko => format!("현재 계획보다 {:.0}%p 초과", delta.max(0.0)),
                    Language::En => format!("{:.0} pp ahead of the current plan", delta.max(0.0)),
                });
            }
            alert.plan_notified = true;
        }
        if notify_exhaustion {
            if let Some(exhaustion_at) = pace.projected_exhaustion_at {
                let lead_minutes = ((resets_at - exhaustion_at).max(0) + 59) / 60;
                let lead = format_lead_duration(lead_minutes, language);
                parts.push(match language {
                    Language::Ko => format!("초기화보다 약 {lead} 먼저 소진 예상"),
                    Language::En => format!("Expected to run out about {lead} before reset"),
                });
            }
            alert.exhaustion_notified = true;
        }
        notifications.push(NotificationRequest {
            title,
            body: parts.join(" · "),
        });
    }
    notifications
}

#[cfg(test)]
fn advance_alerts(
    runtime: &mut PaceRuntime,
    usage: &UsageViewState,
    view: &PaceViewState,
    notifications_enabled: bool,
) -> Vec<NotificationRequest> {
    advance_alerts_with_language(runtime, usage, view, notifications_enabled, Language::Ko)
}

fn confirm_alert_candidate(
    pending_since: &mut Option<i64>,
    candidate: bool,
    observed_at: i64,
) -> bool {
    if !candidate {
        *pending_since = None;
        return false;
    }
    match *pending_since {
        Some(started_at) => {
            observed_at > started_at
                && observed_at - started_at >= ALERT_CONFIRMATION_INTERVAL_SECONDS
        }
        None => {
            *pending_since = Some(observed_at);
            false
        }
    }
}

fn format_lead_duration(total_minutes: i64, language: Language) -> String {
    let total_minutes = total_minutes.max(0);
    let days = total_minutes / (24 * 60);
    let hours = (total_minutes % (24 * 60)) / 60;
    let minutes = total_minutes % 60;

    if days > 0 {
        if hours > 0 {
            return match language {
                Language::Ko => format!("{days}일 {hours}시간"),
                Language::En => format!("{days}d {hours}h"),
            };
        }
        if minutes > 0 {
            return match language {
                Language::Ko => format!("{days}일 {minutes}분"),
                Language::En => format!("{days}d {minutes}m"),
            };
        }
        return match language {
            Language::Ko => format!("{days}일"),
            Language::En => format!("{days}d"),
        };
    }
    if hours > 0 {
        if minutes > 0 {
            return match language {
                Language::Ko => format!("{hours}시간 {minutes}분"),
                Language::En => format!("{hours}h {minutes}m"),
            };
        }
        return match language {
            Language::Ko => format!("{hours}시간"),
            Language::En => format!("{hours}h"),
        };
    }
    match language {
        Language::Ko => format!("{minutes}분"),
        Language::En => format!("{minutes}m"),
    }
}

fn window_duration_label(duration_minutes: Option<i64>, language: Language) -> String {
    let Some(minutes) = duration_minutes else {
        return match language {
            Language::Ko => "사용량".to_string(),
            Language::En => "usage".to_string(),
        };
    };
    if minutes == WEEK_MINUTES {
        return match language {
            Language::Ko => "주간".to_string(),
            Language::En => "weekly".to_string(),
        };
    }
    if minutes % (24 * 60) == 0 {
        return match language {
            Language::Ko => format!("{}일", minutes / (24 * 60)),
            Language::En => format!("{}d", minutes / (24 * 60)),
        };
    }
    if minutes % 60 == 0 {
        return match language {
            Language::Ko => format!("{}시간", minutes / 60),
            Language::En => format!("{}h", minutes / 60),
        };
    }
    match language {
        Language::Ko => format!("{minutes}분"),
        Language::En => format!("{minutes}m"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weekly_window(used_percent: i32, resets_at: i64) -> UsageWindow {
        UsageWindow {
            id: "codex:weekly".to_string(),
            bucket_id: "codex".to_string(),
            bucket_label: None,
            used_percent,
            remaining_percent: 100 - used_percent,
            window_duration_mins: Some(WEEK_MINUTES),
            resets_at: Some(resets_at),
        }
    }

    fn usage(window: UsageWindow, as_of: i64) -> UsageViewState {
        UsageViewState {
            connection: ConnectionState::Ready,
            windows: vec![window],
            featured_window_id: Some("codex:weekly".to_string()),
            fetched_at: Some(as_of),
            last_successful_at: Some(as_of),
            error_message: None,
        }
    }

    #[test]
    fn period_average_projects_exhaustion_before_reset() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(60, resets_at);
        let pace = calculate_window(
            &window,
            3 * DAY_SECONDS,
            &PaceSettings::default(),
            &[],
            Some(0),
        );

        assert_eq!(pace.forecast_basis, ForecastBasis::PeriodAverage);
        assert_eq!(pace.status, PaceStatus::ExhaustionRisk);
        assert_eq!(pace.projected_end_percent, Some(140.0));
        assert!(pace.projected_exhaustion_at.unwrap() < resets_at);
    }

    #[test]
    fn long_period_average_requires_time_and_usage_for_confidence() {
        let resets_at = 7 * DAY_SECONDS;
        let cases = [
            (3 * 60 * 60, 3, true),
            (MIN_RECENT_OBSERVATION_SECONDS, 4, true),
            (MIN_RECENT_OBSERVATION_SECONDS, 5, false),
        ];

        for (as_of, used_percent, expected_early_estimate) in cases {
            let pace = calculate_window(
                &weekly_window(used_percent, resets_at),
                as_of,
                &PaceSettings::default(),
                &[],
                Some(0),
            );

            assert_eq!(pace.forecast_basis, ForecastBasis::PeriodAverage);
            assert_eq!(pace.status, PaceStatus::ExhaustionRisk);
            assert_eq!(pace.early_estimate, expected_early_estimate);
        }
    }

    #[test]
    fn recent_forecast_wins_after_six_hours_and_ignores_other_resets() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 4 * DAY_SECONDS;
        let window = weekly_window(50, resets_at);
        let samples = vec![
            PaceSample {
                window_id: window.id.clone(),
                resets_at,
                recorded_at: as_of - MIN_RECENT_OBSERVATION_SECONDS,
                used_percent: 40,
            },
            PaceSample {
                window_id: window.id.clone(),
                resets_at: resets_at - WINDOW_RESET_TOLERANCE_SECONDS - 1,
                recorded_at: as_of - RECENT_LOOKBACK_SECONDS,
                used_percent: 1,
            },
        ];
        let pace = calculate_window(&window, as_of, &PaceSettings::default(), &samples, Some(0));

        assert_eq!(pace.forecast_basis, ForecastBasis::Recent);
        assert_eq!(pace.observed_hours, Some(6.0));
        assert!(pace.projected_exhaustion_at.is_some());
    }

    #[test]
    fn insufficient_recent_history_falls_back_to_period_average() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 2 * DAY_SECONDS;
        let window = weekly_window(10, resets_at);
        let samples = vec![PaceSample {
            window_id: window.id.clone(),
            resets_at,
            recorded_at: as_of - MIN_RECENT_OBSERVATION_SECONDS + 1,
            used_percent: 5,
        }];

        let pace = calculate_window(&window, as_of, &PaceSettings::default(), &samples, Some(0));
        assert_eq!(pace.forecast_basis, ForecastBasis::PeriodAverage);
    }

    #[test]
    fn recent_forecast_uses_only_the_latest_twenty_four_hours() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 4 * DAY_SECONDS;
        let window = weekly_window(30, resets_at);
        let samples = vec![
            PaceSample {
                window_id: window.id.clone(),
                resets_at,
                recorded_at: as_of - RECENT_LOOKBACK_SECONDS - 1,
                used_percent: 1,
            },
            PaceSample {
                window_id: window.id.clone(),
                resets_at,
                recorded_at: as_of - MIN_RECENT_OBSERVATION_SECONDS,
                used_percent: 20,
            },
        ];

        let pace = calculate_window(&window, as_of, &PaceSettings::default(), &samples, Some(0));
        assert_eq!(pace.forecast_basis, ForecastBasis::Recent);
        assert_eq!(pace.observed_hours, Some(6.0));
    }

    #[test]
    fn history_pruning_keeps_only_the_last_twenty_five_hours() {
        let as_of = 30 * DAY_SECONDS;
        let mut history = PaceHistoryFile {
            samples: vec![
                PaceSample {
                    window_id: "old".to_string(),
                    resets_at: as_of,
                    recorded_at: as_of - HISTORY_RETENTION_SECONDS - 1,
                    used_percent: 1,
                },
                PaceSample {
                    window_id: "current".to_string(),
                    resets_at: as_of,
                    recorded_at: as_of - HISTORY_RETENTION_SECONDS,
                    used_percent: 2,
                },
            ],
            alerts: vec![],
        };

        assert!(prune_history(&mut history, as_of));
        assert_eq!(history.samples.len(), 1);
        assert_eq!(history.samples[0].window_id, "current");
    }

    #[test]
    fn window_generation_uses_an_inclusive_five_minute_tolerance_without_chaining() {
        assert!(same_window_generation("weekly", 1_000, "weekly", 1_300));
        assert!(!same_window_generation("weekly", 1_000, "weekly", 1_301));
        assert!(!same_window_generation("weekly", 1_000, "other", 1_000));

        let mut history = PaceHistoryFile {
            samples: vec![],
            alerts: vec![
                AlertRecord {
                    window_id: "weekly".to_string(),
                    resets_at: 1_000,
                    plan_notified: true,
                    exhaustion_notified: false,
                },
                AlertRecord {
                    window_id: "weekly".to_string(),
                    resets_at: 1_300,
                    plan_notified: false,
                    exhaustion_notified: true,
                },
                AlertRecord {
                    window_id: "weekly".to_string(),
                    resets_at: 1_600,
                    plan_notified: false,
                    exhaustion_notified: false,
                },
            ],
        };
        assert!(coalesce_alert_records(&mut history));
        assert_eq!(history.alerts.len(), 2);
        assert!(history.alerts[0].plan_notified);
        assert!(history.alerts[0].exhaustion_notified);
        assert_eq!(history.alerts[1].resets_at, 1_600);
    }

    #[test]
    fn sample_interval_and_recent_forecast_accept_small_reset_jitter() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 4 * DAY_SECONDS;
        let window = weekly_window(30, resets_at);
        let mut history = PaceHistoryFile {
            samples: vec![PaceSample {
                window_id: window.id.clone(),
                resets_at: resets_at - WINDOW_RESET_TOLERANCE_SECONDS,
                recorded_at: as_of - MIN_RECENT_OBSERVATION_SECONDS,
                used_percent: 20,
            }],
            alerts: vec![],
        };

        let pace = calculate_window(
            &window,
            as_of,
            &PaceSettings::default(),
            &history.samples,
            Some(0),
        );
        assert_eq!(pace.forecast_basis, ForecastBasis::Recent);
        assert_eq!(pace.observed_hours, Some(6.0));
        assert_eq!(pace.projected_end_percent, Some(150.0));

        let first_usage = usage(window.clone(), as_of - MIN_RECENT_OBSERVATION_SECONDS + 60);
        assert!(!record_samples(
            &mut history,
            &first_usage,
            as_of - MIN_RECENT_OBSERVATION_SECONDS + 60
        ));
        let later = as_of - MIN_RECENT_OBSERVATION_SECONDS + SAMPLE_INTERVAL_SECONDS;
        assert!(record_samples(&mut history, &usage(window, later), later));
    }

    #[test]
    fn missing_duration_and_reset_leave_the_forecast_unavailable() {
        let window = UsageWindow {
            window_duration_mins: None,
            resets_at: None,
            ..weekly_window(10, 0)
        };
        let pace = calculate_window(&window, DAY_SECONDS, &PaceSettings::default(), &[], None);

        assert_eq!(pace.forecast_basis, ForecastBasis::Unavailable);
        assert_eq!(pace.status, PaceStatus::Unavailable);
        assert_eq!(pace.planned_used_percent, None);
    }

    #[test]
    fn plan_without_a_forecast_is_not_reported_as_safe() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let pace = calculate_window(&window, 0, &PaceSettings::default(), &[], Some(0));

        assert_eq!(pace.forecast_basis, ForecastBasis::Unavailable);
        assert!(pace.planned_used_percent.is_some());
        assert_eq!(pace.status, PaceStatus::Unavailable);
    }

    #[test]
    fn plan_exceeded_without_a_forecast_still_alerts() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 0;
        let usage = usage(weekly_window(20, resets_at), as_of);
        let view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut runtime = PaceRuntime::default();

        assert_eq!(view.windows[0].forecast_basis, ForecastBasis::Unavailable);
        assert_eq!(view.windows[0].status, PaceStatus::PlanExceeded);
        assert!(view.windows[0].projected_end_percent.is_none());
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let mut confirmed_usage = usage.clone();
        confirmed_usage.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        let notifications = advance_alerts(&mut runtime, &confirmed_usage, &view, true);
        assert_eq!(notifications.len(), 1);
        assert!(notifications[0].title.contains("사용 계획 초과"));
        assert!(runtime.history.alerts[0].plan_notified);
        assert!(!runtime.history.alerts[0].exhaustion_notified);
    }

    #[test]
    fn exhaustion_exactly_at_reset_is_safe() {
        let resets_at = 100 * 60;
        let as_of = 50 * 60;
        let window = UsageWindow {
            window_duration_mins: Some(100),
            resets_at: Some(resets_at),
            ..weekly_window(50, resets_at)
        };
        let pace = calculate_window(&window, as_of, &PaceSettings::default(), &[], None);

        assert_eq!(pace.projected_exhaustion_at, Some(resets_at));
        assert_eq!(pace.projected_end_percent, Some(100.0));
        assert_eq!(pace.status, PaceStatus::Safe);
    }

    #[test]
    fn zero_recent_consumption_projects_the_current_total() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 2 * DAY_SECONDS;
        let window = weekly_window(10, resets_at);
        let samples = vec![PaceSample {
            window_id: window.id.clone(),
            resets_at,
            recorded_at: as_of - MIN_RECENT_OBSERVATION_SECONDS,
            used_percent: 10,
        }];

        let pace = calculate_window(&window, as_of, &PaceSettings::default(), &samples, Some(0));
        assert_eq!(pace.projected_end_percent, Some(10.0));
        assert_eq!(pace.projected_exhaustion_at, None);
    }

    #[test]
    fn default_weekly_plan_interpolates_each_reset_aligned_day() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let settings = PaceSettings::default();

        let first = planned_used_percent(&window, 0, &settings, Some(0)).unwrap();
        let first_midpoint =
            planned_used_percent(&window, DAY_SECONDS / 2, &settings, Some(0)).unwrap();
        let second = planned_used_percent(&window, DAY_SECONDS, &settings, Some(0)).unwrap();
        let third = planned_used_percent(&window, 2 * DAY_SECONDS, &settings, Some(0)).unwrap();
        let end = planned_used_percent(&window, resets_at, &settings, Some(0)).unwrap();
        assert_eq!(first, 0.0);
        assert!((first_midpoint - 7.15).abs() < 0.001);
        assert!((second - 14.3).abs() < 0.001);
        assert!((third - 28.6).abs() < 0.001);
        assert_eq!(end, 100.0);
    }

    #[test]
    fn default_weekly_plan_matches_a_representative_case() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(25, resets_at);
        let planned =
            planned_used_percent(&window, 132_543, &PaceSettings::default(), Some(0)).unwrap();
        assert!((planned - 21.937_093_75).abs() < 0.000_001);
    }

    #[test]
    fn weekly_plan_exposes_reset_aligned_segments_for_visualization() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let pace = calculate_window(
            &window,
            2 * DAY_SECONDS,
            &PaceSettings::default(),
            &[],
            Some(0),
        );
        let breakdown = pace.plan_breakdown.unwrap();

        assert_eq!(breakdown.kind, PacePlanBreakdownKind::Weekly);
        assert_eq!(breakdown.current_segment_index, 2);
        assert_eq!(breakdown.segments.len(), 7);
        assert_eq!(breakdown.segments[0].starts_at, 0);
        assert_eq!(breakdown.segments[0].ends_at, DAY_SECONDS);
        assert!((breakdown.segments[2].cumulative_percent - 42.9).abs() < 0.001);

        let short_window = UsageWindow {
            window_duration_mins: Some(300),
            resets_at: Some(300 * 60),
            ..weekly_window(0, 300 * 60)
        };
        let short_pace = calculate_window(&short_window, 0, &PaceSettings::default(), &[], None);
        assert!(short_pace.plan_breakdown.is_none());
    }

    #[test]
    fn weekday_weights_normalize_to_exact_tenths() {
        assert_eq!(
            normalized_weekday_allocations(&[5; 7]),
            [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2]
        );
        assert_eq!(
            normalized_weekday_allocations(&[8, 8, 8, 8, 8, 5, 5]),
            [16.0, 16.0, 16.0, 16.0, 16.0, 10.0, 10.0]
        );
        assert_eq!(
            normalized_weekday_allocations(&[4, 4, 4, 4, 4, 10, 10]),
            [10.0, 10.0, 10.0, 10.0, 10.0, 25.0, 25.0]
        );
        assert_eq!(
            normalized_weekday_allocations(&[0; 7]),
            [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2]
        );
    }

    #[test]
    fn weighted_plan_uses_the_weekday_at_the_window_start() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let settings = PaceSettings {
            weekday_weights: [1, 1, 2, 1, 2, 2, 1],
            os_notifications_enabled: false,
        };

        let first = planned_used_percent(&window, 0, &settings, Some(2)).unwrap();
        let first_midpoint =
            planned_used_percent(&window, DAY_SECONDS / 2, &settings, Some(2)).unwrap();
        let second = planned_used_percent(&window, DAY_SECONDS, &settings, Some(2)).unwrap();
        assert_eq!(first, 0.0);
        assert_eq!(first_midpoint, 10.0);
        assert_eq!(second, 20.0);
    }

    #[test]
    fn zero_allocation_keeps_the_weekly_plan_flat_for_that_segment() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(20, resets_at);
        let settings = PaceSettings {
            weekday_weights: [2, 0, 2, 2, 2, 1, 1],
            os_notifications_enabled: false,
        };

        let start = planned_used_percent(&window, DAY_SECONDS, &settings, Some(0)).unwrap();
        let midpoint =
            planned_used_percent(&window, DAY_SECONDS + DAY_SECONDS / 2, &settings, Some(0))
                .unwrap();
        let end = planned_used_percent(&window, 2 * DAY_SECONDS, &settings, Some(0)).unwrap();
        assert_eq!(start, 20.0);
        assert_eq!(midpoint, 20.0);
        assert_eq!(end, 20.0);
    }

    #[test]
    fn non_weekly_windows_use_elapsed_percent_as_the_plan() {
        let window = UsageWindow {
            window_duration_mins: Some(300),
            resets_at: Some(5 * 60 * 60),
            ..weekly_window(20, 0)
        };
        let planned =
            planned_used_percent(&window, 2 * 60 * 60, &PaceSettings::default(), None).unwrap();
        assert_eq!(planned, 40.0);
    }

    #[test]
    fn alerts_require_two_confirmations_and_are_deduplicated() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let window = weekly_window(60, resets_at);
        let usage = usage(window, as_of);
        let view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut runtime = PaceRuntime::default();

        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let mut too_soon = usage.clone();
        too_soon.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS - 1);
        assert!(advance_alerts(&mut runtime, &too_soon, &view, true).is_empty());
        let mut confirmed_usage = usage.clone();
        confirmed_usage.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        assert_eq!(
            advance_alerts(&mut runtime, &confirmed_usage, &view, true).len(),
            1
        );
        assert!(advance_alerts(&mut runtime, &confirmed_usage, &view, true).is_empty());
        assert!(runtime.history.alerts[0].plan_notified);
        assert!(runtime.history.alerts[0].exhaustion_notified);
    }

    #[test]
    fn safe_observation_cancels_pending_alert_confirmation() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let usage = usage(weekly_window(60, resets_at), as_of);
        let risk_view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut safe_view = risk_view.clone();
        safe_view.windows[0].status = PaceStatus::Safe;
        safe_view.windows[0].plan_delta_percent_points = Some(0.0);
        safe_view.windows[0].projected_exhaustion_at = None;
        let mut runtime = PaceRuntime::default();

        assert!(advance_alerts(&mut runtime, &usage, &risk_view, true).is_empty());
        let mut safe_usage = usage.clone();
        safe_usage.fetched_at = Some(as_of + 30);
        assert!(advance_alerts(&mut runtime, &safe_usage, &safe_view, true).is_empty());
        let mut risk_again = usage.clone();
        risk_again.fetched_at = Some(as_of + 60);
        assert!(advance_alerts(&mut runtime, &risk_again, &risk_view, true).is_empty());
        risk_again.fetched_at = Some(as_of + 120);
        assert_eq!(
            advance_alerts(&mut runtime, &risk_again, &risk_view, true).len(),
            1
        );
    }

    #[test]
    fn a_new_window_generation_restarts_alert_confirmation() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let usage = usage(weekly_window(60, resets_at), as_of);
        let view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut runtime = PaceRuntime::default();

        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let mut new_generation = usage.clone();
        new_generation.windows[0].resets_at = Some(resets_at + WINDOW_RESET_TOLERANCE_SECONDS + 1);
        new_generation.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        assert!(advance_alerts(&mut runtime, &new_generation, &view, true).is_empty());
        new_generation.fetched_at = Some(as_of + 2 * ALERT_CONFIRMATION_INTERVAL_SECONDS);
        assert_eq!(
            advance_alerts(&mut runtime, &new_generation, &view, true).len(),
            1
        );
    }

    #[test]
    fn notification_toggle_and_plan_changes_reset_only_the_intended_pending_state() {
        let previous = PaceSettings {
            os_notifications_enabled: true,
            ..PaceSettings::default()
        };
        let mut runtime = PaceRuntime::default();
        runtime.alert_confirmations.insert(
            "codex:weekly".to_string(),
            AlertConfirmationState {
                representative_resets_at: 1_000,
                plan_pending_since: Some(100),
                exhaustion_pending_since: Some(100),
            },
        );
        let mut changed_plan = previous.clone();
        changed_plan.weekday_weights[0] = 6;
        reset_confirmations_for_settings_change(&mut runtime, &previous, &changed_plan);
        let confirmation = &runtime.alert_confirmations["codex:weekly"];
        assert_eq!(confirmation.plan_pending_since, None);
        assert_eq!(confirmation.exhaustion_pending_since, Some(100));

        let mut notifications_disabled = changed_plan.clone();
        notifications_disabled.os_notifications_enabled = false;
        reset_confirmations_for_settings_change(
            &mut runtime,
            &changed_plan,
            &notifications_disabled,
        );
        assert!(runtime.alert_confirmations.is_empty());
    }

    #[test]
    fn early_estimates_suppress_exhaustion_notifications() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 5 * 60;
        let usage = usage(weekly_window(1, resets_at), as_of);
        let view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut runtime = PaceRuntime::default();

        assert!(view.windows[0].early_estimate);
        assert_eq!(view.windows[0].status, PaceStatus::ExhaustionRisk);
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let mut later_usage = usage.clone();
        later_usage.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        assert!(advance_alerts(&mut runtime, &later_usage, &view, true).is_empty());
        assert!(!runtime.history.alerts[0].exhaustion_notified);
    }

    #[test]
    fn exhaustion_can_notify_once_after_an_existing_plan_warning() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let usage = usage(weekly_window(60, resets_at), as_of);
        let mut view = calculate_state(&usage, &PaceSettings::default(), &[]);
        view.windows[0].status = PaceStatus::PlanExceeded;
        view.windows[0].early_estimate = false;
        view.windows[0].projected_exhaustion_at = None;
        let mut runtime = PaceRuntime::default();

        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let mut later_usage = usage.clone();
        later_usage.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        let plan = advance_alerts(&mut runtime, &later_usage, &view, true);
        assert_eq!(plan.len(), 1);
        assert!(plan[0].title.contains("사용 계획 초과"));

        view.windows[0].status = PaceStatus::ExhaustionRisk;
        view.windows[0].projected_exhaustion_at = Some(resets_at - 60);
        later_usage.fetched_at = Some(as_of + 2 * ALERT_CONFIRMATION_INTERVAL_SECONDS);
        assert!(advance_alerts(&mut runtime, &later_usage, &view, true).is_empty());
        later_usage.fetched_at = Some(as_of + 3 * ALERT_CONFIRMATION_INTERVAL_SECONDS);
        let exhaustion = advance_alerts(&mut runtime, &later_usage, &view, true);
        assert_eq!(exhaustion.len(), 1);
        assert!(exhaustion[0].title.contains("초기화 전 소진 예상"));
        assert!(exhaustion[0]
            .body
            .contains("초기화보다 약 1분 먼저 소진 예상"));
        assert!(advance_alerts(&mut runtime, &later_usage, &view, true).is_empty());
    }

    #[test]
    fn notification_lead_duration_uses_readable_units() {
        assert_eq!(format_lead_duration(0, Language::Ko), "0분");
        assert_eq!(format_lead_duration(59, Language::Ko), "59분");
        assert_eq!(format_lead_duration(60, Language::Ko), "1시간");
        assert_eq!(format_lead_duration(90, Language::Ko), "1시간 30분");
        assert_eq!(format_lead_duration(24 * 60, Language::Ko), "1일");
        assert_eq!(format_lead_duration(25 * 60, Language::Ko), "1일 1시간");
        assert_eq!(
            format_lead_duration(25 * 60 + 30, Language::Ko),
            "1일 1시간"
        );
        assert_eq!(format_lead_duration(90, Language::En), "1h 30m");
    }

    #[test]
    fn notifications_use_the_selected_english_language() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let usage = usage(weekly_window(60, resets_at), as_of);
        let mut view = calculate_state(&usage, &PaceSettings::default(), &[]);
        view.windows[0].status = PaceStatus::PlanExceeded;
        view.windows[0].early_estimate = false;
        view.windows[0].projected_exhaustion_at = None;
        let mut runtime = PaceRuntime::default();

        assert!(
            advance_alerts_with_language(&mut runtime, &usage, &view, true, Language::En,)
                .is_empty()
        );
        let mut confirmed = usage.clone();
        confirmed.fetched_at = Some(as_of + ALERT_CONFIRMATION_INTERVAL_SECONDS);
        let notifications =
            advance_alerts_with_language(&mut runtime, &confirmed, &view, true, Language::En);

        assert_eq!(notifications.len(), 1);
        assert!(notifications[0].title.contains("usage is ahead of plan"));
        assert!(notifications[0].body.contains("ahead of the current plan"));
    }

    #[test]
    fn stale_state_does_not_advance_or_emit_alerts() {
        let resets_at = 7 * DAY_SECONDS;
        let as_of = 3 * DAY_SECONDS;
        let mut usage = usage(weekly_window(60, resets_at), as_of);
        usage.connection = ConnectionState::Stale;
        let view = calculate_state(&usage, &PaceSettings::default(), &[]);
        let mut runtime = PaceRuntime::default();

        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        assert!(runtime.alert_confirmations.is_empty());
    }
}
