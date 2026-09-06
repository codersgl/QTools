import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Languages,
  Variable,
  Copy,
  Check,
  RotateCcw,
  Settings,
  AlertCircle,
  Square,
  MessageSquare,
  ClipboardPaste,
  GripHorizontal,
} from "lucide-react";
import { translateStream, generateNames, customPromptStream } from "@/services/api";
import { SettingsPanel } from "@/components/SettingsPanel";

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

function getEffectiveModel(config: AppConfig): string {
  return config.model === "custom" ? config.custom_model : config.model;
}

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    root.classList.toggle("dark", mq.matches);
  }
}

function TranslatePanel({
  config,
  getApiKey,
  clipboardText,
}: {
  config: AppConfig;
  getApiKey: () => Promise<string>;
  clipboardText: string;
}) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const prevClipRef = useRef("");

  useEffect(() => {
    if (clipboardText && clipboardText !== prevClipRef.current) {
      prevClipRef.current = clipboardText;
      if (!input) setInput(clipboardText);
    }
  }, [clipboardText, input]);

  async function handleTranslate() {
    if (!input.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setOutput("");
    setError("");
    try {
      const apiKey = await getApiKey();
      const stream = translateStream(
        config.provider,
        getEffectiveModel(config),
        apiKey,
        input,
        controller.signal,
      );
      let accumulated = "";
      for await (const chunk of stream) {
        accumulated += chunk;
        setOutput(accumulated);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "翻译失败");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setLoading(false);
  }

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard write failed
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        placeholder="输入要翻译的文本..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="min-h-20 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleTranslate();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={handleAbort}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleTranslate} disabled={!input.trim()}>
            <Languages className="size-3.5" />
            翻译
          </Button>
        )}
        {output && !loading && (
          <>
            <Button size="sm" variant="ghost" onClick={handleCopy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setInput("");
                setOutput("");
                setError("");
              }}
            >
              <RotateCcw className="size-3.5" />
              清空
            </Button>
          </>
        )}
        <span className="ml-auto text-xs text-muted-foreground">Ctrl+Enter 翻译</span>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </div>
      )}
      {output && (
        <>
          <Separator />
          <div className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed whitespace-pre-wrap">
            {output}
          </div>
        </>
      )}
    </div>
  );
}

