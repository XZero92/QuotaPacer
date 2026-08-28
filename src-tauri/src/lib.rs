mod codex;
mod pace;
mod settings;
mod usage;

use codex::{inspect_cli, CliInfo, UsageService};
use pace::{PaceService, PaceViewState};
use serde::{Deserialize, Serialize};
use settings::{
    validate_overlay_opacity, EditableSettings, Language, LargePlanVisualization,
    OverlayAppearanceSettings, OverlaySize, SettingsStore, StoredPosition,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, Submenu,
    SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use usage::{is_luna_reserve, is_luna_reserve_active, UsageViewState, UsageWindow};

struct AppState {
    usage: UsageService,
    pace: PaceService,
    settings: SettingsStore,
    appearance_preview: Mutex<OverlayAppearancePreviewController>,
    exiting: AtomicBool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OverlayAppearancePhase {
    Preview,
    Committed,
    Reverted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayAppearance {
    overlay_opacity: u8,
    large_plan_visualization: LargePlanVisualization,
}

impl From<OverlayAppearanceSettings> for OverlayAppearance {
    fn from(settings: OverlayAppearanceSettings) -> Self {
        Self {
            overlay_opacity: settings.overlay_opacity,
            large_plan_visualization: settings.large_plan_visualization,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayAppearanceUpdate {
    appearance: OverlayAppearance,
    phase: OverlayAppearancePhase,
    update_id: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSession {
    session_id: u64,
    settings: EditableSettings,
    launch_at_login: bool,
}

#[derive(Clone, Copy, Debug)]
struct ActiveAppearancePreview {
    session_id: u64,
    latest_revision: u64,
    latest_language_revision: u64,
    appearance: OverlayAppearance,
    has_preview: bool,
}

#[derive(Debug, Default)]
struct OverlayAppearancePreviewController {
    latest_session_id: u64,
    latest_update_id: u64,
    active: Option<ActiveAppearancePreview>,
}

impl OverlayAppearancePreviewController {
    fn begin(
        &mut self,
        persisted_appearance: OverlayAppearance,
    ) -> (u64, Option<OverlayAppearanceUpdate>) {
        let should_revert = self
            .active
            .take()
            .map(|active| active.has_preview)
            .unwrap_or(false);
        let reverted = should_revert
            .then(|| self.next_update(persisted_appearance, OverlayAppearancePhase::Reverted));
        let session_id = self.next_session_id();
        self.active = Some(ActiveAppearancePreview {
            session_id,
            latest_revision: 0,
            latest_language_revision: 0,
            appearance: persisted_appearance,
            has_preview: false,
        });
        (session_id, reverted)
    }

    fn preview(
        &mut self,
        session_id: u64,
        revision: u64,
        overlay_opacity: u8,
    ) -> Option<OverlayAppearanceUpdate> {
        let appearance = {
            let accepted = self.active.as_mut().filter(|active| {
                active.session_id == session_id && revision > active.latest_revision
            });
            let active = accepted?;
            active.latest_revision = revision;
            active.appearance.overlay_opacity = overlay_opacity;
            active.has_preview = true;
            active.appearance
        };
        Some(self.next_update(appearance, OverlayAppearancePhase::Preview))
    }

    fn preview_language(&mut self, session_id: u64, revision: u64) -> bool {
        let Some(active) = self.active.as_mut().filter(|active| {
            active.session_id == session_id && revision > active.latest_language_revision
        }) else {
            return false;
        };
        active.latest_language_revision = revision;
        true
    }

    fn commit_visualization(
        &mut self,
        persisted_appearance: OverlayAppearance,
    ) -> OverlayAppearanceUpdate {
        let (appearance, phase) = if let Some(active) = self.active.as_mut() {
            active.appearance.large_plan_visualization =
                persisted_appearance.large_plan_visualization;
            if active.has_preview {
                (active.appearance, OverlayAppearancePhase::Preview)
            } else {
                active.appearance = persisted_appearance;
                (persisted_appearance, OverlayAppearancePhase::Committed)
            }
        } else {
            (persisted_appearance, OverlayAppearancePhase::Committed)
        };
        self.next_update(appearance, phase)
    }

    fn cancel(
        &mut self,
        session_id: u64,
        persisted_appearance: OverlayAppearance,
    ) -> Option<OverlayAppearanceUpdate> {
        let active = self
            .active
            .filter(|active| active.session_id == session_id)?;
        self.active = None;
        active
            .has_preview
            .then(|| self.next_update(persisted_appearance, OverlayAppearancePhase::Reverted))
    }

    fn is_active(&self, session_id: u64) -> bool {
        self.active
            .map(|active| active.session_id == session_id)
            .unwrap_or(false)
    }

    fn commit_and_restart(
        &mut self,
        session_id: u64,
        appearance: OverlayAppearance,
    ) -> Option<(u64, OverlayAppearanceUpdate)> {
        if !self.is_active(session_id) {
            return None;
        }
        self.active = None;
        let update = self.next_update(appearance, OverlayAppearancePhase::Committed);
        let next_session_id = self.next_session_id();
        self.active = Some(ActiveAppearancePreview {
            session_id: next_session_id,
            latest_revision: 0,
            latest_language_revision: 0,
            appearance,
            has_preview: false,
        });
        Some((next_session_id, update))
    }

    fn effective(&self, persisted_appearance: OverlayAppearance) -> OverlayAppearanceUpdate {
        if let Some(active) = self.active.filter(|active| active.has_preview) {
            OverlayAppearanceUpdate {
                appearance: active.appearance,
                phase: OverlayAppearancePhase::Preview,
                update_id: self.latest_update_id,
            }
        } else {
            OverlayAppearanceUpdate {
                appearance: persisted_appearance,
                phase: OverlayAppearancePhase::Committed,
                update_id: self.latest_update_id,
            }
        }
    }

    fn next_session_id(&mut self) -> u64 {
        self.latest_session_id = self.latest_session_id.wrapping_add(1).max(1);
        self.latest_session_id
    }

    fn next_update(
        &mut self,
        appearance: OverlayAppearance,
        phase: OverlayAppearancePhase,
    ) -> OverlayAppearanceUpdate {
        self.latest_update_id = self.latest_update_id.wrapping_add(1).max(1);
        OverlayAppearanceUpdate {
            appearance,
            phase,
            update_id: self.latest_update_id,
        }
    }
}

#[derive(Clone)]
struct SizeMenuItems {
    submenu: Submenu<Wry>,
    small: CheckMenuItem<Wry>,
    middle: CheckMenuItem<Wry>,
    large: CheckMenuItem<Wry>,
}

impl SizeMenuItems {
    fn sync(&self, selected: OverlaySize) -> tauri::Result<()> {
        self.small.set_checked(selected == OverlaySize::Small)?;
        self.middle.set_checked(selected == OverlaySize::Middle)?;
        self.large.set_checked(selected == OverlaySize::Large)?;
        Ok(())
    }

    fn sync_language(&self, language: Language) -> tauri::Result<()> {
        self.submenu
            .set_text(menu_text(language, "오버레이 크기", "Overlay size"))?;
        self.small.set_text(menu_text(language, "작게", "Small"))?;
        self.middle
            .set_text(menu_text(language, "보통", "Medium"))?;
        self.large.set_text(menu_text(language, "크게", "Large"))?;
        Ok(())
    }
}

struct OverlayMenus {
    context: Menu<Wry>,
    tray_sizes: SizeMenuItems,
    context_sizes: SizeMenuItems,
    tray_toggle: MenuItem<Wry>,
    tray_refresh: MenuItem<Wry>,
    tray_settings: MenuItem<Wry>,
    tray_quit: MenuItem<Wry>,
    context_refresh: MenuItem<Wry>,
    context_settings: MenuItem<Wry>,
    context_hide: MenuItem<Wry>,
    context_quit: MenuItem<Wry>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
struct OverlayMenuPosition {
    x: f64,
    y: f64,
}

fn validated_overlay_menu_position(
    position: Option<OverlayMenuPosition>,
) -> Option<LogicalPosition<f64>> {
    position
        .filter(|position| {
            position.x.is_finite()
                && position.y.is_finite()
                && position.x >= 0.0
                && position.y >= 0.0
        })
        .map(|position| LogicalPosition::new(position.x, position.y))
}

impl OverlayMenus {
    fn sync(&self, selected: OverlaySize) -> tauri::Result<()> {
        self.tray_sizes.sync(selected)?;
        self.context_sizes.sync(selected)
    }

    fn sync_language(&self, language: Language) -> tauri::Result<()> {
        self.tray_sizes.sync_language(language)?;
        self.context_sizes.sync_language(language)?;
        self.tray_toggle
            .set_text(menu_text(language, "표시/숨기기", "Show/Hide"))?;
        self.tray_refresh
            .set_text(menu_text(language, "새로고침", "Refresh"))?;
        self.tray_settings
            .set_text(menu_text(language, "설정", "Settings"))?;
        self.tray_quit
            .set_text(menu_text(language, "종료", "Quit"))?;
        self.context_refresh
            .set_text(menu_text(language, "새로고침", "Refresh"))?;
        self.context_settings
            .set_text(menu_text(language, "설정…", "Settings…"))?;
        self.context_hide
            .set_text(menu_text(language, "오버레이 숨기기", "Hide overlay"))?;
        self.context_quit
            .set_text(menu_text(language, "QuotaPacer 종료", "Quit QuotaPacer"))?;
        Ok(())
    }
}

fn menu_text(language: Language, korean: &'static str, english: &'static str) -> &'static str {
    match language {
        Language::Ko => korean,
        Language::En => english,
    }
}

#[tauri::command]
fn get_usage_state(state: State<'_, AppState>) -> UsageViewState {
    state.usage.state()
}

#[tauri::command]
fn get_pace_state(state: State<'_, AppState>) -> PaceViewState {
    state.pace.state()
}

#[tauri::command]
fn get_language(state: State<'_, AppState>) -> Language {
    state.settings.language()
}

#[tauri::command]
fn clear_pace_history(state: State<'_, AppState>) -> Result<(), String> {
    state.pace.clear_history(&state.usage.state())
}

#[tauri::command]
fn show_pace_settings(app: tauri::AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn refresh_usage(state: State<'_, AppState>) {
    state.usage.refresh();
}

#[tauri::command]
fn set_codex_executable(path: String, state: State<'_, AppState>) -> Result<CliInfo, String> {
    let explicit_path = PathBuf::from(path);
    let cli = inspect_cli(Some(explicit_path.clone()))?;
    state.settings.set_codex_executable(Some(explicit_path))?;
    state.usage.executable_changed();
    Ok(cli)
}

#[tauri::command]
fn get_codex_executable_preference(state: State<'_, AppState>) -> Option<String> {
    state
        .settings
        .codex_executable()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn clear_codex_executable(state: State<'_, AppState>) -> Result<(), String> {
    state.settings.set_codex_executable(None)?;
    state.usage.executable_changed();
    Ok(())
}

#[tauri::command]
fn get_overlay_size(state: State<'_, AppState>) -> OverlaySize {
    state.settings.overlay_size()
}

#[tauri::command]
fn begin_settings_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsSession, String> {
    let settings = state.settings.editable_settings();
    let launch_at_login = launch_at_login_state(&app)?;
    let persisted_appearance = OverlayAppearance::from(state.settings.overlay_appearance());
    let (session_id, reverted) = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .begin(persisted_appearance);
    if let Some(update) = reverted {
        emit_appearance_update(&app, update);
    }
    emit_language_update(&app, settings.language);
    Ok(SettingsSession {
        session_id,
        settings,
        launch_at_login,
    })
}

fn launch_at_login_state(app: &tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("자동 시작 상태를 확인할 수 없습니다: {error}"))
}

fn apply_launch_at_login_change<Enable, Disable>(
    current: bool,
    desired: bool,
    enable: Enable,
    disable: Disable,
) -> Result<bool, String>
where
    Enable: FnOnce() -> Result<(), String>,
    Disable: FnOnce() -> Result<(), String>,
{
    if current == desired {
        return Ok(false);
    }
    if desired {
        enable()?;
    } else {
        disable()?;
    }
    Ok(true)
}

fn update_launch_at_login(
    app: &tauri::AppHandle,
    current: bool,
    desired: bool,
) -> Result<bool, String> {
    let manager = app.autolaunch();
    apply_launch_at_login_change(
        current,
        desired,
        || {
            manager
                .enable()
                .map_err(|error| format!("자동 시작을 등록할 수 없습니다: {error}"))
        },
        || {
            manager
                .disable()
                .map_err(|error| format!("자동 시작 등록을 해제할 수 없습니다: {error}"))
        },
    )
}

#[tauri::command]
fn preview_overlay_opacity(
    session_id: u64,
    revision: u64,
    overlay_opacity: u8,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OverlayAppearanceUpdate>, String> {
    validate_overlay_opacity(overlay_opacity)?;
    let update = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .preview(session_id, revision, overlay_opacity);
    if let Some(update) = update {
        emit_appearance_update(&app, update);
    }
    Ok(update)
}

#[tauri::command]
fn preview_language(
    session_id: u64,
    revision: u64,
    language: Language,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let accepted = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .preview_language(session_id, revision);
    if accepted {
        emit_language_update(&app, language);
    }
    Ok(accepted)
}

#[tauri::command]
fn set_large_plan_visualization(
    large_plan_visualization: LargePlanVisualization,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OverlayAppearanceUpdate, String> {
    let mut preview = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    let persisted_appearance = OverlayAppearance::from(
        state
            .settings
            .set_large_plan_visualization(large_plan_visualization)?,
    );
    let update = preview.commit_visualization(persisted_appearance);
    drop(preview);
    emit_appearance_update(&app, update);
    Ok(update)
}

#[tauri::command]
fn save_editable_settings(
    session_id: u64,
    settings: EditableSettings,
    launch_at_login: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    menus: State<'_, OverlayMenus>,
) -> Result<SettingsSession, String> {
    let mut preview = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    if !preview.is_active(session_id) {
        return Err("설정 세션이 만료되었습니다. 설정 창을 다시 열어주세요.".to_string());
    }
    settings.validate()?;
    let previous_pace_settings = state.settings.pace_settings();
    let previous_language = state.settings.language();
    let previous_launch_at_login = launch_at_login_state(&app)?;
    let launch_at_login_changed =
        update_launch_at_login(&app, previous_launch_at_login, launch_at_login)?;
    let applied_launch_at_login = match launch_at_login_state(&app) {
        Ok(applied) if applied == launch_at_login => applied,
        Ok(applied) => {
            let rollback = launch_at_login_changed
                .then(|| update_launch_at_login(&app, applied, previous_launch_at_login));
            return match rollback {
                Some(Err(rollback_error)) => Err(format!(
                    "자동 시작 상태가 요청한 값으로 적용되지 않았고 복원에도 실패했습니다: {rollback_error}"
                )),
                _ => Err("자동 시작 상태가 요청한 값으로 적용되지 않았습니다.".to_string()),
            };
        }
        Err(read_error) => {
            let rollback = launch_at_login_changed
                .then(|| update_launch_at_login(&app, launch_at_login, previous_launch_at_login));
            return match rollback {
                Some(Err(rollback_error)) => Err(format!(
                    "{read_error} 이전 자동 시작 상태도 복원하지 못했습니다: {rollback_error}"
                )),
                _ => Err(read_error),
            };
        }
    };
    let saved = match state.settings.set_editable_settings(settings) {
        Ok(saved) => saved,
        Err(save_error) => {
            if launch_at_login_changed {
                if let Err(rollback_error) =
                    update_launch_at_login(&app, launch_at_login, previous_launch_at_login)
                {
                    return Err(format!(
                        "{save_error} 자동 시작 상태도 복원하지 못했습니다: {rollback_error}"
                    ));
                }
            }
            return Err(save_error);
        }
    };
    let saved_appearance = OverlayAppearance::from(state.settings.overlay_appearance());
    let (next_session_id, update) = preview
        .commit_and_restart(session_id, saved_appearance)
        .ok_or_else(|| "설정 세션이 만료되었습니다. 설정 창을 다시 열어주세요.".to_string())?;
    drop(preview);
    state.pace.settings_changed(
        &previous_pace_settings,
        &saved.pace_settings,
        &state.usage.state(),
    );
    emit_appearance_update(&app, update);
    if previous_language != saved.language {
        menus
            .sync_language(saved.language)
            .map_err(|error| error.to_string())?;
    }
    emit_language_update(&app, saved.language);
    Ok(SettingsSession {
        session_id: next_session_id,
        settings: saved,
        launch_at_login: applied_launch_at_login,
    })
}

#[tauri::command]
fn cancel_settings_session(
    session_id: u64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let persisted_appearance = OverlayAppearance::from(state.settings.overlay_appearance());
    let persisted_language = state.settings.language();
    let mut preview = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    if !preview.is_active(session_id) {
        return Ok(());
    }
    let update = preview.cancel(session_id, persisted_appearance);
    drop(preview);
    if let Some(update) = update {
        emit_appearance_update(&app, update);
    }
    emit_language_update(&app, persisted_language);
    Ok(())
}

#[tauri::command]
fn get_effective_overlay_appearance(
    state: State<'_, AppState>,
) -> Result<OverlayAppearanceUpdate, String> {
    let persisted_appearance = OverlayAppearance::from(state.settings.overlay_appearance());
    let preview = state
        .appearance_preview
        .lock()
        .map_err(|_| "오버레이 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    Ok(preview.effective(persisted_appearance))
}

fn emit_appearance_update(app: &tauri::AppHandle, update: OverlayAppearanceUpdate) {
    let _ = app.emit_to("main", "ui://overlay-appearance-updated", update);
}

fn emit_language_update(app: &tauri::AppHandle, language: Language) {
    let _ = app.emit_to("main", "ui://language-changed", language);
}

#[tauri::command]
fn show_overlay_context_menu(
    window: WebviewWindow,
    menus: State<'_, OverlayMenus>,
    position: Option<OverlayMenuPosition>,
) -> Result<(), String> {
    let window = window.as_ref().window();
    match validated_overlay_menu_position(position) {
        Some(position) => window.popup_menu_at(&menus.context, position),
        None => window.popup_menu(&menus.context),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_overlay_layout(
    size: OverlaySize,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let usage = state.usage.state();
    resize_overlay_window(&window, size, &usage.windows)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                show_main_window(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config_path = config_dir.join("settings.json");
            let settings = SettingsStore::load(config_path);
            let pace = PaceService::new(
                app.handle().clone(),
                settings.clone(),
                config_dir.join("pace-history.json"),
            );
            let usage = UsageService::start(app.handle().clone(), settings.clone(), pace.clone());
            app.manage(AppState {
                usage,
                pace,
                settings: settings.clone(),
                appearance_preview: Mutex::new(OverlayAppearancePreviewController::default()),
                exiting: AtomicBool::new(false),
            });

            let menus = setup_menus(app, settings.overlay_size(), settings.language())?;
            app.manage(menus);
            if let Some(window) = app.get_webview_window("main") {
                let (width, height) = overlay_dimensions(settings.overlay_size(), &[]);
                window.set_size(LogicalSize::new(width, height))?;
                position_window(&window, &settings);
                install_window_handlers(&window);
                window.show()?;
            }
            if let Some(window) = app.get_webview_window("settings") {
                install_settings_window_handlers(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_usage_state,
            get_pace_state,
            get_language,
            clear_pace_history,
            show_pace_settings,
            refresh_usage,
            set_codex_executable,
            get_codex_executable_preference,
            clear_codex_executable,
            get_overlay_size,
            begin_settings_session,
            preview_overlay_opacity,
            preview_language,
            set_large_plan_visualization,
            save_editable_settings,
            cancel_settings_session,
            get_effective_overlay_appearance,
            show_overlay_context_menu,
            set_overlay_layout
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuotaPacer");
}

fn build_size_submenu(
    app: &tauri::App,
    prefix: &str,
    selected: OverlaySize,
    language: Language,
) -> tauri::Result<(Submenu<Wry>, SizeMenuItems)> {
    let small = CheckMenuItemBuilder::with_id(
        format!("{prefix}-size-small"),
        menu_text(language, "작게", "Small"),
    )
    .checked(selected == OverlaySize::Small)
    .build(app)?;
    let middle = CheckMenuItemBuilder::with_id(
        format!("{prefix}-size-middle"),
        menu_text(language, "보통", "Medium"),
    )
    .checked(selected == OverlaySize::Middle)
    .build(app)?;
    let large = CheckMenuItemBuilder::with_id(
        format!("{prefix}-size-large"),
        menu_text(language, "크게", "Large"),
    )
    .checked(selected == OverlaySize::Large)
    .build(app)?;
    let submenu = SubmenuBuilder::new(app, menu_text(language, "오버레이 크기", "Overlay size"))
        .items(&[&small, &middle, &large])
        .build()?;

    Ok((
        submenu.clone(),
        SizeMenuItems {
            submenu,
            small,
            middle,
            large,
        },
    ))
}

fn setup_menus(
    app: &mut tauri::App,
    selected: OverlaySize,
    language: Language,
) -> tauri::Result<OverlayMenus> {
    let (tray_size_menu, tray_sizes) = build_size_submenu(app, "tray", selected, language)?;
    let tray_toggle = MenuItemBuilder::with_id(
        "tray-toggle",
        menu_text(language, "표시/숨기기", "Show/Hide"),
    )
    .build(app)?;
    let tray_refresh =
        MenuItemBuilder::with_id("tray-refresh", menu_text(language, "새로고침", "Refresh"))
            .build(app)?;
    let tray_pace_settings = MenuItemBuilder::with_id(
        "tray-pace-settings",
        menu_text(language, "설정", "Settings"),
    )
    .build(app)?;
    let tray_quit =
        MenuItemBuilder::with_id("tray-quit", menu_text(language, "종료", "Quit")).build(app)?;
    let tray_menu = MenuBuilder::new(app)
        .items(&[
            &tray_toggle,
            &tray_refresh,
            &tray_size_menu,
            &tray_pace_settings,
            &tray_quit,
        ])
        .build()?;

    let (context_size_menu, context_sizes) =
        build_size_submenu(app, "context", selected, language)?;
    let context_refresh = MenuItemBuilder::with_id(
        "context-refresh",
        menu_text(language, "새로고침", "Refresh"),
    )
    .build(app)?;
    let context_pace_settings = MenuItemBuilder::with_id(
        "context-pace-settings",
        menu_text(language, "설정…", "Settings…"),
    )
    .build(app)?;
    let context_hide = MenuItemBuilder::with_id(
        "context-hide",
        menu_text(language, "오버레이 숨기기", "Hide overlay"),
    )
    .build(app)?;
    let context_quit = MenuItemBuilder::with_id(
        "context-quit",
        menu_text(language, "QuotaPacer 종료", "Quit QuotaPacer"),
    )
    .build(app)?;
    let context = MenuBuilder::new(app)
        .item(&context_size_menu)
        .separator()
        .items(&[&context_refresh, &context_pace_settings, &context_hide])
        .separator()
        .item(&context_quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("QuotaPacer")
        .menu(&tray_menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(OverlayMenus {
        context,
        tray_sizes,
        context_sizes,
        tray_toggle,
        tray_refresh,
        tray_settings: tray_pace_settings,
        tray_quit,
        context_refresh,
        context_settings: context_pace_settings,
        context_hide,
        context_quit,
    })
}

fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    if let Some(size) = overlay_size_from_menu_id(id) {
        select_overlay_size(app, size);
        return;
    }

    match id {
        "tray-toggle" => toggle_main_window(app),
        "tray-refresh" | "context-refresh" => {
            if let Some(state) = app.try_state::<AppState>() {
                state.usage.refresh();
            }
        }
        id if is_pace_settings_menu_id(id) => show_settings_window(app),
        "context-hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "tray-quit" | "context-quit" => quit_app(app),
        _ => {}
    }
}

fn is_pace_settings_menu_id(id: &str) -> bool {
    matches!(id, "tray-pace-settings" | "context-pace-settings")
}

fn overlay_size_from_menu_id(id: &str) -> Option<OverlaySize> {
    match id {
        "tray-size-small" | "context-size-small" => Some(OverlaySize::Small),
        "tray-size-middle" | "context-size-middle" => Some(OverlaySize::Middle),
        "tray-size-large" | "context-size-large" => Some(OverlaySize::Large),
        _ => None,
    }
}

fn quit_app(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.exiting.store(true, Ordering::SeqCst);
        state.usage.shutdown();
    }
    app.exit(0);
}

fn select_overlay_size(app: &tauri::AppHandle, size: OverlaySize) {
    let windows = if let Some(state) = app.try_state::<AppState>() {
        let windows = state.usage.state().windows;
        let _ = state.settings.set_overlay_size(size);
        windows
    } else {
        Vec::new()
    };
    if let Some(menus) = app.try_state::<OverlayMenus>() {
        let _ = menus.sync(size);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = resize_overlay_window(&window, size, &windows);
    }
    let _ = app.emit("ui://overlay-size-changed", size);
}

fn overlay_dimensions(size: OverlaySize, windows: &[UsageWindow]) -> (f64, f64) {
    if size != OverlaySize::Large {
        return size.base_dimensions();
    }

    if windows.is_empty() {
        return (360.0, 240.0);
    }
    let reserve_active = is_luna_reserve_active(windows);
    let (short_rows, detail_rows) =
        windows
            .iter()
            .fold((0.0_f64, 0.0_f64), |(short, detail), window| {
                if is_luna_reserve(window) || (reserve_active && window.remaining_percent == 0) {
                    (short + 1.0, detail)
                } else if reserve_active {
                    (short, detail)
                } else if window
                    .window_duration_mins
                    .and_then(|minutes| minutes.checked_mul(60))
                    .is_some_and(|seconds| seconds > 0 && seconds < 24 * 60 * 60)
                {
                    (short + 1.0, detail)
                } else {
                    (short, detail + 1.0)
                }
            });
    (
        360.0,
        (16.0 + 48.0 + short_rows * 88.0 + detail_rows * 176.0).min(520.0),
    )
}

fn resize_overlay_window(
    window: &WebviewWindow,
    size: OverlaySize,
    windows: &[UsageWindow],
) -> Result<(), String> {
    let old_position = window.outer_position().ok();
    let old_size = window.outer_size().ok();
    let monitor = window.current_monitor().ok().flatten();
    let (width, height) = overlay_dimensions(size, windows);

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    if let (Some(position), Some(old_size), Some(monitor), Ok(new_size)) =
        (old_position, old_size, monitor, window.outer_size())
    {
        let adjusted = anchored_position(
            monitor.work_area().position,
            monitor.work_area().size,
            position,
            old_size,
            new_size,
        );
        window
            .set_position(adjusted)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn anchored_position(
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    window_position: PhysicalPosition<i32>,
    old_size: PhysicalSize<u32>,
    new_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        anchored_axis(
            work_position.x,
            work_size.width,
            window_position.x,
            old_size.width,
            new_size.width,
        ),
        anchored_axis(
            work_position.y,
            work_size.height,
            window_position.y,
            old_size.height,
            new_size.height,
        ),
    )
}

fn anchored_axis(
    work_start: i32,
    work_length: u32,
    window_start: i32,
    old_length: u32,
    new_length: u32,
) -> i32 {
    let work_start = i64::from(work_start);
    let work_end = work_start + i64::from(work_length);
    let window_start = i64::from(window_start);
    let old_end = window_start + i64::from(old_length);
    let distance_from_start = (window_start - work_start).abs();
    let distance_from_end = (work_end - old_end).abs();
    let anchored_start = if distance_from_end < distance_from_start {
        old_end - i64::from(new_length)
    } else {
        window_start
    };
    let max_start = (work_end - i64::from(new_length)).max(work_start);

    anchored_start.clamp(work_start, max_start) as i32
}

fn install_window_handlers(window: &WebviewWindow) {
    let handle = window.app_handle().clone();
    let window_for_event = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let should_exit = handle
                .try_state::<AppState>()
                .map(|state| state.exiting.load(Ordering::SeqCst))
                .unwrap_or(false);
            if !should_exit {
                api.prevent_close();
                let _ = window_for_event.hide();
            }
        }
        WindowEvent::Moved(position) => {
            if let Some(state) = handle.try_state::<AppState>() {
                let _ = state.settings.set_window_position(StoredPosition {
                    x: position.x,
                    y: position.y,
                });
            }
        }
        _ => {}
    });
}

fn install_settings_window_handlers(window: &WebviewWindow) {
    let handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.emit_to("settings", "ui://settings-close-requested", ());
        }
    });
}

fn position_window(window: &WebviewWindow, settings: &SettingsStore) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };

    if let Some(stored) = settings.window_position() {
        if let Some(monitor) = monitors.iter().find(|monitor| {
            let position = &monitor.work_area().position;
            let size = &monitor.work_area().size;
            stored.x >= position.x
                && stored.y >= position.y
                && stored.x < position.x + size.width as i32
                && stored.y < position.y + size.height as i32
        }) {
            let position = &monitor.work_area().position;
            let size = &monitor.work_area().size;
            let max_x = position.x + size.width as i32 - window_size.width as i32;
            let max_y = position.y + size.height as i32 - window_size.height as i32;
            let x = stored.x.clamp(position.x, max_x.max(position.x));
            let y = stored.y.clamp(position.y, max_y.max(position.y));
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }

    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let margin = (16.0 * scale).round() as i32;
        let position = &monitor.work_area().position;
        let size = &monitor.work_area().size;
        let x = position.x + size.width as i32 - window_size.width as i32 - margin;
        let y = position.y + margin;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_settings_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if !was_visible {
            let _ = app.emit_to("settings", "ui://settings-opened", ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        anchored_position, apply_launch_at_login_change, is_pace_settings_menu_id,
        overlay_dimensions, overlay_size_from_menu_id, validated_overlay_menu_position,
        OverlayAppearance, OverlayAppearancePhase, OverlayAppearancePreviewController,
        OverlayMenuPosition,
    };
    use crate::settings::{LargePlanVisualization, OverlaySize};
    use crate::usage::{UsageWindow, UsageWindowKind};
    use tauri::{PhysicalPosition, PhysicalSize};

    fn appearance(
        overlay_opacity: u8,
        large_plan_visualization: LargePlanVisualization,
    ) -> OverlayAppearance {
        OverlayAppearance {
            overlay_opacity,
            large_plan_visualization,
        }
    }

    fn usage_window(id: &str, duration_minutes: i64) -> UsageWindow {
        UsageWindow {
            id: id.to_string(),
            bucket_id: "codex".to_string(),
            bucket_label: None,
            kind: UsageWindowKind::Regular,
            used_percent: 0,
            remaining_percent: 100,
            window_duration_mins: Some(duration_minutes),
            resets_at: None,
        }
    }

    fn reserve_window(id: &str, duration_minutes: i64) -> UsageWindow {
        UsageWindow {
            id: id.to_string(),
            bucket_id: "gpt-reserve".to_string(),
            bucket_label: None,
            kind: UsageWindowKind::LunaReserve,
            used_percent: 0,
            remaining_percent: 100,
            window_duration_mins: Some(duration_minutes),
            resets_at: None,
        }
    }

    #[test]
    fn launch_at_login_change_runs_only_the_required_os_action() {
        let mut enabled = 0;
        let mut disabled = 0;

        assert!(!apply_launch_at_login_change(
            false,
            false,
            || {
                enabled += 1;
                Ok(())
            },
            || {
                disabled += 1;
                Ok(())
            },
        )
        .unwrap());
        assert_eq!((enabled, disabled), (0, 0));

        assert!(apply_launch_at_login_change(
            false,
            true,
            || {
                enabled += 1;
                Ok(())
            },
            || {
                disabled += 1;
                Ok(())
            },
        )
        .unwrap());
        assert_eq!((enabled, disabled), (1, 0));

        assert!(apply_launch_at_login_change(
            true,
            false,
            || {
                enabled += 1;
                Ok(())
            },
            || {
                disabled += 1;
                Ok(())
            },
        )
        .unwrap());
        assert_eq!((enabled, disabled), (1, 1));
    }

    #[test]
    fn launch_at_login_change_surfaces_registration_failures() {
        let error =
            apply_launch_at_login_change(false, true, || Err("등록 실패".to_string()), || Ok(()))
                .unwrap_err();

        assert_eq!(error, "등록 실패");
    }

    #[test]
    fn collapsed_dimensions_follow_the_selected_information_density() {
        let weekly = [usage_window("weekly", 7 * 24 * 60)];
        assert_eq!(
            overlay_dimensions(OverlaySize::Small, &weekly),
            (152.0, 56.0)
        );
        assert_eq!(
            overlay_dimensions(OverlaySize::Middle, &weekly),
            (280.0, 72.0)
        );
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, &weekly),
            (360.0, 240.0)
        );
    }

    #[test]
    fn large_layout_uses_short_and_detail_row_heights_and_bounds_its_height() {
        let short = usage_window("five-hours", 300);
        let weekly = usage_window("weekly", 7 * 24 * 60);
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, std::slice::from_ref(&short)),
            (360.0, 152.0)
        );
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, std::slice::from_ref(&weekly)),
            (360.0, 240.0)
        );
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, &[short.clone(), weekly.clone()]),
            (360.0, 328.0)
        );
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, &[weekly.clone(), weekly]),
            (360.0, 416.0)
        );
        assert_eq!(
            overlay_dimensions(
                OverlaySize::Large,
                &[
                    short.clone(),
                    short.clone(),
                    short.clone(),
                    short.clone(),
                    short.clone(),
                    short,
                ],
            ),
            (360.0, 520.0)
        );
        assert_eq!(overlay_dimensions(OverlaySize::Large, &[]), (360.0, 240.0));
    }

    #[test]
    fn large_layout_treats_luna_reserve_and_exhausted_regular_windows_as_compact_rows() {
        let regular = usage_window("weekly", 7 * 24 * 60);
        let reserve = reserve_window("gpt-reserve:primary", 7 * 24 * 60);
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, &[regular.clone(), reserve.clone()]),
            (360.0, 328.0)
        );

        let exhausted = UsageWindow {
            used_percent: 100,
            remaining_percent: 0,
            ..regular
        };
        assert_eq!(
            overlay_dimensions(OverlaySize::Large, &[exhausted, reserve]),
            (360.0, 240.0)
        );
    }

    #[test]
    fn tray_and_context_menu_ids_select_the_same_sizes() {
        assert_eq!(
            overlay_size_from_menu_id("tray-size-small"),
            Some(OverlaySize::Small)
        );
        assert_eq!(
            overlay_size_from_menu_id("context-size-small"),
            Some(OverlaySize::Small)
        );
        assert_eq!(
            overlay_size_from_menu_id("tray-size-large"),
            Some(OverlaySize::Large)
        );
        assert_eq!(overlay_size_from_menu_id("context-refresh"), None);
    }

    #[test]
    fn tray_and_context_menus_open_the_same_pace_settings_window() {
        assert!(is_pace_settings_menu_id("tray-pace-settings"));
        assert!(is_pace_settings_menu_id("context-pace-settings"));
        assert!(!is_pace_settings_menu_id("tray-refresh"));
    }

    #[test]
    fn overlay_menu_position_accepts_logical_coordinates_and_rejects_invalid_values() {
        let position =
            validated_overlay_menu_position(Some(OverlayMenuPosition { x: 244.0, y: 34.0 }))
                .unwrap();
        assert_eq!((position.x, position.y), (244.0, 34.0));

        for position in [
            OverlayMenuPosition { x: -1.0, y: 0.0 },
            OverlayMenuPosition {
                x: f64::NAN,
                y: 0.0,
            },
            OverlayMenuPosition {
                x: 0.0,
                y: f64::INFINITY,
            },
        ] {
            assert!(validated_overlay_menu_position(Some(position)).is_none());
        }
        assert!(validated_overlay_menu_position(None).is_none());
    }

    #[test]
    fn appearance_preview_rejects_stale_sessions_and_revisions() {
        let persisted = appearance(100, LargePlanVisualization::Deviation);
        let mut controller = OverlayAppearancePreviewController::default();
        let (first_session, _) = controller.begin(persisted);
        let first = controller.preview(first_session, 1, 70).unwrap();
        assert_eq!(first.phase, OverlayAppearancePhase::Preview);
        assert_eq!(
            first.appearance,
            appearance(70, LargePlanVisualization::Deviation)
        );
        assert!(controller.preview(first_session, 1, 60).is_none());

        let (second_session, reverted) = controller.begin(persisted);
        let reverted = reverted.unwrap();
        assert_eq!(reverted.phase, OverlayAppearancePhase::Reverted);
        assert_eq!(reverted.appearance, persisted);
        assert!(controller.preview(first_session, 2, 50).is_none());
        assert!(controller.preview(second_session, 1, 65).is_some());
    }

    #[test]
    fn language_preview_rejects_stale_sessions_and_revisions() {
        let persisted = appearance(100, LargePlanVisualization::Deviation);
        let mut controller = OverlayAppearancePreviewController::default();
        let (first_session, _) = controller.begin(persisted);

        assert!(controller.preview_language(first_session, 1));
        assert!(!controller.preview_language(first_session, 1));

        let (second_session, _) = controller.begin(persisted);
        assert!(!controller.preview_language(first_session, 2));
        assert!(controller.preview_language(second_session, 1));
    }

    #[test]
    fn appearance_preview_commit_restarts_with_a_new_session() {
        let persisted = appearance(100, LargePlanVisualization::Deviation);
        let saved = appearance(65, LargePlanVisualization::WeeklyAllocation);
        let mut controller = OverlayAppearancePreviewController::default();
        let (session, _) = controller.begin(persisted);
        let preview = controller.preview(session, 1, 65).unwrap();
        let (next_session, committed) = controller.commit_and_restart(session, saved).unwrap();

        assert!(next_session > session);
        assert!(committed.update_id > preview.update_id);
        assert_eq!(committed.phase, OverlayAppearancePhase::Committed);
        assert_eq!(committed.appearance, saved);
        assert_eq!(controller.effective(saved).appearance, saved);
        assert!(controller.preview(session, 2, 50).is_none());
    }

    #[test]
    fn appearance_preview_cancel_restores_the_persisted_value() {
        let persisted = appearance(100, LargePlanVisualization::Deviation);
        let preview = appearance(40, LargePlanVisualization::Deviation);
        let mut controller = OverlayAppearancePreviewController::default();
        let (session, _) = controller.begin(persisted);
        controller.preview(session, 1, 40).unwrap();
        assert_eq!(
            controller.effective(persisted),
            super::OverlayAppearanceUpdate {
                appearance: preview,
                phase: OverlayAppearancePhase::Preview,
                update_id: 1,
            }
        );
        let reverted = controller.cancel(session, persisted).unwrap();

        assert_eq!(reverted.appearance, persisted);
        assert_eq!(reverted.phase, OverlayAppearancePhase::Reverted);
        assert_eq!(controller.effective(persisted).appearance, persisted);
    }

    #[test]
    fn visualization_commit_merges_with_an_active_opacity_preview() {
        let persisted = appearance(100, LargePlanVisualization::Deviation);
        let selected = appearance(100, LargePlanVisualization::WeeklyAllocation);
        let mut controller = OverlayAppearancePreviewController::default();
        let (session, _) = controller.begin(persisted);
        controller.preview(session, 1, 65).unwrap();

        let update = controller.commit_visualization(selected);

        assert_eq!(update.phase, OverlayAppearancePhase::Preview);
        assert_eq!(
            update.appearance,
            appearance(65, LargePlanVisualization::WeeklyAllocation)
        );
        let reverted = controller.cancel(session, selected).unwrap();
        assert_eq!(reverted.phase, OverlayAppearancePhase::Reverted);
        assert_eq!(reverted.appearance, selected);
    }

    #[test]
    fn resize_preserves_the_nearest_work_area_edges() {
        let work_position = PhysicalPosition::new(0, 0);
        let work_size = PhysicalSize::new(1920, 1080);

        let top_right = anchored_position(
            work_position,
            work_size,
            PhysicalPosition::new(1624, 16),
            PhysicalSize::new(280, 72),
            PhysicalSize::new(152, 56),
        );
        assert_eq!(top_right, PhysicalPosition::new(1752, 16));

        let bottom_left = anchored_position(
            work_position,
            work_size,
            PhysicalPosition::new(16, 984),
            PhysicalSize::new(240, 80),
            PhysicalSize::new(240, 240),
        );
        assert_eq!(bottom_left, PhysicalPosition::new(16, 824));
    }

    #[test]
    fn resize_clamps_an_oversized_window_to_the_work_area_origin() {
        let position = anchored_position(
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1280, 720),
            PhysicalPosition::new(-700, 680),
            PhysicalSize::new(152, 56),
            PhysicalSize::new(1400, 800),
        );

        assert_eq!(position, PhysicalPosition::new(-1920, 0));
    }
}
