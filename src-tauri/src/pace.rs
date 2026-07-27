use crate::settings::{PacePlanMode, PaceSettings, SettingsStore};
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
const DAY_SECONDS: i64 = 24 * 60 * 60;
const WEEK_MINUTES: i64 = 7 * 24 * 60;
const PLAN_GRACE_PERCENT_POINTS: f64 = 1.0;
const REQUIRED_ALERT_CONFIRMATIONS: u8 = 2;

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

#[derive(Clone, Debug, Default)]
struct AlertStreak {
    plan: u8,
    exhaustion: u8,
}

#[derive(Default)]
struct PaceRuntime {
    history: PaceHistoryFile,
    view: PaceViewState,
    streaks: HashMap<String, AlertStreak>,
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
            history_changed |= record_samples(&mut runtime.history, usage, as_of);
            let view = calculate_state(usage, &settings, &runtime.history.samples);
            let notifications = advance_alerts(
                &mut runtime,
                usage,
                &view,
                settings.os_notifications_enabled,
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
        let view = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            let view = calculate_state(usage, &settings, &runtime.history.samples);
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
            runtime.streaks.clear();
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

fn record_samples(history: &mut PaceHistoryFile, usage: &UsageViewState, as_of: i64) -> bool {
    let mut changed = false;
    for window in &usage.windows {
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        let last_recorded = history
            .samples
            .iter()
            .filter(|sample| sample.window_id == window.id && sample.resets_at == resets_at)
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
            sample.window_id == window.id
                && sample.resets_at == resets_at
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
    Some(project_forecast(
        ForecastBasis::PeriodAverage,
        used_percent,
        used_percent / observed_seconds as f64,
        as_of,
        resets_at,
        observed_seconds,
        observed_seconds < confidence_threshold,
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
    if settings.plan_mode == PacePlanMode::Even {
        return Some(((segment + 1) as f64 * (100.0 / 7.0)).min(100.0));
    }
    let start_weekday = start_weekday_override.unwrap_or_else(|| local_weekday_index(starts_at));
    Some(
        (0..=segment)
            .map(|offset| settings.weekday_allocations[(start_weekday + offset) % 7])
            .sum::<f64>()
            .clamp(0.0, 100.0),
    )
}

fn local_weekday_index(timestamp: i64) -> usize {
    Local
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|datetime| datetime.weekday().num_days_from_monday() as usize)
        .unwrap_or(0)
}

fn advance_alerts(
    runtime: &mut PaceRuntime,
    usage: &UsageViewState,
    view: &PaceViewState,
    notifications_enabled: bool,
) -> Vec<NotificationRequest> {
    if usage.connection == ConnectionState::Stale {
        return Vec::new();
    }
    let mut notifications = Vec::new();
    for (window, pace) in usage.windows.iter().zip(&view.windows) {
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        let key = format!("{}:{resets_at}", window.id);
        let streak = runtime.streaks.entry(key).or_default();
        let plan_candidate = pace
            .plan_delta_percent_points
            .map(|delta| delta > PLAN_GRACE_PERCENT_POINTS)
            .unwrap_or(false);
        let exhaustion_candidate =
            pace.status == PaceStatus::ExhaustionRisk && !pace.early_estimate;
        streak.plan = next_streak(streak.plan, plan_candidate);
        streak.exhaustion = next_streak(streak.exhaustion, exhaustion_candidate);

        if !notifications_enabled {
            continue;
        }
        let alert_index = runtime
            .history
            .alerts
            .iter()
            .position(|alert| alert.window_id == window.id && alert.resets_at == resets_at)
            .unwrap_or_else(|| {
                runtime.history.alerts.push(AlertRecord {
                    window_id: window.id.clone(),
                    resets_at,
                    ..AlertRecord::default()
                });
                runtime.history.alerts.len() - 1
            });
        let alert = &mut runtime.history.alerts[alert_index];
        let notify_plan = streak.plan >= REQUIRED_ALERT_CONFIRMATIONS && !alert.plan_notified;
        let notify_exhaustion =
            streak.exhaustion >= REQUIRED_ALERT_CONFIRMATIONS && !alert.exhaustion_notified;
        if !notify_plan && !notify_exhaustion {
            continue;
        }

        let label = window_duration_label(window.window_duration_mins);
        let title = if notify_plan && notify_exhaustion {
            format!("QuotaPacer · {label} 계획·소진 경고")
        } else if notify_exhaustion {
            format!("QuotaPacer · {label} 초기화 전 소진 예상")
        } else {
            format!("QuotaPacer · {label} 사용 계획 초과")
        };
        let mut parts = Vec::new();
        if notify_plan {
            if let Some(delta) = pace.plan_delta_percent_points {
                parts.push(format!("현재 계획보다 {:.0}%p 초과", delta.max(0.0)));
            }
            alert.plan_notified = true;
        }
        if notify_exhaustion {
            if let Some(exhaustion_at) = pace.projected_exhaustion_at {
                let lead_minutes = ((resets_at - exhaustion_at).max(0) + 59) / 60;
                let lead = format_lead_duration(lead_minutes);
                parts.push(format!("초기화보다 약 {lead} 먼저 소진 예상"));
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

fn next_streak(current: u8, candidate: bool) -> u8 {
    if candidate {
        current.saturating_add(1)
    } else {
        0
    }
}

fn format_lead_duration(total_minutes: i64) -> String {
    let total_minutes = total_minutes.max(0);
    let days = total_minutes / (24 * 60);
    let hours = (total_minutes % (24 * 60)) / 60;
    let minutes = total_minutes % 60;

    if days > 0 {
        if hours > 0 {
            return format!("{days}일 {hours}시간");
        }
        if minutes > 0 {
            return format!("{days}일 {minutes}분");
        }
        return format!("{days}일");
    }
    if hours > 0 {
        if minutes > 0 {
            return format!("{hours}시간 {minutes}분");
        }
        return format!("{hours}시간");
    }
    format!("{minutes}분")
}

fn window_duration_label(duration_minutes: Option<i64>) -> String {
    let Some(minutes) = duration_minutes else {
        return "사용량".to_string();
    };
    if minutes == WEEK_MINUTES {
        return "주간".to_string();
    }
    if minutes % (24 * 60) == 0 {
        return format!("{}일", minutes / (24 * 60));
    }
    if minutes % 60 == 0 {
        return format!("{}시간", minutes / 60);
    }
    format!("{minutes}분")
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
                resets_at: resets_at - 1,
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
        let notifications = advance_alerts(&mut runtime, &usage, &view, true);
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
    fn even_weekly_plan_unlocks_one_daily_allocation_at_each_boundary() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let settings = PaceSettings::default();

        let first = planned_used_percent(&window, 0, &settings, Some(0)).unwrap();
        let third = planned_used_percent(&window, 2 * DAY_SECONDS, &settings, Some(0)).unwrap();
        assert!((first - 100.0 / 7.0).abs() < 0.001);
        assert!((third - 300.0 / 7.0).abs() < 0.001);
    }

    #[test]
    fn weekday_plan_uses_the_weekday_at_the_window_start() {
        let resets_at = 7 * DAY_SECONDS;
        let window = weekly_window(0, resets_at);
        let settings = PaceSettings {
            plan_mode: PacePlanMode::Weekday,
            weekday_allocations: [10.0, 10.0, 20.0, 10.0, 20.0, 20.0, 10.0],
            os_notifications_enabled: false,
        };

        let first = planned_used_percent(&window, 0, &settings, Some(2)).unwrap();
        let second = planned_used_percent(&window, DAY_SECONDS, &settings, Some(2)).unwrap();
        assert_eq!(first, 20.0);
        assert_eq!(second, 30.0);
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
        assert_eq!(advance_alerts(&mut runtime, &usage, &view, true).len(), 1);
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        assert!(runtime.history.alerts[0].plan_notified);
        assert!(runtime.history.alerts[0].exhaustion_notified);
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
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
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
        let plan = advance_alerts(&mut runtime, &usage, &view, true);
        assert_eq!(plan.len(), 1);
        assert!(plan[0].title.contains("사용 계획 초과"));

        view.windows[0].status = PaceStatus::ExhaustionRisk;
        view.windows[0].projected_exhaustion_at = Some(resets_at - 60);
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
        let exhaustion = advance_alerts(&mut runtime, &usage, &view, true);
        assert_eq!(exhaustion.len(), 1);
        assert!(exhaustion[0].title.contains("초기화 전 소진 예상"));
        assert!(exhaustion[0]
            .body
            .contains("초기화보다 약 1분 먼저 소진 예상"));
        assert!(advance_alerts(&mut runtime, &usage, &view, true).is_empty());
    }

    #[test]
    fn notification_lead_duration_uses_readable_units() {
        assert_eq!(format_lead_duration(0), "0분");
        assert_eq!(format_lead_duration(59), "59분");
        assert_eq!(format_lead_duration(60), "1시간");
        assert_eq!(format_lead_duration(90), "1시간 30분");
        assert_eq!(format_lead_duration(24 * 60), "1일");
        assert_eq!(format_lead_duration(25 * 60), "1일 1시간");
        assert_eq!(format_lead_duration(25 * 60 + 30), "1일 1시간");
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
        assert!(runtime.streaks.is_empty());
    }
}
