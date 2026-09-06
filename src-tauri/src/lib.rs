mod config;

use config::AppConfig;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::AutoLaunchManager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const DEFAULT_SHORTCUT: &str = "Alt+Space";
/// 窗口至少要有这么多像素留在某个显示器内，否则视为已丢失。
const MIN_VISIBLE_PX: i32 = 60;

static IS_DRAGGING: AtomicBool = AtomicBool::new(false);
/// 实际注册成功的快捷键，与配置里的期望值分开保存。
static ACTIVE_SHORTCUT: Mutex<String> = Mutex::new(String::new());
/// 快捷键注册失败的错误信息，前端拉取后提示用户。
static SHORTCUT_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn active_shortcut() -> String {
    ACTIVE_SHORTCUT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn set_active_shortcut(value: &str) {
    let mut slot = ACTIVE_SHORTCUT.lock().unwrap_or_else(|e| e.into_inner());
    slot.clear();
    slot.push_str(value);
}

fn set_shortcut_error(message: Option<String>) {
    let mut slot = SHORTCUT_ERROR.lock().unwrap_or_else(|e| e.into_inner());
    *slot = message;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutStatus {
    /// 当前进程里真正生效的快捷键；为空表示没有任何快捷键注册成功。
    active: String,
    error: Option<String>,
}

#[tauri::command]
fn set_dragging(dragging: bool) {
    IS_DRAGGING.store(dragging, Ordering::SeqCst);
}

/// 配置里的快捷键可能因为冲突而没真正注册，前端用它纠正显示并给出原因。
#[tauri::command]
fn shortcut_status() -> ShortcutStatus {
    ShortcutStatus {
        active: active_shortcut(),
        error: SHORTCUT_ERROR
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    }
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
fn has_api_key(provider: &str) -> Result<bool, String> {
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

/// 供前端在 `navigator.clipboard` 不可用时回退使用。
#[tauri::command]
fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// 在系统默认浏览器里打开链接。窗口无边框无地址栏，绝不能让模型输出
/// 里的链接把自身导航走，所以链接只能交给外部处理。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅允许打开 http(s) 链接".into());
    }
    let mut command = {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
        }
    };
    // 参数直接进 CreateProcess，不经 shell 解析，无注入面。
    command
        .arg(url)
        .spawn()
        .map_err(|e| format!("无法打开默认浏览器: {e}"))?;
    Ok(())
}

/// 先注册新快捷键，成功后才注销旧的；失败时旧快捷键保持有效。
/// 旧值取运行时实际注册结果而不是配置值——配置可能与实际不一致。
#[tauri::command]
fn change_shortcut(app: tauri::AppHandle, new: String) -> Result<String, String> {
    let new = new.trim().to_string();
    if new.is_empty() {
        return Err("快捷键不能为空".into());
    }
    let previous = active_shortcut();
    if previous == new {
        set_shortcut_error(None);
        return Ok(new);
    }
    app.global_shortcut()
        .register(new.as_str())
        .map_err(|e| format!("注册快捷键 {new} 失败（可能已被其他程序占用）: {e}"))?;
    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }
    set_active_shortcut(&new);
    set_shortcut_error(None);
    Ok(new)
}

fn apply_autostart(app: &tauri::AppHandle, enable: bool) -> Result<(), String> {
    let manager = app.state::<AutoLaunchManager>();
    if enable {
        manager.enable().map_err(|e| e.to_string())
    } else {
        // 未启用过时 disable 会因注册表项不存在返回 os error 2，应幂等忽略
        let _ = manager.disable();
        Ok(())
    }
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    apply_autostart(&app, enable)
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    let manager = app.state::<AutoLaunchManager>();
    manager.is_enabled().unwrap_or(false)
}

fn position_on_screen(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        // 查询失败时不阻塞显示
        return true;
    };
    let size = window
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(480, 400));
    let width = size.width as i32;
    let height = size.height as i32;
    monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let right = left + area.size.width as i32;
        let bottom = top + area.size.height as i32;
        x + width - MIN_VISIBLE_PX > left
            && y + height - MIN_VISIBLE_PX > top
            && x + MIN_VISIBLE_PX < right
            && y + MIN_VISIBLE_PX < bottom
    })
}

/// 窗口可能正聚焦而不会触发失焦（例如从托盘退出），位置需要在这里补写。
fn save_position_of(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(pos) = window.outer_position() {
        config::save_window_position(pos.x, pos.y);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // 拖拽期间被隐藏过时标志位可能残留，显示前清掉，避免失焦永久不隐藏。
    IS_DRAGGING.store(false, Ordering::SeqCst);

    let cfg = config::load_config();
    match (cfg.window_x, cfg.window_y) {
        (Some(x), Some(y)) if position_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        // 记录的位置已落在断开连接的显示器上，回中并清掉记录。
        (Some(_), Some(_)) => {
            let _ = window.center();
            config::clear_window_position();
        }
        _ => {
            let _ = window.center();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        save_position_of(app);
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

fn register_shortcut(app: &tauri::AppHandle, shortcut: &str) -> bool {
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            set_active_shortcut(shortcut);
            true
        }
        Err(e) => {
            eprintln!("无法注册快捷键 {shortcut}: {e}");
            false
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_main_window(app);
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
                    .tooltip("QTools")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => show_main_window(app),
                        "quit" => {
                            save_position_of(app);
                            app.exit(0)
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            let cfg = config::load_config();

            let shortcut = if cfg.shortcut.is_empty() {
                DEFAULT_SHORTCUT.to_string()
            } else {
                cfg.shortcut.clone()
            };
            if !register_shortcut(&app.handle(), &shortcut) {
                let mut message = format!("快捷键 {shortcut} 注册失败");
                if shortcut != DEFAULT_SHORTCUT {
                    if register_shortcut(&app.handle(), DEFAULT_SHORTCUT) {
                        message += &format!("，已回退到 {DEFAULT_SHORTCUT}");
                    } else {
                        message += "，默认快捷键同样注册失败，只能通过托盘图标唤起窗口";
                    }
                }
                set_shortcut_error(Some(message));
            }

            // 配置里的自启动意愿可能与系统实际状态脱节（手工改配置、
            // 上一次运行期注册失败），启动时对齐一次。
            let enabled = {
                let manager = app.handle().state::<AutoLaunchManager>();
                manager.is_enabled().unwrap_or(false)
            };
            if enabled != cfg.autostart {
                if let Err(e) = apply_autostart(&app.handle(), cfg.autostart) {
                    eprintln!("同步开机自启动失败: {e}");
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
            write_clipboard_text,
            open_external,
            change_shortcut,
            shortcut_status,
            set_autostart,
            is_autostart_enabled,
            set_dragging,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
