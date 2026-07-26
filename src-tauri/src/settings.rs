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

impl OverlaySize {
    pub fn base_dimensions(self) -> (f64, f64) {
        match self {
            Self::Small => (152.0, 56.0),
            Self::Middle => (280.0, 72.0),
            Self::Large => (320.0, 152.0),
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
    use super::{AppSettings, OverlaySize};

    #[test]
    fn existing_settings_default_to_middle_overlay() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"codexExecutable":"codex","windowPosition":{"x":10,"y":20}}"#)
                .unwrap();

        assert_eq!(settings.overlay_size, OverlaySize::Middle);
        assert_eq!(settings.codex_executable.as_deref(), Some("codex"));
    }

    #[test]
    fn overlay_size_uses_stable_lowercase_values() {
        let settings: AppSettings = serde_json::from_str(r#"{"overlaySize":"large"}"#).unwrap();

        assert_eq!(settings.overlay_size, OverlaySize::Large);
        assert!(serde_json::to_string(&settings)
            .unwrap()
            .contains(r#""overlaySize":"large""#));
    }
}
