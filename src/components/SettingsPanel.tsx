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
import { UpdateSection } from "@/components/UpdateSection";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
  /** 主程序启动时后台检查已确认存在新版本，更新区块免去手动点击。 */
  hasUpdate: boolean;
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
function isConfigDirty(baseline: AppConfig, draft: AppConfig): boolean {
  const fields: (keyof AppConfig)[] = [
    "provider",
    "model",
    "custom_model",
    "theme",
    "autostart",
    "shortcut",
    "clipboard_auto_read",
    "auto_check_updates",
  ];
  if (fields.some((f) => baseline[f] !== draft[f])) return true;
  return JSON.stringify(baseline.custom_prompts) !== JSON.stringify(draft.custom_prompts);
}

/** 正在编辑的提示词是否与打开编辑器时的内容不同。 */
function isPromptDirty(original: CustomPrompt | null, draft: CustomPrompt): boolean {
  if (!original) {
    return Boolean(draft.name.trim() || draft.system_prompt.trim() || draft.placeholder.trim());
  }
  return (
    original.name !== draft.name ||
    original.system_prompt !== draft.system_prompt ||
    original.placeholder !== draft.placeholder ||
    (original.thinking ?? "auto") !== (draft.thinking ?? "auto")
  );
}

/** 去掉首尾空白，并保证 thinking 落在联合类型范围内。 */
function normalizePrompt(prompt: CustomPrompt): CustomPrompt {
  return {
    ...prompt,
    name: prompt.name.trim(),
    system_prompt: prompt.system_prompt.trim(),
    placeholder: prompt.placeholder.trim(),
    thinking: prompt.thinking ?? "auto",
  };
}

function upsertPrompt(list: CustomPrompt[], prompt: CustomPrompt): CustomPrompt[] {
  const exists = list.some((p) => p.id === prompt.id);
  return exists ? list.map((p) => (p.id === prompt.id ? prompt : p)) : [...list, prompt];
}

