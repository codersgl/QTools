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
import { PROVIDERS, supportsThinking } from "@/services/api";
import { parseTemplateVariables } from "@/lib/template";
import { THINKING_OPTIONS, type AppConfig, type CustomPrompt, type ThinkingMode } from "@/types";

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

/** 只比较可编辑字段，顺序无关；window_x/window_y 由 native 维护，不算脏。 */
function isDirty(baseline: AppConfig, draft: AppConfig): boolean {
  const fields: (keyof AppConfig)[] = [
    "provider",
    "model",
    "custom_model",
    "theme",
    "autostart",
    "shortcut",
    "clipboard_auto_read",
  ];
  if (fields.some((f) => baseline[f] !== draft[f])) return true;
  return JSON.stringify(baseline.custom_prompts) !== JSON.stringify(draft.custom_prompts);
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
  const [notice, setNotice] = useState("");

  const [recording, setRecording] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<CustomPrompt | null>(null);
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  const recordRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baselineRef = useRef<AppConfig | null>(null);
  const shortcutBeforeRecordRef = useRef("Alt+Space");
  /** 用于丢弃过期的 has_api_key 异步结果。 */
  const providerRef = useRef(provider);
  providerRef.current = provider;

  function setProviderKeyState(queryProvider: string, keyExists: boolean) {
    if (providerRef.current !== queryProvider) return;
    setHasKey(keyExists);
  }

  useEffect(() => {
    if (open) loadSettings();
  }, [open]);

  // 面板所在窗口无边框且会因失焦隐藏，Esc 是用户预期的关闭方式
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      attemptClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!recording) return;
    recordRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        setShortcut(shortcutBeforeRecordRef.current);
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
        } else {
          // 之前按无响应的键只会静默卡在录制态，这里给出原因
          setNotice("该键无法作为快捷键，请使用字母、数字或功能键");
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [recording]);

  function draftConfig(): AppConfig {
    return {
      provider,
      model,
      custom_model: customModel,
      theme,
      custom_prompts: customPrompts,
      autostart,
      shortcut,
      window_x: baselineRef.current?.window_x ?? null,
      window_y: baselineRef.current?.window_y ?? null,
      clipboard_auto_read: clipboardAutoRead,
    };
  }

  function attemptClose() {
    if (recording) {
      setRecording(false);
      setShortcut(shortcutBeforeRecordRef.current);
    }
    if (baselineRef.current && isDirty(baselineRef.current, draftConfig())) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function loadSettings() {
    const config = (await invoke("get_config")) as AppConfig;
    const autoEnabled = (await invoke("is_autostart_enabled")) as boolean;
    const providerKnown = PROVIDERS.some((p) => p.id === config.provider);
    const effectiveProvider = providerKnown ? config.provider : "deepseek";
    const modelList = PROVIDERS.find((p) => p.id === effectiveProvider)?.models ?? [];
    // 配置里可能残留别的供应商的模型名（手工编辑、或供应商列表变更）
    const effectiveModel =
      config.model === "custom" || modelList.includes(config.model)
        ? config.model
        : modelList[0];
    const keySet = (await invoke("has_api_key", { provider: effectiveProvider }).catch(
      () => false,
    )) as boolean;

    setProvider(effectiveProvider);
    setModel(effectiveModel);
    setCustomModel(config.custom_model);
    setTheme(config.theme || "system");
    setShortcut(config.shortcut || "Alt+Space");
    setAutostart(autoEnabled);
    setClipboardAutoRead(config.clipboard_auto_read !== false);
    setCustomPrompts(config.custom_prompts || []);
    setHasKey(keySet);
    setApiKeyInput("");
    setError(
      providerKnown
        ? ""
        : `配置中的供应商「${config.provider}」不可用，已回退到 DeepSeek`,
    );
    setNotice("");
    setRecording(false);
    setConfirmDiscard(false);
    setShowPromptEditor(false);
    setEditingPrompt(null);
    baselineRef.current = {
      ...config,
      provider: effectiveProvider,
      model: effectiveModel,
      autostart: autoEnabled,
    };
  }

  async function handleSave() {
    // loadSettings 还没跑完（或中途失败）时表单里全是默认值，此时保存会用默认值
    // 覆盖掉真实的 provider/model/theme 并清空自定义提示词
    if (!baselineRef.current) {
      setError("配置尚未加载完成，请稍候再试");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    if (model === "custom" && !customModel.trim()) {
      setError("请输入自定义模型名称");
      setSaving(false);
      return;
    }

    try {
      // 顺序刻意安排成「失败时不会让配置与系统状态分叉」：
      // Key 与快捷键、自启动先落到各自的位置，全部成功后才写 config.json。
      if (apiKeyInput.trim()) {
        await invoke("set_api_key", { provider, key: apiKeyInput.trim() });
        setHasKey(true);
      }

      const status = (await invoke("shortcut_status")) as { active: string };
      if (shortcut !== status.active) {
        await invoke("change_shortcut", { new: shortcut });
      }

      if (autostart !== (await invoke("is_autostart_enabled"))) {
        await invoke("set_autostart", { enable: autostart });
      }

      // 窗口位置由 native 在失焦时写入，保存当下重新读取，绝不拿前端状态回填
      const current = (await invoke("get_config")) as AppConfig;
      await invoke("save_config", {
        config: {
          ...draftConfig(),
          window_x: current.window_x,
          window_y: current.window_y,
        },
      });
    } catch (e) {
      // 配置未写入，界面保持打开让用户改；这里不再刷新主界面避免显示半套状态
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      return;
    }

    setSaving(false);
    onConfigSaved();
    onClose();
  }

  async function handleDeleteKey() {
    try {
      await invoke("delete_api_key", { provider });
      setHasKey(false);
      setApiKeyInput("");
      setNotice("删除的 API Key 在点击「保存配置」后才会生效");
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
      thinking: "auto",
    });
    setShowPromptEditor(true);
  }

  function handleEditPrompt(p: CustomPrompt) {
    setEditingPrompt({ ...p });
    setShowPromptEditor(true);
  }

  function handleSavePrompt() {
    if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.system_prompt.trim()) return;
    const normalized = {
      ...editingPrompt,
      name: editingPrompt.name.trim(),
      system_prompt: editingPrompt.system_prompt,
      placeholder: editingPrompt.placeholder.trim(),
    };
    const exists = customPrompts.some((p) => p.id === normalized.id);
    setCustomPrompts(
      exists
        ? customPrompts.map((p) => (p.id === normalized.id ? normalized : p))
        : [...customPrompts, normalized],
    );
    setShowPromptEditor(false);
    setEditingPrompt(null);
  }

  function handleDeletePrompt(id: string) {
    setCustomPrompts(customPrompts.filter((p) => p.id !== id));
    setNotice("自定义提示词的改动需点击「保存配置」才会生效");
  }

  if (!open) return null;

  const currentProvider = PROVIDERS.find((p) => p.id === provider);
  const modelList = currentProvider?.models ?? [];

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="QTools 设置"
        tabIndex={-1}
        className="flex max-h-[90vh] w-[92%] max-w-sm flex-col overflow-hidden rounded-lg border bg-background shadow-lg outline-none"
      >
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">设置</h2>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={attemptClose}>
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Provider & Model */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-provider" className="text-xs">供应商</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                if (!v) return;
                setProvider(v);
                const p = PROVIDERS.find((p) => p.id === v);
                if (p) {
                  setModel(p.models[0]);
                  setCustomModel("");
                }
                setApiKeyInput("");
                setHasKey(false);
                // 每个供应商的 Key 单独存放，切过去时要把已有的查出来
                void invoke("has_api_key", { provider: v })
                  .then((set) => setProviderKeyState(v, Boolean(set)))
                  .catch(() => {});
              }}
            >
              <SelectTrigger id="settings-provider" className="h-8 w-full text-xs">
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
            <span className="text-[10px] text-muted-foreground">
              切换供应商会清空下方 API Key 输入框，各供应商的 Key 独立存储
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-model" className="text-xs">模型</Label>
            <Select
              value={modelList.includes(model) ? model : "custom"}
              onValueChange={(v) => {
                if (!v) return;
                setModel(v);
                if (v !== "custom") setCustomModel("");
              }}
            >
              <SelectTrigger id="settings-model" className="h-8 w-full text-xs">
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
            <Label htmlFor="settings-apikey" className="text-xs">API Key</Label>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <KeyRound className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="settings-apikey"
                  type={showKey ? "text" : "password"}
                  placeholder={hasKey ? "已配置，输入新 Key 覆盖" : "输入 API Key"}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 pl-7 pr-7 text-xs"
                />
                <button
                  type="button"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
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
            <Label htmlFor="settings-theme" className="text-xs">主题</Label>
            <Select value={theme} onValueChange={(v) => v && setTheme(v)}>
              <SelectTrigger id="settings-theme" className="h-8 w-full text-xs">
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
              onClick={() => {
                if (recording) return;
                shortcutBeforeRecordRef.current = shortcut;
                setNotice("");
                setRecording(true);
              }}
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
                    setShortcut(shortcutBeforeRecordRef.current);
                  }}
                >
                  取消
                </button>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground">
              点击输入框，按下组合键（需包含字母/数字/功能键，如 Ctrl+Shift+T）。
              新组合注册成功后才会替换旧组合，旧组合在此之前仍然有效。
            </span>
          </div>

          {/* Autostart */}
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-autostart" className="text-xs">开机自启动</Label>
            <Switch
              id="settings-autostart"
              checked={autostart}
              onCheckedChange={setAutostart}
            />
          </div>

          {/* Clipboard */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor="settings-clipboard" className="text-xs">自动读取剪贴板</Label>
              <span className="text-[10px] text-muted-foreground">
                聚焦时填入剪贴板内容；未编辑过的内容会在窗口隐藏时清除
              </span>
            </div>
            <Switch
              id="settings-clipboard"
              checked={clipboardAutoRead}
              onCheckedChange={setClipboardAutoRead}
            />
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
                <div className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
                  <p>
                    模板变量：<code className="font-mono">{"{{input}}"}</code> 用户输入插槽（含它时整条模板作为单条消息发送）；
                    <code className="font-mono">{"{{变量名}}"}</code> 文本参数；
                    <code className="font-mono">{"{{变量名:选项1|选项2}}"}</code> 下拉参数。
                  </p>
                  {parseTemplateVariables(editingPrompt.system_prompt).length > 0 && (
                    <p>
                      已识别：
                      {parseTemplateVariables(editingPrompt.system_prompt)
                        .map((v) => v.name)
                        .join("、")}
                    </p>
                  )}
                </div>
                <Input
                  placeholder="输入框占位提示（可选）"
                  value={editingPrompt.placeholder}
                  onChange={(e) =>
                    setEditingPrompt({ ...editingPrompt, placeholder: e.target.value })
                  }
                  className="h-7 text-xs"
                />
                <div className="flex items-center gap-1.5">
                  <Label className="shrink-0 text-[10px] text-muted-foreground">
                    思考
                  </Label>
                  <Select
                    value={editingPrompt.thinking ?? "auto"}
                    onValueChange={(v) =>
                      v && setEditingPrompt({ ...editingPrompt, thinking: v as ThinkingMode })
                    }
                  >
                    <SelectTrigger
                      className="h-7 flex-1 gap-1 text-xs"
                      disabled={!supportsThinking(provider)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {THINKING_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {supportsThinking(provider)
                    ? "改写、摘要、翻译这类简单任务选「关闭思考」可以省掉大部分等待时间；需要推理的再调成轻量或充分。"
                    : "当前供应商的模型列表不支持思考开关，该设置不会生效。"}
                </p>
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

          {notice && !error && <p className="text-xs text-muted-foreground">{notice}</p>}
          {error && <p className="text-xs break-words text-destructive">{error}</p>}
        </div>

        <div className="shrink-0 border-t px-4 py-2.5">
          {confirmDiscard ? (
            <div className="flex items-center gap-1.5">
              <span className="flex-1 text-[10px] text-muted-foreground">
                有未保存的修改
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setConfirmDiscard(false)}
              >
                继续编辑
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                onClick={onClose}
              >
                放弃
              </Button>
            </div>
          ) : (
            <Button className="w-full h-8 text-xs" onClick={handleSave} disabled={saving}>
              {saving ? "保存中..." : "保存配置"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
