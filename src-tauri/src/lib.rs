mod codex;
mod settings;
mod usage;

use codex::{inspect_cli, CliInfo, UsageService};
use settings::{SettingsStore, StoredPosition};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};
use usage::UsageViewState;

struct AppState {
    usage: UsageService,
    settings: SettingsStore,
    exiting: AtomicBool,
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
fn set_overlay_expanded(expanded: bool, height: f64, window: WebviewWindow) -> Result<(), String> {
    let _ = expanded;
    window
        .set_size(LogicalSize::new(240.0, height))
        .map_err(|error| error.to_string())?;
    Ok(())
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
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("settings.json");
            let settings = SettingsStore::load(config_path);
            let usage = UsageService::start(app.handle().clone(), settings.clone());
            app.manage(AppState {
                usage,
                settings: settings.clone(),
                exiting: AtomicBool::new(false),
            });

            setup_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
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
            set_overlay_expanded
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuotaPacer");
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "표시/숨기기").build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh", "새로고침").build(app)?;
    let choose_cli = MenuItemBuilder::with_id("choose-cli", "Codex CLI 경로 선택").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "종료").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &refresh, &choose_cli, &quit])
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("QuotaPacer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "refresh" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.usage.refresh();
                }
            }
            "choose-cli" => {
                show_main_window(app);
                let _ = app.emit("usage://pick-cli", ());
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.exiting.store(true, Ordering::SeqCst);
                    state.usage.shutdown();
                }
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
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
        WindowEvent::Focused(false) => {
            let _ = window_for_event.emit("ui://collapse", ());
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
