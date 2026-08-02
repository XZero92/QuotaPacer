mod codex;
mod pace;
mod settings;
mod usage;

use codex::{inspect_cli, CliInfo, UsageService};
use pace::{PaceService, PaceViewState};
use serde::Serialize;
use settings::{
    validate_overlay_opacity, EditableSettings, LargePlanVisualization, OverlaySize, SettingsStore,
    StoredPosition,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, Submenu,
    SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WindowEvent, Wry,
};
use usage::UsageViewState;

struct AppState {
    usage: UsageService,
    pace: PaceService,
    settings: SettingsStore,
    opacity_preview: Mutex<OpacityPreviewController>,
    exiting: AtomicBool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OverlayOpacityPhase {
    Preview,
    Committed,
    Reverted,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayOpacityUpdate {
    opacity_percent: u8,
    phase: OverlayOpacityPhase,
    update_id: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSession {
    session_id: u64,
    settings: EditableSettings,
}

#[derive(Clone, Copy, Debug)]
struct ActiveOpacityPreview {
    session_id: u64,
    latest_revision: u64,
    opacity_percent: u8,
    has_preview: bool,
}

#[derive(Debug, Default)]
struct OpacityPreviewController {
    latest_session_id: u64,
    latest_update_id: u64,
    active: Option<ActiveOpacityPreview>,
}

impl OpacityPreviewController {
    fn begin(&mut self, persisted_opacity: u8) -> (u64, Option<OverlayOpacityUpdate>) {
        let should_revert = self
            .active
            .take()
            .map(|active| active.has_preview)
            .unwrap_or(false);
        let reverted = should_revert
            .then(|| self.next_update(persisted_opacity, OverlayOpacityPhase::Reverted));
        let session_id = self.next_session_id();
        self.active = Some(ActiveOpacityPreview {
            session_id,
            latest_revision: 0,
            opacity_percent: persisted_opacity,
            has_preview: false,
        });
        (session_id, reverted)
    }

    fn preview(
        &mut self,
        session_id: u64,
        revision: u64,
        opacity_percent: u8,
    ) -> Option<OverlayOpacityUpdate> {
        let accepted = self
            .active
            .as_mut()
            .filter(|active| active.session_id == session_id && revision > active.latest_revision);
        let active = accepted?;
        active.latest_revision = revision;
        active.opacity_percent = opacity_percent;
        active.has_preview = true;
        Some(self.next_update(opacity_percent, OverlayOpacityPhase::Preview))
    }

    fn cancel(&mut self, session_id: u64, persisted_opacity: u8) -> Option<OverlayOpacityUpdate> {
        let active = self
            .active
            .filter(|active| active.session_id == session_id)?;
        self.active = None;
        active
            .has_preview
            .then(|| self.next_update(persisted_opacity, OverlayOpacityPhase::Reverted))
    }

    fn is_active(&self, session_id: u64) -> bool {
        self.active
            .map(|active| active.session_id == session_id)
            .unwrap_or(false)
    }

    fn commit_and_restart(
        &mut self,
        session_id: u64,
        opacity_percent: u8,
    ) -> Option<(u64, OverlayOpacityUpdate)> {
        if !self.is_active(session_id) {
            return None;
        }
        self.active = None;
        let update = self.next_update(opacity_percent, OverlayOpacityPhase::Committed);
        let next_session_id = self.next_session_id();
        self.active = Some(ActiveOpacityPreview {
            session_id: next_session_id,
            latest_revision: 0,
            opacity_percent,
            has_preview: false,
        });
        Some((next_session_id, update))
    }

    fn effective(&self, persisted_opacity: u8) -> OverlayOpacityUpdate {
        if let Some(active) = self.active.filter(|active| active.has_preview) {
            OverlayOpacityUpdate {
                opacity_percent: active.opacity_percent,
                phase: OverlayOpacityPhase::Preview,
                update_id: self.latest_update_id,
            }
        } else {
            OverlayOpacityUpdate {
                opacity_percent: persisted_opacity,
                phase: OverlayOpacityPhase::Committed,
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
        opacity_percent: u8,
        phase: OverlayOpacityPhase,
    ) -> OverlayOpacityUpdate {
        self.latest_update_id = self.latest_update_id.wrapping_add(1).max(1);
        OverlayOpacityUpdate {
            opacity_percent,
            phase,
            update_id: self.latest_update_id,
        }
    }
}

#[derive(Clone)]
struct SizeMenuItems {
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
}

struct OverlayMenus {
    context: Menu<Wry>,
    tray_sizes: SizeMenuItems,
    context_sizes: SizeMenuItems,
}

impl OverlayMenus {
    fn sync(&self, selected: OverlaySize) -> tauri::Result<()> {
        self.tray_sizes.sync(selected)?;
        self.context_sizes.sync(selected)
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
fn set_codex_executable(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<CliInfo, String> {
    let explicit_path = path.map(PathBuf::from);
    let cli = inspect_cli(explicit_path.clone())?;
    state.settings.set_codex_executable(explicit_path)?;
    state.usage.executable_changed();
    Ok(cli)
}

#[tauri::command]
fn get_overlay_size(state: State<'_, AppState>) -> OverlaySize {
    state.settings.overlay_size()
}

#[tauri::command]
fn get_large_plan_visualization(state: State<'_, AppState>) -> LargePlanVisualization {
    state.settings.large_plan_visualization()
}

#[tauri::command]
fn begin_settings_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsSession, String> {
    let settings = state.settings.editable_settings();
    let (session_id, reverted) = state
        .opacity_preview
        .lock()
        .map_err(|_| "투명도 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .begin(settings.overlay_opacity);
    if let Some(update) = reverted {
        emit_opacity_update(&app, update);
    }
    Ok(SettingsSession {
        session_id,
        settings,
    })
}

#[tauri::command]
fn preview_overlay_opacity(
    session_id: u64,
    revision: u64,
    opacity_percent: u8,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<OverlayOpacityUpdate>, String> {
    validate_overlay_opacity(opacity_percent)?;
    let update = state
        .opacity_preview
        .lock()
        .map_err(|_| "투명도 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .preview(session_id, revision, opacity_percent);
    if let Some(update) = update {
        emit_opacity_update(&app, update);
    }
    Ok(update)
}

#[tauri::command]
fn save_editable_settings(
    session_id: u64,
    settings: EditableSettings,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsSession, String> {
    let mut preview = state
        .opacity_preview
        .lock()
        .map_err(|_| "투명도 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    if !preview.is_active(session_id) {
        return Err("설정 세션이 만료되었습니다. 설정 창을 다시 열어주세요.".to_string());
    }
    let saved = state.settings.set_editable_settings(settings)?;
    let (next_session_id, update) = preview
        .commit_and_restart(session_id, saved.overlay_opacity)
        .ok_or_else(|| "설정 세션이 만료되었습니다. 설정 창을 다시 열어주세요.".to_string())?;
    drop(preview);
    state.pace.recompute(&state.usage.state());
    emit_opacity_update(&app, update);
    let _ = app.emit_to(
        "main",
        "ui://large-plan-visualization-changed",
        saved.large_plan_visualization,
    );
    Ok(SettingsSession {
        session_id: next_session_id,
        settings: saved,
    })
}

#[tauri::command]
fn cancel_settings_session(
    session_id: u64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let persisted_opacity = state.settings.overlay_opacity();
    let update = state
        .opacity_preview
        .lock()
        .map_err(|_| "투명도 미리보기 상태를 잠글 수 없습니다.".to_string())?
        .cancel(session_id, persisted_opacity);
    if let Some(update) = update {
        emit_opacity_update(&app, update);
    }
    Ok(())
}

#[tauri::command]
fn get_effective_overlay_opacity(
    state: State<'_, AppState>,
) -> Result<OverlayOpacityUpdate, String> {
    let preview = state
        .opacity_preview
        .lock()
        .map_err(|_| "투명도 미리보기 상태를 잠글 수 없습니다.".to_string())?;
    Ok(preview.effective(state.settings.overlay_opacity()))
}

fn emit_opacity_update(app: &tauri::AppHandle, update: OverlayOpacityUpdate) {
    let _ = app.emit_to("main", "ui://overlay-opacity-updated", update);
}

#[tauri::command]
fn show_overlay_context_menu(
    window: WebviewWindow,
    menus: State<'_, OverlayMenus>,
) -> Result<(), String> {
    window
        .as_ref()
        .window()
        .popup_menu(&menus.context)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_overlay_layout(
    size: OverlaySize,
    window_count: usize,
    window: WebviewWindow,
) -> Result<(), String> {
    resize_overlay_window(&window, size, window_count)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
                opacity_preview: Mutex::new(OpacityPreviewController::default()),
                exiting: AtomicBool::new(false),
            });

            let menus = setup_menus(app, settings.overlay_size())?;
            app.manage(menus);
            if let Some(window) = app.get_webview_window("main") {
                let (width, height) = overlay_dimensions(settings.overlay_size(), 0);
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
            clear_pace_history,
            show_pace_settings,
            refresh_usage,
            set_codex_executable,
            get_overlay_size,
            get_large_plan_visualization,
            begin_settings_session,
            preview_overlay_opacity,
            save_editable_settings,
            cancel_settings_session,
            get_effective_overlay_opacity,
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
) -> tauri::Result<(Submenu<Wry>, SizeMenuItems)> {
    let small = CheckMenuItemBuilder::with_id(format!("{prefix}-size-small"), "작게")
        .checked(selected == OverlaySize::Small)
        .build(app)?;
    let middle = CheckMenuItemBuilder::with_id(format!("{prefix}-size-middle"), "보통")
        .checked(selected == OverlaySize::Middle)
        .build(app)?;
    let large = CheckMenuItemBuilder::with_id(format!("{prefix}-size-large"), "크게")
        .checked(selected == OverlaySize::Large)
        .build(app)?;
    let submenu = SubmenuBuilder::new(app, "오버레이 크기")
        .items(&[&small, &middle, &large])
        .build()?;

    Ok((
        submenu,
        SizeMenuItems {
            small,
            middle,
            large,
        },
    ))
}

fn setup_menus(app: &mut tauri::App, selected: OverlaySize) -> tauri::Result<OverlayMenus> {
    let (tray_size_menu, tray_sizes) = build_size_submenu(app, "tray", selected)?;
    let tray_toggle = MenuItemBuilder::with_id("tray-toggle", "표시/숨기기").build(app)?;
    let tray_refresh = MenuItemBuilder::with_id("tray-refresh", "새로고침").build(app)?;
    let tray_choose_cli =
        MenuItemBuilder::with_id("tray-choose-cli", "Codex CLI 경로 선택").build(app)?;
    let tray_pace_settings = MenuItemBuilder::with_id("tray-pace-settings", "설정").build(app)?;
    let tray_quit = MenuItemBuilder::with_id("tray-quit", "종료").build(app)?;
    let tray_menu = MenuBuilder::new(app)
        .items(&[
            &tray_toggle,
            &tray_refresh,
            &tray_size_menu,
            &tray_pace_settings,
            &tray_choose_cli,
            &tray_quit,
        ])
        .build()?;

    let (context_size_menu, context_sizes) = build_size_submenu(app, "context", selected)?;
    let context_refresh = MenuItemBuilder::with_id("context-refresh", "새로고침").build(app)?;
    let context_choose_cli =
        MenuItemBuilder::with_id("context-choose-cli", "Codex CLI 경로 선택").build(app)?;
    let context_pace_settings =
        MenuItemBuilder::with_id("context-pace-settings", "설정").build(app)?;
    let context_hide = MenuItemBuilder::with_id("context-hide", "숨기기").build(app)?;
    let context_quit = MenuItemBuilder::with_id("context-quit", "종료").build(app)?;
    let context = MenuBuilder::new(app)
        .item(&context_size_menu)
        .separator()
        .items(&[
            &context_refresh,
            &context_pace_settings,
            &context_choose_cli,
            &context_hide,
            &context_quit,
        ])
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
        "tray-choose-cli" | "context-choose-cli" => {
            show_main_window(app);
            let _ = app.emit("usage://pick-cli", ());
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
    let window_count = if let Some(state) = app.try_state::<AppState>() {
        let window_count = state.usage.state().windows.len();
        let _ = state.settings.set_overlay_size(size);
        window_count
    } else {
        0
    };
    if let Some(menus) = app.try_state::<OverlayMenus>() {
        let _ = menus.sync(size);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = resize_overlay_window(&window, size, window_count);
    }
    let _ = app.emit("ui://overlay-size-changed", size);
}

fn overlay_dimensions(size: OverlaySize, window_count: usize) -> (f64, f64) {
    if size != OverlaySize::Large {
        return size.base_dimensions();
    }

    let extra_rows = window_count.saturating_sub(1) as f64;
    (360.0, (240.0 + extra_rows * 176.0).min(520.0))
}

fn resize_overlay_window(
    window: &WebviewWindow,
    size: OverlaySize,
    window_count: usize,
) -> Result<(), String> {
    let old_position = window.outer_position().ok();
    let old_size = window.outer_size().ok();
    let monitor = window.current_monitor().ok().flatten();
    let (width, height) = overlay_dimensions(size, window_count);

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
        anchored_position, is_pace_settings_menu_id, overlay_dimensions, overlay_size_from_menu_id,
        OpacityPreviewController, OverlayOpacityPhase,
    };
    use crate::settings::OverlaySize;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn collapsed_dimensions_follow_the_selected_information_density() {
        assert_eq!(overlay_dimensions(OverlaySize::Small, 1), (152.0, 56.0));
        assert_eq!(overlay_dimensions(OverlaySize::Middle, 1), (280.0, 72.0));
        assert_eq!(overlay_dimensions(OverlaySize::Large, 1), (360.0, 240.0));
    }

    #[test]
    fn large_layout_grows_per_window_and_bounds_its_height() {
        assert_eq!(overlay_dimensions(OverlaySize::Large, 2), (360.0, 416.0));
        assert_eq!(overlay_dimensions(OverlaySize::Large, 100), (360.0, 520.0));
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
    fn opacity_preview_rejects_stale_sessions_and_revisions() {
        let mut controller = OpacityPreviewController::default();
        let (first_session, _) = controller.begin(100);
        let first = controller.preview(first_session, 1, 70).unwrap();
        assert_eq!(first.phase, OverlayOpacityPhase::Preview);
        assert_eq!(first.opacity_percent, 70);
        assert!(controller.preview(first_session, 1, 60).is_none());

        let (second_session, reverted) = controller.begin(100);
        assert_eq!(reverted.unwrap().phase, OverlayOpacityPhase::Reverted);
        assert!(controller.preview(first_session, 2, 50).is_none());
        assert!(controller.preview(second_session, 1, 65).is_some());
    }

    #[test]
    fn opacity_preview_commit_restarts_with_a_new_session() {
        let mut controller = OpacityPreviewController::default();
        let (session, _) = controller.begin(100);
        let preview = controller.preview(session, 1, 65).unwrap();
        let (next_session, committed) = controller.commit_and_restart(session, 65).unwrap();

        assert!(next_session > session);
        assert!(committed.update_id > preview.update_id);
        assert_eq!(committed.phase, OverlayOpacityPhase::Committed);
        assert_eq!(controller.effective(65).opacity_percent, 65);
        assert!(controller.preview(session, 2, 50).is_none());
    }

    #[test]
    fn opacity_preview_cancel_restores_the_persisted_value() {
        let mut controller = OpacityPreviewController::default();
        let (session, _) = controller.begin(100);
        controller.preview(session, 1, 40).unwrap();
        let reverted = controller.cancel(session, 100).unwrap();

        assert_eq!(reverted.opacity_percent, 100);
        assert_eq!(reverted.phase, OverlayOpacityPhase::Reverted);
        assert_eq!(controller.effective(100).opacity_percent, 100);
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
