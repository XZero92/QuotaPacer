use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const DEFAULT_OVERLAY_OPACITY: u8 = 100;
pub const MIN_OVERLAY_OPACITY: u8 = 40;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LargePlanVisualization {
    #[default]
    Deviation,
    WeeklyAllocation,
}

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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableSettings {
    pub pace_settings: PaceSettings,
    pub overlay_opacity: u8,
    pub large_plan_visualization: LargePlanVisualization,
}

impl EditableSettings {
    pub fn validate(&self) -> Result<(), String> {
        self.pace_settings.validate()?;
        validate_overlay_opacity(self.overlay_opacity)
    }
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub codex_executable: Option<String>,
    pub window_position: Option<StoredPosition>,
    #[serde(default)]
    pub overlay_size: OverlaySize,
    #[serde(default = "default_overlay_opacity")]
    pub overlay_opacity: u8,
    #[serde(default)]
    pub large_plan_visualization: LargePlanVisualization,
    #[serde(default)]
    pub pace: PaceSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_executable: None,
            window_position: None,
            overlay_size: OverlaySize::default(),
            overlay_opacity: DEFAULT_OVERLAY_OPACITY,
            large_plan_visualization: LargePlanVisualization::default(),
            pace: PaceSettings::default(),
        }
    }
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
        let mut value: AppSettings = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default();
        value.overlay_opacity = normalize_overlay_opacity(value.overlay_opacity);
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

    pub fn editable_settings(&self) -> EditableSettings {
        self.value
            .lock()
            .map(|value| EditableSettings {
                pace_settings: value.pace.clone(),
                overlay_opacity: value.overlay_opacity,
                large_plan_visualization: value.large_plan_visualization,
            })
            .unwrap_or_else(|_| EditableSettings {
                pace_settings: PaceSettings::default(),
                overlay_opacity: DEFAULT_OVERLAY_OPACITY,
                large_plan_visualization: LargePlanVisualization::default(),
            })
    }

    pub fn set_editable_settings(
        &self,
        settings: EditableSettings,
    ) -> Result<EditableSettings, String> {
        settings.validate()?;
        let mut value = self
            .value
            .lock()
            .map_err(|_| "설정을 잠글 수 없습니다.".to_string())?;
        let mut next = value.clone();
        next.pace = settings.pace_settings.clone();
        next.overlay_opacity = settings.overlay_opacity;
        next.large_plan_visualization = settings.large_plan_visualization;
        self.save_locked(&next)?;
        *value = next;
        Ok(settings)
    }

    pub fn pace_settings(&self) -> PaceSettings {
        self.value
            .lock()
            .map(|value| value.pace.clone())
            .unwrap_or_default()
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

const fn default_overlay_opacity() -> u8 {
    DEFAULT_OVERLAY_OPACITY
}

fn normalize_overlay_opacity(opacity: u8) -> u8 {
    opacity.clamp(MIN_OVERLAY_OPACITY, 100)
}

pub fn validate_overlay_opacity(opacity: u8) -> Result<(), String> {
    if (MIN_OVERLAY_OPACITY..=100).contains(&opacity) {
        Ok(())
    } else {
        Err(format!(
            "오버레이 투명도는 {MIN_OVERLAY_OPACITY}~100% 사이여야 합니다."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_overlay_opacity, validate_overlay_opacity, AppSettings, EditableSettings,
        LargePlanVisualization, OverlaySize, PacePlanMode, PaceSettings, SettingsStore,
        DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY,
    };
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[test]
    fn existing_settings_default_to_middle_overlay() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"codexExecutable":"codex","windowPosition":{"x":10,"y":20}}"#)
                .unwrap();

        assert_eq!(settings.overlay_size, OverlaySize::Middle);
        assert_eq!(settings.overlay_opacity, DEFAULT_OVERLAY_OPACITY);
        assert_eq!(settings.codex_executable.as_deref(), Some("codex"));
        assert_eq!(settings.pace.plan_mode, PacePlanMode::Even);
        assert_eq!(
            settings.large_plan_visualization,
            LargePlanVisualization::Deviation
        );
        assert!(!settings.pace.os_notifications_enabled);
    }

    #[test]
    fn custom_codex_executable_can_return_to_automatic_detection() {
        let path = unique_test_path("codex-executable-clear");
        let store = SettingsStore::load(path.clone());

        store
            .set_codex_executable(Some(PathBuf::from("custom-codex")))
            .unwrap();
        assert_eq!(
            store.codex_executable(),
            Some(PathBuf::from("custom-codex"))
        );

        store.set_codex_executable(None).unwrap();
        let saved: AppSettings =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(store.codex_executable(), None);
        assert_eq!(saved.codex_executable, None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn overlay_opacity_uses_a_readable_percentage_range() {
        let settings: AppSettings = serde_json::from_str(r#"{"overlayOpacity":65}"#).unwrap();

        assert_eq!(settings.overlay_opacity, 65);
        assert_eq!(MIN_OVERLAY_OPACITY, 40);
        assert_eq!(normalize_overlay_opacity(0), MIN_OVERLAY_OPACITY);
        assert_eq!(normalize_overlay_opacity(255), 100);
        assert!(validate_overlay_opacity(40).is_ok());
        assert!(validate_overlay_opacity(100).is_ok());
        assert!(validate_overlay_opacity(39).is_err());
        assert!(validate_overlay_opacity(101).is_err());
        assert!(serde_json::to_string(&settings)
            .unwrap()
            .contains(r#""overlayOpacity":65"#));
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
    fn large_plan_visualization_uses_stable_camel_case_values() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"largePlanVisualization":"weeklyAllocation"}"#).unwrap();

        assert_eq!(
            settings.large_plan_visualization,
            LargePlanVisualization::WeeklyAllocation
        );
        assert!(serde_json::to_string(&settings)
            .unwrap()
            .contains(r#""largePlanVisualization":"weeklyAllocation""#));
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

    #[test]
    fn editable_settings_merge_without_overwriting_external_fields() {
        let path = unique_test_path("editable-merge");
        let original = AppSettings {
            codex_executable: Some("custom-codex".to_string()),
            window_position: Some(super::StoredPosition { x: 42, y: 84 }),
            overlay_size: OverlaySize::Large,
            ..AppSettings::default()
        };
        let store = SettingsStore {
            path: path.clone(),
            value: Arc::new(Mutex::new(original)),
        };
        let editable = EditableSettings {
            pace_settings: PaceSettings {
                os_notifications_enabled: true,
                ..PaceSettings::default()
            },
            overlay_opacity: 65,
            large_plan_visualization: LargePlanVisualization::WeeklyAllocation,
        };

        store.set_editable_settings(editable.clone()).unwrap();
        let saved: AppSettings =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(store.editable_settings(), editable);
        assert_eq!(saved.codex_executable.as_deref(), Some("custom-codex"));
        assert_eq!(saved.window_position.unwrap().x, 42);
        assert_eq!(saved.overlay_size, OverlaySize::Large);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_editable_save_keeps_the_in_memory_settings() {
        let original = AppSettings::default();
        let store = SettingsStore {
            path: std::env::temp_dir(),
            value: Arc::new(Mutex::new(original)),
        };
        let changed = EditableSettings {
            pace_settings: PaceSettings {
                os_notifications_enabled: true,
                ..PaceSettings::default()
            },
            overlay_opacity: 65,
            large_plan_visualization: LargePlanVisualization::WeeklyAllocation,
        };

        assert!(store.set_editable_settings(changed).is_err());
        assert_eq!(
            store.editable_settings(),
            EditableSettings {
                pace_settings: PaceSettings::default(),
                overlay_opacity: DEFAULT_OVERLAY_OPACITY,
                large_plan_visualization: LargePlanVisualization::Deviation,
            }
        );
    }

    fn unique_test_path(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "quota-pacer-{label}-{}-{}.json",
            std::process::id(),
            nonce
        ))
    }
}