export function SettingsPanel({ open, onClose, onConfigSaved, hasUpdate }: SettingsPanelProps) {
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
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 被标记删除、但尚未保存的 API Key 所属供应商。 */
  const [pendingKeyDelete, setPendingKeyDelete] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<CustomPrompt | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<CustomPrompt | null>(null);
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  const recordRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baselineRef = useRef<AppConfig | null>(null);
  const shortcutBeforeRecordRef = useRef("Alt+Space");
  /** 丢弃过期的 loadSettings 结果（例如快速关开面板）。 */
  const loadSeqRef = useRef(0);
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

  // 面板所在窗口无边框且会因失焦隐藏，Esc 是用户预期的关闭方式。
  // 按层级逐级退出：录制 → 放弃确认 → 提示词编辑 → 关闭面板。
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      if (recording) {
        setRecording(false);
        setShortcut(shortcutBeforeRecordRef.current);
        return;
      }
      if (confirmDiscard) {
        setConfirmDiscard(false);
        return;
      }
      if (showPromptEditor) {
        closePromptEditor();
        return;
      }
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
      if (["Control", "Alt", "Shift", "Meta"].includes(key)) return;
      const keyName = toTauriKeyName(key);
      if (!keyName) {
        // 之前按无响应的键只会静默卡在录制态，这里给出原因
        setNotice("该键无法作为快捷键，请使用字母、数字或功能键");
        return;
      }
      // 功能键可以单独绑定；其他键必须带至少一个修饰键，否则极易和输入冲突
      const standalone = /^F\d{1,2}$/.test(keyName);
      if (parts.length === 0 && !standalone) {
        setNotice("请至少按住一个修饰键（Ctrl / Alt / Shift / Win）");
        return;
      }
      parts.push(keyName);
      setShortcut(parts.join("+"));
      setRecording(false);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [recording]);

  function draftConfig(prompts: CustomPrompt[] = customPrompts): AppConfig {
    return {
      provider,
      model,
      custom_model: customModel,
      theme,
      custom_prompts: prompts,
      autostart,
      shortcut,
      window_x: baselineRef.current?.window_x ?? null,
      window_y: baselineRef.current?.window_y ?? null,
      clipboard_auto_read: clipboardAutoRead,
      auto_check_updates: autoCheckUpdates,
    };
  }

  /** 除配置字段外，未保存的 Key 输入/删除与提示词草稿也算改动。 */
  function hasDraftChanges(): boolean {
    const baseline = baselineRef.current;
    if (!baseline) return false;
    if (isConfigDirty(baseline, draftConfig())) return true;
    if (apiKeyInput.trim() || pendingKeyDelete) return true;
    if (showPromptEditor && editingPrompt) {
      return isPromptDirty(editingOriginal, editingPrompt);
    }
    return false;
  }

  function closePromptEditor() {
    setShowPromptEditor(false);
    setEditingPrompt(null);
    setEditingOriginal(null);
  }

  function attemptClose() {
    // 保存过程中不要关闭面板，避免配置写了一半又被卸载
    if (saving) return;
    if (recording) {
      setRecording(false);
      setShortcut(shortcutBeforeRecordRef.current);
    }
    // 已在「放弃修改？」确认态时，再点遮罩或按 Esc 表示取消放弃，留在面板里
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (hasDraftChanges()) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function loadSettings() {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const config = (await invoke("get_config")) as AppConfig;
      if (seq !== loadSeqRef.current) return;
      const providerKnown = PROVIDERS.some((p) => p.id === config.provider);
      const effectiveProvider = providerKnown ? config.provider : "deepseek";
      const modelList = PROVIDERS.find((p) => p.id === effectiveProvider)?.models ?? [];
      // 配置里可能残留别的供应商的模型名（手工编辑、或供应商列表变更）
      const modelFallback = config.model !== "custom" && !modelList.includes(config.model);
      const effectiveModel = modelFallback ? modelList[0] : config.model;
      const [autoEnabled, keySet] = await Promise.all([
        invoke<boolean>("is_autostart_enabled").catch(() => false),
        invoke<boolean>("has_api_key", { provider: effectiveProvider }).catch(() => false),
      ]);
      if (seq !== loadSeqRef.current) return;

      setProvider(effectiveProvider);
      setModel(effectiveModel);
      setCustomModel(config.custom_model);
      setTheme(config.theme || "system");
      setShortcut(config.shortcut || "Alt+Space");
      setAutostart(Boolean(autoEnabled));
      setClipboardAutoRead(config.clipboard_auto_read !== false);
      setAutoCheckUpdates(config.auto_check_updates !== false);
      setCustomPrompts(config.custom_prompts || []);
      setHasKey(Boolean(keySet));
      setApiKeyInput("");
      setPendingKeyDelete(null);
      setError(
        providerKnown
          ? ""
          : `配置中的供应商「${config.provider}」不可用，已回退到 DeepSeek`,
      );
      setNotice(
        modelFallback
          ? `模型「${config.model}」不在 ${effectiveProvider} 的列表里，已回退为 ${effectiveModel}`
          : "",
      );
      setRecording(false);
      setConfirmDiscard(false);
      closePromptEditor();
      baselineRef.current = {
        ...config,
        provider: effectiveProvider,
        model: effectiveModel,
        autostart: Boolean(autoEnabled),
      };
    } catch (e) {
      if (seq === loadSeqRef.current) {
        setError(`读取配置失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }

  async function handleSave() {
    // loadSettings 还没跑完（或中途失败）时表单里全是默认值，此时保存会用默认值
    // 覆盖掉真实的 provider/model/theme 并清空自定义提示词
    if (!baselineRef.current) {
      setError("配置尚未加载完成，请稍候再试");
      return;
    }
    if (loading) return;

    // 编辑器里还开着的内容直接一起提交，避免点了「保存配置」却把草稿丢掉
    let prompts = customPrompts;
    if (showPromptEditor && editingPrompt) {
      const normalized = normalizePrompt(editingPrompt);
      if (!normalized.name || !normalized.system_prompt) {
        setError("提示词编辑未完成：请填写名称和系统提示词，或先取消编辑");
        return;
      }
      if (
        customPrompts.some(
          (p) => p.id !== normalized.id && p.name === normalized.name,
        )
      ) {
        setError(`已存在同名标签页「${normalized.name}」，请换一个名称`);
        return;
      }
      prompts = upsertPrompt(customPrompts, normalized);
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
      if (apiKeyInput.trim()) {
        await invoke("set_api_key", { provider, key: apiKeyInput.trim() });
        setHasKey(true);
      } else if (pendingKeyDelete) {
        await invoke("delete_api_key", { provider });
        setHasKey(false);
      }

      // 只有用户这次真的改过快捷键才去动全局注册：配置里的旧值与实际生效值
      // 不一致（启动时被占用而回落）时，保存主题/模型之类的改动不该被它卡住。
      const baseline = baselineRef.current;
      if (!baseline || shortcut !== baseline.shortcut) {
        await invoke("change_shortcut", { new: shortcut });
      }

      const autoStarted = (await invoke<boolean>("is_autostart_enabled").catch(
        () => false,
      )) as boolean;
      if (autostart !== autoStarted) {
        await invoke("set_autostart", { enable: autostart });
      }

      // 窗口位置由 native 在失焦时写入，保存当下重新读取，绝不拿前端状态回填
      const current = (await invoke("get_config")) as AppConfig;
      await invoke("save_config", {
        config: {
          ...draftConfig(prompts),
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

    setCustomPrompts(prompts);
    setApiKeyInput("");
    setPendingKeyDelete(null);
    closePromptEditor();
    setSaving(false);
    onConfigSaved();
    onClose();
  }

  function handleDeleteKey() {
    // 只做标记，真正删除要等「保存配置」；关掉面板、点放弃都不会丢 Key
    setPendingKeyDelete(provider);
    setHasKey(false);
    setApiKeyInput("");
    setError("");
    setNotice("已标记删除，保存配置后才会真正删除；直接关闭面板不会改动 Key");
  }

  function handleAddPrompt() {
    if (showPromptEditor) return;
    setEditingOriginal(null);
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
    setEditingOriginal({ ...p });
    setEditingPrompt({ ...p });
    setShowPromptEditor(true);
  }

  function handleSavePrompt() {
    if (!editingPrompt) return;
    const normalized = normalizePrompt(editingPrompt);
    if (!normalized.name || !normalized.system_prompt) return;
    if (
      customPrompts.some((p) => p.id !== normalized.id && p.name === normalized.name)
    ) {
      setError(`已存在同名标签页「${normalized.name}」，请换一个名称`);
      return;
    }
    setCustomPrompts(upsertPrompt(customPrompts, normalized));
    setError("");
    closePromptEditor();
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
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label="关闭设置"
            onClick={attemptClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div
          className="flex-1 space-y-4 overflow-y-auto p-4"
          aria-busy={loading || undefined}
        >
          {/* Provider & Model */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-provider" className="text-xs">供应商</Label>
            <Select
              value={provider}
              items={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
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
                // 删除标记只对标记时的供应商有效，切换后即作废
                setPendingKeyDelete(null);
                // 每个供应商的 Key 单独存放，切过去时要把已有的查出来
                void invoke<boolean>("has_api_key", { provider: v })
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
              items={[
                ...modelList.map((m) => ({ value: m, label: m })),
                { value: "custom", label: "自定义..." },
              ]}
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
                  onChange={(e) => {
                    setApiKeyInput(e.target.value);
                    // 输入新 Key 即视为撤销刚才的删除标记
                    if (e.target.value.trim()) setPendingKeyDelete(null);
                  }}
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
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 shrink-0"
                  aria-label="删除 API Key"
                  title="删除 API Key（保存配置后生效）"
                  onClick={handleDeleteKey}
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              )}
            </div>
            {hasKey && !apiKeyInput && !pendingKeyDelete && (
              <span className="text-[10px] text-green-600">已安全存储在系统凭据管理器</span>
            )}
            {pendingKeyDelete === provider && (
              <div className="flex items-center gap-2 text-[10px] text-destructive">
                <span className="flex-1">已标记删除该供应商的 API Key，保存后生效</span>
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 hover:opacity-80"
                  onClick={() => {
                    void invoke<boolean>("has_api_key", { provider })
                      .then((set) => setHasKey(Boolean(set)))
                      .catch(() => {});
                    setPendingKeyDelete(null);
                    setNotice("");
                  }}
                >
                  撤销
                </button>
              </div>
            )}
          </div>

          {/* Theme */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-theme" className="text-xs">主题</Label>
            <Select
              value={theme}
              items={THEMES.map((t) => ({ value: t.id, label: t.name }))}
              onValueChange={(v) => v && setTheme(v)}
            >
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
              role="button"
              tabIndex={0}
              aria-label="录制新的唤起快捷键"
              className={`flex h-8 items-center rounded-md border px-2.5 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                recording ? "border-primary bg-primary/5" : "bg-background"
              }`}
              onClick={() => {
                if (recording) return;
                shortcutBeforeRecordRef.current = shortcut;
                setNotice("");
                setRecording(true);
              }}
              onKeyDown={(e) => {
                if (recording) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  shortcutBeforeRecordRef.current = shortcut;
                  setNotice("");
                  setRecording(true);
                }
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
              点击或按 Enter 开始录制，按下组合键完成（如 Ctrl+Shift+T），F1–F12 可单独使用。
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

          {/* Update check */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor="settings-auto-update" className="text-xs">启动时检查更新</Label>
              <span className="text-[10px] text-muted-foreground">
                启动后向 GitHub Releases 静默查一次，有新版时在齿轮上标记；下方仍可手动检查
              </span>
            </div>
            <Switch
              id="settings-auto-update"
              checked={autoCheckUpdates}
              onCheckedChange={setAutoCheckUpdates}
            />
          </div>

          {/* Custom Prompts */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">自定义提示词</Label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5"
                onClick={handleAddPrompt}
                disabled={showPromptEditor}
                title={showPromptEditor ? "请先保存或取消当前编辑" : "添加自定义提示词"}
              >
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
                    aria-label={`编辑提示词 ${p.name}`}
                    onClick={() => handleEditPrompt(p)}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0"
                    aria-label={`删除提示词 ${p.name}`}
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
                  className="max-h-40 min-h-16 overflow-y-auto text-xs"
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
                    items={THINKING_OPTIONS}
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
                    onClick={closePromptEditor}
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

          <UpdateSection autoCheck={hasUpdate} />
        </div>

        {/* 错误/提示固定在滚动区之外：此前它们排在最底部，用户点了保存
            失败后常常根本看不到原因 */}
        {(error || notice) && (
          <div className="shrink-0 border-t px-4 py-2">
            {error ? (
              <p role="alert" className="text-xs break-words text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs break-words text-muted-foreground">{notice}</p>
            )}
          </div>
        )}

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
                variant="ghost"
                className="h-7 text-xs text-destructive"
                onClick={onClose}
              >
                放弃
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSave}
                disabled={saving || loading}
              >
                保存
              </Button>
            </div>
          ) : (
            <Button
              className="w-full h-8 text-xs"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {loading ? "加载配置中..." : saving ? "保存中..." : "保存配置"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
