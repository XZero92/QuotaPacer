use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub codex_executable: Option<String>,
    pub window_position: Option<StoredPosition>,
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
