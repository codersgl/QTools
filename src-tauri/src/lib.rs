mod config;

use config::AppConfig;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

static IS_DRAGGING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_dragging(dragging: bool) {
    IS_DRAGGING.store(dragging, Ordering::SeqCst);
}

#[tauri::command]
fn get_config() -> AppConfig {
    config::load_config()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
fn get_api_key(provider: &str) -> Option<String> {
    config::get_api_key(provider)
}

#[tauri::command]
fn has_api_key(provider: &str) -> bool {
    config::has_api_key(provider)
}

#[tauri::command]
fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    config::set_api_key(provider, key)
}

#[tauri::command]
fn delete_api_key(provider: &str) -> Result<(), String> {
    config::delete_api_key(provider)
}

#[tauri::command]
fn get_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn change_shortcut(app: tauri::AppHandle, old: String, new: String) -> Result<(), String> {
    app.global_shortcut()
        .register(new.as_str())
        .map_err(|e| format!("注册快捷键失败: {e}"))?;
    if !old.is_empty() {
        let _ = app.global_shortcut().unregister(old.as_str());
    }
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let manager = app.state::<tauri_plugin_autostart::AutoLaunchManager>();
    if enable {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        // 未启用过时 disable 会因注册表项不存在返回 os error 2，应幂等忽略
        let _ = manager.disable();
    }
    Ok(())
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    let manager = app.state::<tauri_plugin_autostart::AutoLaunchManager>();
    manager.is_enabled().unwrap_or(false)
}

fn show_main_window(app: &tauri::AppHandle) {
    let cfg = config::load_config();
    if let Some(window) = app.get_webview_window("main") {
        if cfg.window_x.is_none() || cfg.window_y.is_none() {
            let _ = window.center();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show_main_window(app);
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let show_item =
                MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon.clone())
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            let cfg = config::load_config();
            if let Some(window) = app.get_webview_window("main") {
                if let (Some(x), Some(y)) = (cfg.window_x, cfg.window_y) {
                    use tauri::PhysicalPosition;
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
            }

            let shortcut = if cfg.shortcut.is_empty() {
                "Alt+Space"
            } else {
                cfg.shortcut.as_str()
            };
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("无法注册快捷键 {shortcut}: {e}，尝试默认快捷键");
                if shortcut != "Alt+Space" {
                    let _ = app.global_shortcut().register("Alt+Space");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if IS_DRAGGING.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(pos) = window.outer_position() {
                    config::save_window_position(pos.x, pos.y);
                }
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_api_key,
            has_api_key,
            set_api_key,
            delete_api_key,
            get_clipboard_text,
            change_shortcut,
            set_autostart,
            is_autostart_enabled,
            set_dragging,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
