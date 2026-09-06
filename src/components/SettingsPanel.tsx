import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X, KeyRound, Trash2, Eye, EyeOff, Plus, Pencil, Check } from "lucide-react";
import { PROVIDERS } from "@/services/api";

interface CustomPrompt {
  id: string;
  name: string;
  system_prompt: string;
  placeholder: string;
}

interface AppConfig {
  provider: string;
  model: string;
  custom_model: string;
  theme: string;
  custom_prompts: CustomPrompt[];
  autostart: boolean;
  shortcut: string;
  window_x: number | null;
  window_y: number | null;
  clipboard_auto_read: boolean;
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
}

const THEMES = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
];

const MODIFIER_DISPLAY: Record<string, string> = {
  Control: "Ctrl",
  Super: "Win",
};

const KEY_NAME_MAP: Record<string, string> = {
  " ": "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  ",": "Comma", ".": "Period", ";": "Semicolon", "'": "Quote",
  "\\": "Backslash", "/": "Slash", "`": "Backquote",
  "[": "BracketLeft", "]": "BracketRight", "=": "Equal", "-": "Minus",
};

function toTauriKeyName(key: string): string | null {
  if (KEY_NAME_MAP[key]) return KEY_NAME_MAP[key];
  const lower = key.toLowerCase();
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  return null;
}

