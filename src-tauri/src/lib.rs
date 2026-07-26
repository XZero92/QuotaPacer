mod codex;
mod settings;
mod usage;

use codex::{inspect_cli, CliInfo, UsageService};
use settings::{OverlaySize, SettingsStore, StoredPosition};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
    settings: SettingsStore,
    exiting: AtomicBool,
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
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("settings.json");
            let settings = SettingsStore::load(config_path);
            let usage = UsageService::start(app.handle().clone(), settings.clone());
            app.manage(AppState {
                usage,
                settings: settings.clone(),
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_usage_state,
            refresh_usage,
            set_codex_executable,
            get_overlay_size,
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
    let tray_quit = MenuItemBuilder::with_id("tray-quit", "종료").build(app)?;
    let tray_menu = MenuBuilder::new(app)
        .items(&[
            &tray_toggle,
            &tray_refresh,
            &tray_size_menu,
            &tray_choose_cli,
            &tray_quit,
        ])
        .build()?;

    let (context_size_menu, context_sizes) = build_size_submenu(app, "context", selected)?;
    let context_refresh = MenuItemBuilder::with_id("context-refresh", "새로고침").build(app)?;
    let context_choose_cli =
        MenuItemBuilder::with_id("context-choose-cli", "Codex CLI 경로 선택").build(app)?;
    let context_hide = MenuItemBuilder::with_id("context-hide", "숨기기").build(app)?;
    let context_quit = MenuItemBuilder::with_id("context-quit", "종료").build(app)?;
    let context = MenuBuilder::new(app)
        .item(&context_size_menu)
        .separator()
        .items(&[
            &context_refresh,
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
        "context-hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "tray-quit" | "context-quit" => quit_app(app),
        _ => {}
    }
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
    (320.0, (152.0 + extra_rows * 96.0).min(420.0))
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

#[cfg(test)]
mod tests {
    use super::{anchored_position, overlay_dimensions, overlay_size_from_menu_id};
    use crate::settings::OverlaySize;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn collapsed_dimensions_follow_the_selected_information_density() {
        assert_eq!(overlay_dimensions(OverlaySize::Small, 1), (152.0, 56.0));
        assert_eq!(overlay_dimensions(OverlaySize::Middle, 1), (280.0, 72.0));
        assert_eq!(overlay_dimensions(OverlaySize::Large, 1), (320.0, 152.0));
    }

    #[test]
    fn large_layout_grows_per_window_and_bounds_its_height() {
        assert_eq!(overlay_dimensions(OverlaySize::Large, 2), (320.0, 248.0));
        assert_eq!(overlay_dimensions(OverlaySize::Large, 100), (320.0, 420.0));
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