function NamingPanel({
  config,
  getApiKey,
  clipboardText,
}: {
  config: AppConfig;
  getApiKey: () => Promise<string>;
  clipboardText: string;
}) {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<{ style: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const prevClipRef = useRef("");

  useEffect(() => {
    if (clipboardText && clipboardText !== prevClipRef.current) {
      prevClipRef.current = clipboardText;
      if (!input) setInput(clipboardText);
    }
  }, [clipboardText, input]);

  async function handleNaming() {
    if (!input.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setResults([]);
    setError("");
    try {
      const apiKey = await getApiKey();
      const res = await generateNames(
        config.provider,
        getEffectiveModel(config),
        apiKey,
        input,
        controller.signal,
      );
      setResults(res);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setLoading(false);
  }

  async function handleCopy(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard write failed
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        placeholder="输入中文含义或英文描述，如：用户登录..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="min-h-16 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleNaming();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={handleAbort}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleNaming} disabled={!input.trim()}>
            <Variable className="size-3.5" />
            生成命名
          </Button>
        )}
        {results.length > 0 && !loading && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setInput("");
              setResults([]);
            }}
          >
            <RotateCcw className="size-3.5" />
            清空
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">Ctrl+Enter 生成</span>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </div>
      )}
      {results.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            {results.map((r) => (
              <button
                key={r.style}
                className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/70"
                onClick={() => handleCopy(r.name)}
              >
                <Badge variant="secondary" className="text-[10px]">
                  {r.style}
                </Badge>
                <code className="flex-1 text-sm font-mono">{r.name}</code>
                <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  {copied === r.name ? (
                    <Check className="size-3.5 text-green-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CustomPromptPanel({
  config,
  getApiKey,
  prompt,
  clipboardText,
}: {
  config: AppConfig;
  getApiKey: () => Promise<string>;
  prompt: CustomPrompt;
  clipboardText: string;
}) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const prevClipRef = useRef("");

  useEffect(() => {
    if (clipboardText && clipboardText !== prevClipRef.current) {
      prevClipRef.current = clipboardText;
      if (!input) setInput(clipboardText);
    }
  }, [clipboardText, input]);

  async function handleRun() {
    if (!input.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setOutput("");
    setError("");
    try {
      const apiKey = await getApiKey();
      const stream = customPromptStream(
        config.provider,
        getEffectiveModel(config),
        apiKey,
        prompt.system_prompt,
        input,
        controller.signal,
      );
      let accumulated = "";
      for await (const chunk of stream) {
        accumulated += chunk;
        setOutput(accumulated);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "执行失败");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setLoading(false);
  }

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard write failed
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        placeholder={prompt.placeholder || `输入内容...`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="min-h-16 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleRun();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={handleAbort}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleRun} disabled={!input.trim()}>
            <MessageSquare className="size-3.5" />
            执行
          </Button>
        )}
        {output && !loading && (
          <>
            <Button size="sm" variant="ghost" onClick={handleCopy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setInput("");
                setOutput("");
                setError("");
              }}
            >
              <RotateCcw className="size-3.5" />
              清空
            </Button>
          </>
        )}
        <span className="ml-auto text-xs text-muted-foreground">Ctrl+Enter 执行</span>
      </div>
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </div>
      )}
      {output && (
        <>
          <Separator />
          <div className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed whitespace-pre-wrap">
            {output}
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<AppConfig>({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    custom_model: "",
    theme: "system",
    custom_prompts: [],
    autostart: false,
    shortcut: "Alt+Space",
    window_x: null,
    window_y: null,
    clipboard_auto_read: true,
  });
  const [hasKey, setHasKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const prevThemeRef = useRef("");
  const clipboardAutoReadRef = useRef(true);

  const refreshStatus = useCallback(async () => {
    const cfg = (await invoke("get_config")) as AppConfig;
    const keySet = (await invoke("has_api_key", { provider: cfg.provider })) as boolean;
    setConfig(cfg);
    setHasKey(keySet);
    clipboardAutoReadRef.current = cfg.clipboard_auto_read;
    applyTheme(cfg.theme || "system");
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused && clipboardAutoReadRef.current) {
        invoke("get_clipboard_text").then((text) => {
          if (typeof text === "string" && text.trim()) {
            setClipboardText(text);
          }
        }).catch(() => {});
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (config.theme !== prevThemeRef.current) {
      prevThemeRef.current = config.theme;
      applyTheme(config.theme || "system");
    }
  }, [config.theme]);

  async function getApiKey(): Promise<string> {
    const key = (await invoke("get_api_key", { provider: config.provider })) as string | null;
    if (!key) throw new Error("请先在设置中配置 API Key");
    return key;
  }

  return (
    <div className="relative flex h-screen flex-col bg-background p-4">
      <div
        className="mb-2 flex items-center gap-2 select-none cursor-move"
        onMouseDown={async (e) => {
          if (e.buttons === 1 && !(e.target as HTMLElement).closest('button')) {
            await invoke("set_dragging", { dragging: true });
            try {
              await getCurrentWindow().startDragging();
            } catch {
              // drag cancelled or failed
            } finally {
              await invoke("set_dragging", { dragging: false });
            }
          }
        }}
      >
        <GripHorizontal className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-semibold">QTools</span>
        <div className="flex-1" />
        {clipboardText && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-1.5 text-xs text-muted-foreground"
            onClick={() => {
              setClipboardText("");
            }}
          >
            <ClipboardPaste className="size-3" />
            已读取剪贴板
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => setShowSettings(true)}
        >
          <Settings className="size-3.5" />
        </Button>
      </div>

      {!hasKey && (
        <div
          className="mb-2 cursor-pointer rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          onClick={() => setShowSettings(true)}
        >
          点击配置 API Key 后开始使用
        </div>
      )}

      <Tabs defaultValue="translate" className="flex flex-1 flex-col gap-3">
        <TabsList variant="default">
          <TabsTrigger value="translate">
            <Languages className="size-3.5" />
            翻译
          </TabsTrigger>
          <TabsTrigger value="naming">
            <Variable className="size-3.5" />
            命名
          </TabsTrigger>
          {config.custom_prompts.map((p) => (
            <TabsTrigger key={p.id} value={p.id}>
              <MessageSquare className="size-3.5" />
              {p.name}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="translate" className="flex-1 overflow-auto">
          <TranslatePanel config={config} getApiKey={getApiKey} clipboardText={clipboardText} />
        </TabsContent>
        <TabsContent value="naming" className="flex-1 overflow-auto">
          <NamingPanel config={config} getApiKey={getApiKey} clipboardText={clipboardText} />
        </TabsContent>
        {config.custom_prompts.map((p) => (
          <TabsContent key={p.id} value={p.id} className="flex-1 overflow-auto">
            <CustomPromptPanel config={config} getApiKey={getApiKey} prompt={p} clipboardText={clipboardText} />
          </TabsContent>
        ))}
      </Tabs>

      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onConfigSaved={refreshStatus}
      />
    </div>
  );
}

export default App;
