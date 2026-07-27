use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlaySize {
    Small,
    #[default]
    Middle,
    Large,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PacePlanMode {
    #[default]
    Even,
    Weekday,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceSettings {
    #[serde(default)]
    pub plan_mode: PacePlanMode,
    #[serde(default = "default_weekday_allocations")]
    pub weekday_allocations: [f64; 7],
    #[serde(default)]
    pub os_notifications_enabled: bool,
}

impl Default for PaceSettings {
    fn default() -> Self {
        Self {
            plan_mode: PacePlanMode::Even,
            weekday_allocations: default_weekday_allocations(),
            os_notifications_enabled: false,
        }
    }
}

impl PaceSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .weekday_allocations
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(value))
        {
            return Err("요일별 배분율은 0~100 사이여야 합니다.".to_string());
        }
        let total = self.weekday_allocations.iter().sum::<f64>();
        if (total - 100.0).abs() > 0.1 {
            return Err(format!(
                "요일별 배분율 합계는 100%여야 합니다. 현재 합계: {total:.1}%"
            ));
        }
        Ok(())
    }
}

fn default_weekday_allocations() -> [f64; 7] {
    [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2]
}

impl OverlaySize {
    pub fn base_dimensions(self) -> (f64, f64) {
        match self {
            Self::Small => (152.0, 56.0),
            Self::Middle => (280.0, 72.0),
            Self::Large => (360.0, 240.0),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub codex_executable: Option<String>,
    pub window_position: Option<StoredPosition>,
    #[serde(default)]
    pub overlay_size: OverlaySize,
    #[serde(default)]
    pub pace: PaceSettings,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct StoredPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    value: Arc<Mutex<AppSettings>>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default();
        Self {
            path,
            value: Arc::new(Mutex::new(value)),
        }
    }

    pub fn codex_executable(&self) -> Option<PathBuf> {
        self.value
            .lock()
            .ok()
            .and_then(|value| value.codex_executable.as_ref().map(PathBuf::from))
    }

    pub fn set_codex_executable(&self, path: Option<PathBuf>) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "설정을 잠글 수 없습니다.".to_string())?;
        value.codex_executable = path.map(|path| path.to_string_lossy().into_owned());
        self.save_locked(&value)
    }

    pub fn window_position(&self) -> Option<StoredPosition> {
        self.value
            .lock()
            .ok()
            .and_then(|value| value.window_position)
    }

    pub fn set_window_position(&self, position: StoredPosition) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "설정을 잠글 수 없습니다.".to_string())?;
        value.window_position = Some(position);
        self.save_locked(&value)
    }

    pub fn overlay_size(&self) -> OverlaySize {
        self.value
            .lock()
            .map(|value| value.overlay_size)
            .unwrap_or_default()
    }

    pub fn set_overlay_size(&self, size: OverlaySize) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "설정을 잠글 수 없습니다.".to_string())?;
        value.overlay_size = size;
        self.save_locked(&value)
    }

    pub fn pace_settings(&self) -> PaceSettings {
        self.value
            .lock()
            .map(|value| value.pace.clone())
            .unwrap_or_default()
    }

    pub fn set_pace_settings(&self, settings: PaceSettings) -> Result<(), String> {
        settings.validate()?;
        let mut value = self
            .value
            .lock()
            .map_err(|_| "설정을 잠글 수 없습니다.".to_string())?;
        value.pace = settings;
        self.save_locked(&value)
    }

    fn save_locked(&self, value: &AppSettings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("설정 폴더를 만들 수 없습니다: {error}"))?;
        }
        let contents = serde_json::to_string_pretty(value)
            .map_err(|error| format!("설정을 직렬화할 수 없습니다: {error}"))?;
        fs::write(&self.path, contents)
            .map_err(|error| format!("설정을 저장할 수 없습니다: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, OverlaySize, PacePlanMode, PaceSettings};

    #[test]
    fn existing_settings_default_to_middle_overlay() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"codexExecutable":"codex","windowPosition":{"x":10,"y":20}}"#)
                .unwrap();

        assert_eq!(settings.overlay_size, OverlaySize::Middle);
        assert_eq!(settings.codex_executable.as_deref(), Some("codex"));
        assert_eq!(settings.pace.plan_mode, PacePlanMode::Even);
        assert!(!settings.pace.os_notifications_enabled);
    }

    #[test]
    fn overlay_size_uses_stable_lowercase_values() {
        let settings: AppSettings = serde_json::from_str(r#"{"overlaySize":"large"}"#).unwrap();

        assert_eq!(settings.overlay_size, OverlaySize::Large);
        assert_eq!(settings.overlay_size.base_dimensions(), (360.0, 240.0));
        assert!(serde_json::to_string(&settings)
            .unwrap()
            .contains(r#""overlaySize":"large""#));
    }

    #[test]
    fn pace_settings_require_a_complete_weekday_allocation() {
        let invalid = PaceSettings {
            plan_mode: PacePlanMode::Weekday,
            weekday_allocations: [10.0; 7],
            os_notifications_enabled: true,
        };
        assert!(invalid.validate().unwrap_err().contains("100%"));

        let valid = PaceSettings {
            weekday_allocations: [10.0, 10.0, 20.0, 10.0, 20.0, 20.0, 10.0],
            ..invalid
        };
        assert!(valid.validate().is_ok());
    }
}
