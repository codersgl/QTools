use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
pub struct CustomPrompt {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub placeholder: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub provider: String,
    pub model: String,
    pub custom_model: String,
    pub theme: String,
    pub custom_prompts: Vec<CustomPrompt>,
    pub autostart: bool,
    pub shortcut: String,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub clipboard_auto_read: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            custom_model: String::new(),
            theme: "system".into(),
            custom_prompts: Vec::new(),
            autostart: false,
            shortcut: "Alt+Space".into(),
            window_x: None,
            window_y: None,
            clipboard_auto_read: true,
        }
    }
}

fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("com.codersgl.qtools"))
}

pub fn load_config() -> AppConfig {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else {
        return AppConfig::default();
    };
    let path = dir.join("config.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else {
        return Err("无法获取配置目录".into());
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn save_window_position(x: i32, y: i32) {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else { return };
    let path = dir.join("config.json");

    let mut config: AppConfig = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    config.window_x = Some(x);
    config.window_y = Some(y);

    if let Ok(json) = serde_json::to_string_pretty(&config) {
        let tmp = dir.join("config.json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.codersgl.qtools", provider).map_err(|e| e.to_string())
}

pub fn get_api_key(provider: &str) -> Option<String> {
    keyring_entry(provider)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    keyring_entry(provider)?
        .set_password(key)
        .map_err(|e| e.to_string())
}

pub fn delete_api_key(provider: &str) -> Result<(), String> {
    keyring_entry(provider)?
        .delete_credential()
        .map_err(|e| e.to_string())
}

pub fn has_api_key(provider: &str) -> bool {
    get_api_key(provider).is_some()
}
