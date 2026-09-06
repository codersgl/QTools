use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// 容器级 `#[serde(default)]` 是必须的：历史配置文件里的提示词条目没有
/// `thinking` 字段，缺省解析失败会让 load_config 静默回退到默认值、丢掉全部提示词。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomPrompt {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub placeholder: String,
    /// 取值见前端 THINKING_OPTIONS。缺省用 `auto` 而不是空串，
    /// 保证回传给渲染层的值始终落在联合类型的范围内。
    #[serde(default = "default_thinking")]
    pub thinking: String,
}

fn default_thinking() -> String {
    "auto".into()
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
    pub auto_check_updates: bool,
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
            auto_check_updates: true,
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

fn write_config(dir: &PathBuf, config: &AppConfig) -> Result<(), String> {
    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 读取磁盘上的既有配置；读不到或解析失败一律返回 None。
/// 调用方拿到 None 时必须放弃写入，否则会用默认值静默清空用户设置。
fn read_existing_config(dir: &PathBuf) -> Option<AppConfig> {
    let raw = fs::read_to_string(dir.join("config.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else {
        return Err("无法获取配置目录".into());
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_config(&dir, config)
}

/// 窗口失焦时记录位置。既有配置不可用时直接跳过，不写默认值。
pub fn save_window_position(x: i32, y: i32) {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else { return };
    let Some(mut config) = read_existing_config(&dir) else { return };
    if config.window_x == Some(x) && config.window_y == Some(y) {
        return;
    }
    config.window_x = Some(x);
    config.window_y = Some(y);
    let _ = write_config(&dir, &config);
}

/// 记录的窗口位置已不可用（例如显示器变更导致落到屏幕外）时清掉，让窗口回中。
pub fn clear_window_position() {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = config_dir() else { return };
    let Some(mut config) = read_existing_config(&dir) else { return };
    if config.window_x.is_none() && config.window_y.is_none() {
        return;
    }
    config.window_x = None;
    config.window_y = None;
    let _ = write_config(&dir, &config);
}

/// 允许写入凭据管理器的 account 白名单。渲染层可以传任意字符串作为
/// `provider`，不加约束就等于把一个任意命名的凭据槽交给外部写入。
const KNOWN_PROVIDERS: &[&str] = &["deepseek", "openai", "siliconflow"];

fn check_provider(provider: &str) -> Result<(), String> {
    if KNOWN_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("未知供应商: {provider}"))
    }
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    check_provider(provider)?;
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

pub fn has_api_key(provider: &str) -> Result<bool, String> {
    check_provider(provider)?;
    Ok(get_api_key(provider).is_some())
}