function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => MODIFIER_DISPLAY[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

export function SettingsPanel({ open, onClose, onConfigSaved }: SettingsPanelProps) {
  const [provider, setProvider] = useState("deepseek");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [customModel, setCustomModel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [theme, setTheme] = useState("system");
  const [shortcut, setShortcut] = useState("Alt+Space");
  const [autostart, setAutostart] = useState(false);
  const [clipboardAutoRead, setClipboardAutoRead] = useState(true);
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [recording, setRecording] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<CustomPrompt | null>(null);
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  const recordRef = useRef<HTMLDivElement>(null);
  const initialAutostartRef = useRef(false);

  useEffect(() => {
    if (open) loadSettings();
  }, [open]);

  useEffect(() => {
    if (!recording) return;
    recordRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        return;
      }

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Control");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");

      const key = e.key;
      if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
        const keyName = toTauriKeyName(key);
        if (keyName) {
          parts.push(keyName);
          if (parts.length > 1) {
            setShortcut(parts.join("+"));
            setRecording(false);
          }
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [recording]);

  async function loadSettings() {
    const config = (await invoke("get_config")) as AppConfig;
    const keySet = (await invoke("has_api_key", { provider: config.provider })) as boolean;
    const autoEnabled = (await invoke("is_autostart_enabled")) as boolean;
    setProvider(config.provider);
    setModel(config.model);
    setCustomModel(config.custom_model);
    setTheme(config.theme || "system");
    setShortcut(config.shortcut || "Alt+Space");
    setAutostart(autoEnabled);
    initialAutostartRef.current = autoEnabled;
    setClipboardAutoRead(config.clipboard_auto_read !== false);
    setCustomPrompts(config.custom_prompts || []);
    setHasKey(keySet);
    setApiKeyInput("");
    setError("");
    setRecording(false);
    setShowPromptEditor(false);
    setEditingPrompt(null);
  }

  async function handleSave() {
    setSaving(true);
    setError("");

    if (model === "custom" && !customModel.trim()) {
      setError("请输入自定义模型名称");
      setSaving(false);
      return;
    }

    try {
      const oldConfig = (await invoke("get_config")) as AppConfig;
      const oldShortcut = oldConfig.shortcut || "Alt+Space";

      await invoke("save_config", {
        config: {
          provider,
          model,
          custom_model: customModel,
          theme,
          custom_prompts: customPrompts,
          autostart,
          shortcut,
          window_x: oldConfig.window_x,
          window_y: oldConfig.window_y,
          clipboard_auto_read: clipboardAutoRead,
        },
      });

      if (apiKeyInput.trim()) {
        await invoke("set_api_key", { provider, key: apiKeyInput.trim() });
      }

      if (shortcut !== oldShortcut) {
        await invoke("change_shortcut", { old: oldShortcut, new: shortcut });
      }

      // 配置已持久化，先刷新主界面（新增的自定义提示词标签页立即出现）
      onConfigSaved();

      // 仅在自启动状态确实变化时才调用；失败不阻断已完成的配置保存
      if (autostart !== initialAutostartRef.current) {
        try {
          await invoke("set_autostart", { enable: autostart });
          initialAutostartRef.current = autostart;
        } catch (e) {
          setError(
            `开机自启动设置失败：${e instanceof Error ? e.message : String(e)}`,
          );
          setSaving(false);
          return;
        }
      }

      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteKey() {
    try {
      await invoke("delete_api_key", { provider });
      setHasKey(false);
      setApiKeyInput("");
      onConfigSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleAddPrompt() {
    setEditingPrompt({
      id: crypto.randomUUID(),
      name: "",
      system_prompt: "",
      placeholder: "",
    });
    setShowPromptEditor(true);
  }

  function handleEditPrompt(p: CustomPrompt) {
    setEditingPrompt({ ...p });
    setShowPromptEditor(true);
  }

  function handleSavePrompt() {
    if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.system_prompt.trim()) return;
    const exists = customPrompts.find((p) => p.id === editingPrompt.id);
    if (exists) {
      setCustomPrompts(customPrompts.map((p) => (p.id === editingPrompt.id ? editingPrompt : p)));
    } else {
      setCustomPrompts([...customPrompts, editingPrompt]);
    }
    setShowPromptEditor(false);
    setEditingPrompt(null);
  }

  function handleDeletePrompt(id: string) {
    setCustomPrompts(customPrompts.filter((p) => p.id !== id));
  }

  if (!open) return null;

  const currentProvider = PROVIDERS.find((p) => p.id === provider);
  const modelList = currentProvider?.models ?? [];

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-4">
      <div className="flex max-h-[90vh] w-[92%] max-w-sm flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">设置</h2>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Provider & Model */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">供应商</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                if (!v) return;
                setProvider(v);
                const p = PROVIDERS.find((p) => p.id === v);
                if (p) setModel(p.models[0]);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">模型</Label>
            <Select
              value={modelList.includes(model) ? model : "custom"}
              onValueChange={(v) => {
                if (v) setModel(v);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelList.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
                <SelectItem value="custom">自定义...</SelectItem>
              </SelectContent>
            </Select>
            {model === "custom" && (
              <Input
                placeholder="输入模型名称"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                className="mt-1 h-8 text-xs"
              />
            )}
          </div>

          {/* API Key */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">API Key</Label>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <KeyRound className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder={hasKey ? "已配置，输入新 Key 覆盖" : "输入 API Key"}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  className="h-8 pl-7 pr-7 text-xs"
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                </button>
              </div>
              {hasKey && !apiKeyInput && (
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0" onClick={handleDeleteKey}>
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              )}
            </div>
            {hasKey && !apiKeyInput && (
              <span className="text-[10px] text-green-600">已安全存储在系统凭据管理器</span>
            )}
          </div>

          {/* Theme */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">主题</Label>
            <Select value={theme} onValueChange={(v) => v && setTheme(v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Shortcut */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">唤起快捷键</Label>
            <div
              ref={recordRef}
              tabIndex={0}
              className={`flex h-8 items-center rounded-md border px-2.5 text-xs transition-colors outline-none ${
                recording ? "border-primary bg-primary/5" : "bg-background"
              }`}
              onClick={() => setRecording(true)}
            >
              <KeyRound className="mr-1.5 size-3 shrink-0 text-muted-foreground" />
              {recording ? (
                <span className="text-primary">按下新的快捷键组合...</span>
              ) : (
                <span className="flex-1 font-mono">{formatShortcut(shortcut)}</span>
              )}
              {recording && (
                <button
                  type="button"
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRecording(false);
                  }}
                >
                  取消
                </button>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground">
              点击输入框，按下组合键（需包含字母/数字/功能键，如 Ctrl+Shift+T）
            </span>
          </div>

          {/* Autostart */}
          <div className="flex items-center justify-between">
            <Label className="text-xs">开机自启动</Label>
            <Switch checked={autostart} onCheckedChange={setAutostart} />
          </div>

          {/* Clipboard */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label className="text-xs">自动读取剪贴板</Label>
              <span className="text-[10px] text-muted-foreground">聚焦时自动填入剪贴板内容</span>
            </div>
            <Switch checked={clipboardAutoRead} onCheckedChange={setClipboardAutoRead} />
          </div>

          {/* Custom Prompts */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">自定义提示词</Label>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5" onClick={handleAddPrompt}>
                <Plus className="size-3" />
                添加
              </Button>
            </div>

            {customPrompts.length === 0 && !showPromptEditor && (
              <p className="text-[10px] text-muted-foreground">
                添加自定义提示词，创建专属功能标签页
              </p>
            )}

            <div className="flex flex-col gap-1">
              {customPrompts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1.5"
                >
                  <span className="flex-1 truncate text-xs">{p.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0"
                    onClick={() => handleEditPrompt(p)}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0"
                    onClick={() => handleDeletePrompt(p.id)}
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            {showPromptEditor && editingPrompt && (
              <div className="space-y-2 rounded-md border p-2.5">
                <Input
                  placeholder="名称（如：代码解释器）"
                  value={editingPrompt.name}
                  onChange={(e) =>
                    setEditingPrompt({ ...editingPrompt, name: e.target.value })
                  }
                  className="h-7 text-xs"
                />
                <Textarea
                  placeholder="系统提示词（System Prompt）"
                  value={editingPrompt.system_prompt}
                  onChange={(e) =>
                    setEditingPrompt({ ...editingPrompt, system_prompt: e.target.value })
                  }
                  className="min-h-16 text-xs"
                />
                <Input
                  placeholder="输入框占位提示（可选）"
                  value={editingPrompt.placeholder}
                  onChange={(e) =>
                    setEditingPrompt({ ...editingPrompt, placeholder: e.target.value })
                  }
                  className="h-7 text-xs"
                />
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => {
                      setShowPromptEditor(false);
                      setEditingPrompt(null);
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 gap-1 text-xs"
                    onClick={handleSavePrompt}
                    disabled={!editingPrompt.name.trim() || !editingPrompt.system_prompt.trim()}
                  >
                    <Check className="size-3" />
                    保存
                  </Button>
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="shrink-0 border-t px-4 py-2.5">
          <Button className="w-full h-8 text-xs" onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存配置"}
          </Button>
        </div>
      </div>
    </div>
  );
}
