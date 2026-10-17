import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  X,
} from "lucide-react";
import {
  translateStream,
  generateNames,
  customPromptStream,
  resolveTranslateDirection,
  supportsThinking,
  type NamingResult,
  type StreamChunk,
  type TranslateDirection,
} from "@/services/api";
import { SettingsPanel } from "@/components/SettingsPanel";
import { missingTemplateVars, parseTemplateVariables } from "@/lib/template";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CONFIG,
  THINKING_OPTIONS,
  getEffectiveModel,
  type AppConfig,
  type CustomPrompt,
  type ThinkingMode,
} from "@/types";

/**
 * 结果区按需加载：react-markdown 与 remark 插件占主包大半体积，只在有输出时才用得上。
 * 必须声明在模块顶层——放进组件里会每次渲染生成新的 lazy 类型，子树被反复卸载重建。
 */
const OutputArea = lazy(() => import("@/components/OutputArea"));

const DIRECTION_OPTIONS: { value: TranslateDirection; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "zh2en", label: "中 → 英" },
  { value: "en2zh", label: "英 → 中" },
];

/** 思考档位选择。供应商不支持时不渲染，避免出现一个改了没有任何作用的开关。 */
function ThinkingSelect({
  providerId,
  value,
  onChange,
}: {
  providerId: string;
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
}) {
  if (!supportsThinking(providerId)) return null;
  return (
    <Select
      value={value}
      onValueChange={(v) => v && onChange(v as ThinkingMode)}
      items={THINKING_OPTIONS}
    >
      <SelectTrigger className="h-7 gap-1 text-xs" aria-label="思考档位">
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
  );
}

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    root.classList.toggle("dark", prefersDark().matches);
  }
}

function prefersDark(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/** 复制反馈：计时器统一回收，连续点击不会被上一次的计时提前清掉对勾。 */
function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function copy(text: string) {
    if (!text) return;
    // 每次尝试前清掉上一次的错误，否则一次失败会让错误行一直挂在那里
    setError("");
    try {
      await copyText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "复制失败");
    }
  }

  return { copied, error, copy };
}

/**
 * 请求互斥与取消的公共骨架。
 *
 * `begin()` 在已有请求在途时返回 null，这样键盘的 Ctrl+Enter 不会像以前那样
 * 静默中断上一次请求、丢掉已经流式返回的内容。
 */
function useRunGuard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // 面板被卸载（删除自定义提示词标签页、热更新）时中断在途请求，避免继续产生费用
  useEffect(() => () => abortRef.current?.abort(), []);

  const begin = useCallback(() => {
    if (abortRef.current) return null;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError("");
    return controller;
  }, []);

  const finish = useCallback((controller: AbortController) => {
    if (abortRef.current !== controller) return;
    abortRef.current = null;
    setLoading(false);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { loading, error, setError, begin, finish, stop };
}

function isAbort(e: unknown): boolean {
  // 只吞手动停止；超时由 api.ts 带着 TimeoutError 名称和可读文案抛出，需要显示
  return e instanceof DOMException && e.name === "AbortError";
}

/** 请求在途期间的秒数计时，用于把「不知道是在算还是卡住了」变成可见等待。 */
function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}

/**
 * 流式产出的三份状态：正文、思考过程（默认隐藏）、是否被长度上限截断。
 *
 * 思考分片的量极大，逐块 setState 会在一帧内触发多次面板重渲染；这里把累计
 * 结果放在 ref 中，用 rAF 合并成每帧最多一次提交。
 */
function useStreamOutput() {
  const [output, setOutput] = useState("");
  const [thinking, setThinking] = useState("");
  const [truncated, setTruncated] = useState(false);
  const latestRef = useRef({ answer: "", thought: "" });
  const frameRef = useRef(0);

  const flush = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    setOutput(latestRef.current.answer);
    setThinking(latestRef.current.thought);
  }, []);

  const schedule = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  async function consume(stream: AsyncGenerator<StreamChunk>) {
    latestRef.current = { answer: "", thought: "" };
    setOutput("");
    setThinking("");
    setTruncated(false);

    try {
      for await (const chunk of stream) {
        const current = latestRef.current;
        const next = {
          answer: current.answer + (chunk.content ?? ""),
          thought: current.thought + (chunk.reasoning ?? ""),
        };
        latestRef.current = next;
        if (chunk.truncated) setTruncated(true);
        if (next.answer !== current.answer || next.thought !== current.thought) {
          schedule();
        }
      }
    } finally {
      // 收尾/中止/被卸载时同步落一次，避免待执行的 rAF 丢掉最后几个字
      flush();
    }
  }

  function reset() {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    latestRef.current = { answer: "", thought: "" };
    setOutput("");
    setThinking("");
    setTruncated(false);
  }

  return { output, thinking, truncated, consume, reset };
}

function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 text-sm text-destructive">
      <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
      <span className="break-words">{message}</span>
    </div>
  );
}

interface PanelProps {
  config: AppConfig;
  getApiKey: () => Promise<string>;
  clipboardText: string;
  /** 每次窗口隐藏自增，用于清掉自动填入且未被编辑的剪贴板内容。 */
  wipeToken: number;
  /** 当前标签页是否处于选中状态：只有选中的面板才响应自动聚焦。 */
  active: boolean;
  /** 窗口重新获得焦点 / 切换标签页时自增，用于把光标送回输入框。 */
  focusToken: number;
}

/**
 * 唤起窗口后直接聚焦当前输入框：这是个键盘优先的浮窗，Alt+Space 之后
 * 若还要先点一下输入框才能打字，等于每次都多一步。
 */
function useFocusInput(active: boolean, focusToken: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTokenRef = useRef(focusToken);

  useEffect(() => {
    // 只在唤起/关闭设置这类「显式要求聚焦」的时机动作；单纯切标签不至于把
    // 焦点从标签栏抢走，键盘用户仍可用方向键继续切换。
    if (!active) {
      lastTokenRef.current = focusToken;
      return;
    }
    if (focusToken === lastTokenRef.current || focusToken === 0) return;
    lastTokenRef.current = focusToken;
    if (!document.hasFocus()) return;
    // 等一帧，让刚刚切换出来的标签面板完成可见性变更后再聚焦
    const frame = requestAnimationFrame(() => {
      if (document.hasFocus()) ref.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusToken]);

  return ref;
}

/**
 * 输入框 + 右下角快捷键提示。窗口只有 480×400，把提示塞进输入框内部，
 * 工具栏就能把有限宽度留给真正要点的按钮，不再横向溢出。
 */
function InputWithHint({
  hint,
  className,
  textareaRef,
  value,
  ...props
}: ComponentProps<"textarea"> & {
  hint: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        className={cn("max-h-32 overflow-y-auto pb-6", className)}
        {...props}
      />
      {!value && (
        <span className="pointer-events-none absolute right-2.5 bottom-1.5 text-[10px] text-muted-foreground/70">
          {hint}
        </span>
      )}
    </div>
  );
}

function useClipboardFill(clipboardText: string, wipeToken: number) {
  const [input, setInput] = useState("");
  const prevClipRef = useRef("");
  const autoFilledRef = useRef(false);

  useEffect(() => {
    if (!clipboardText || clipboardText === prevClipRef.current) return;
    prevClipRef.current = clipboardText;
    if (!input) {
      setInput(clipboardText);
      autoFilledRef.current = true;
    }
  }, [clipboardText, input]);

  // 密码管理器等敏感内容可能只是被顺手复制进来，用户没碰过就不要留在内存里
  useEffect(() => {
    if (wipeToken === 0 || !autoFilledRef.current) return;
    autoFilledRef.current = false;
    setInput("");
    // 不清掉这个的话，下次唤起读到同一份剪贴板会被判成「无变化」而不再填入
    prevClipRef.current = "";
  }, [wipeToken]);

  function changeInput(value: string) {
    autoFilledRef.current = false;
    setInput(value);
  }

  function clearInput() {
    autoFilledRef.current = false;
    setInput("");
  }

  return { input, changeInput, clearInput };
}

function TranslatePanel({
  config,
  getApiKey,
  clipboardText,
  wipeToken,
  active,
  focusToken,
}: PanelProps) {
  const { input, changeInput, clearInput } = useClipboardFill(clipboardText, wipeToken);
  const stream = useStreamOutput();
  const [direction, setDirection] = useState<TranslateDirection>("auto");
  // 翻译是机械任务，默认关掉思考，否则白等十几秒只为「想一下怎么翻」
  const [thinking, setThinking] = useState<ThinkingMode>("off");
  const { loading, error, setError, begin, finish, stop } = useRunGuard();
  const copy = useCopyFeedback();
  const elapsed = useElapsed(loading);
  const textareaRef = useFocusInput(active, focusToken);

  const resolved = input.trim() ? resolveTranslateDirection(input, direction) : null;

  async function handleTranslate() {
    if (!input.trim()) return;
    const controller = begin();
    if (!controller) return;
    try {
      const apiKey = await getApiKey();
      await stream.consume(
        translateStream(
          config.provider,
          getEffectiveModel(config),
          apiKey,
          input,
          controller.signal,
          direction,
          thinking,
        ),
      );
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof Error ? e.message : "翻译失败");
    } finally {
      finish(controller);
    }
  }

  function handleClear() {
    stop();
    clearInput();
    stream.reset();
    setError("");
  }

  return (
    <div className="flex flex-col gap-3">
      <InputWithHint
        textareaRef={textareaRef}
        hint="Ctrl+Enter 翻译"
        placeholder="输入要翻译的文本..."
        value={input}
        onChange={(e) => changeInput(e.target.value)}
        className="min-h-20 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleTranslate();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={stop}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleTranslate} disabled={!input.trim()}>
            <Languages className="size-3.5" />
            翻译
          </Button>
        )}
        <Select
          value={direction}
          onValueChange={(v) => v && setDirection(v as TranslateDirection)}
          items={DIRECTION_OPTIONS}
        >
          <SelectTrigger
            className="h-7 gap-1 text-xs"
            aria-label="翻译方向"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIRECTION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {input.trim() && resolved && (
          <span className="text-[10px] text-muted-foreground">
            {resolved === "zh2en" ? "→ 英文" : "→ 中文"}
          </span>
        )}
        <ThinkingSelect
          providerId={config.provider}
          value={thinking}
          onChange={setThinking}
        />
        {stream.output && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => copy.copy(stream.output)}
          >
            {copy.copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copy.copied ? "已复制" : "复制"}
          </Button>
        )}
        {(input || stream.output || stream.thinking) && (
          <Button
            size="sm"
            variant="ghost"
            className={stream.output ? undefined : "ml-auto"}
            onClick={handleClear}
          >
            <RotateCcw className="size-3.5" />
            清空
          </Button>
        )}
      </div>
      <ErrorLine message={error || copy.error} />
      {loading && !stream.output && !stream.thinking && (
        <p className="text-xs text-muted-foreground">等待模型响应 · {elapsed}s</p>
      )}
      <Suspense fallback={null}>
        <OutputArea
          thinking={stream.thinking}
          output={stream.output}
          truncated={stream.truncated}
          loading={loading}
          elapsed={elapsed}
        />
      </Suspense>
    </div>
  );
}

function NamingPanel({
  config,
  getApiKey,
  clipboardText,
  wipeToken,
  active,
  focusToken,
}: PanelProps) {
  const { input, changeInput, clearInput } = useClipboardFill(clipboardText, wipeToken);
  const [results, setResults] = useState<NamingResult[]>([]);
  const [copiedStyle, setCopiedStyle] = useState<string | null>(null);
  const { loading, error, setError, begin, finish, stop } = useRunGuard();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const textareaRef = useFocusInput(active, focusToken);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function handleNaming() {
    if (!input.trim()) return;
    const controller = begin();
    if (!controller) return;
    setResults([]);
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
      if (!isAbort(e)) setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      finish(controller);
    }
  }

  async function handleCopy(item: NamingResult) {
    try {
      await copyText(item.name);
      setCopiedStyle(item.style);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedStyle(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "复制失败");
    }
  }

  async function handleCopyAll() {
    try {
      await copyText(results.map((r) => `${r.style}: ${r.name}`).join("\n"));
      setCopiedStyle("__all__");
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedStyle(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "复制失败");
    }
  }

  function handleClear() {
    stop();
    clearInput();
    setResults([]);
    setError("");
  }

  return (
    <div className="flex flex-col gap-3">
      <InputWithHint
        textareaRef={textareaRef}
        hint="Ctrl+Enter 生成"
        placeholder="输入中文含义或英文描述，如：用户登录..."
        value={input}
        onChange={(e) => changeInput(e.target.value)}
        className="min-h-16 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleNaming();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={stop}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleNaming} disabled={!input.trim()}>
            <Variable className="size-3.5" />
            生成命名
          </Button>
        )}
        {results.length > 0 && (
          <Button size="sm" variant="ghost" onClick={handleCopyAll}>
            {copiedStyle === "__all__" ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            复制全部
          </Button>
        )}
        {(input || results.length > 0) && (
          <Button
            size="sm"
            variant="ghost"
            className={results.length > 0 ? undefined : "ml-auto"}
            onClick={handleClear}
          >
            <RotateCcw className="size-3.5" />
            清空
          </Button>
        )}
      </div>
      <ErrorLine message={error} />
      {results.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            {results.map((r) => (
              <button
                key={r.style}
                type="button"
                aria-label={`复制 ${r.style} 命名：${r.name}`}
                className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/70"
                onClick={() => handleCopy(r)}
              >
                <Badge variant="secondary" className="text-[10px]">
                  {r.style}
                </Badge>
                <code className="flex-1 text-sm font-mono break-all">{r.name}</code>
                <span
                  className={cn(
                    "text-xs text-muted-foreground transition-opacity",
                    copiedStyle === r.style
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  {copiedStyle === r.style ? (
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
  wipeToken,
  active,
  focusToken,
}: PanelProps & { prompt: CustomPrompt }) {
  const { input, changeInput, clearInput } = useClipboardFill(clipboardText, wipeToken);
  const stream = useStreamOutput();
  const { loading, error, setError, begin, finish, stop } = useRunGuard();
  const copy = useCopyFeedback();
  const elapsed = useElapsed(loading);
  const textareaRef = useFocusInput(active, focusToken);
  // 默认取这个提示词自己保存的档位；没有该字段的历史配置按模型默认处理
  const [thinking, setThinking] = useState<ThinkingMode>(prompt.thinking ?? "auto");

  useEffect(() => {
    setThinking(prompt.thinking ?? "auto");
  }, [prompt.id, prompt.thinking]);

  // 必须缓存：每次渲染都返回新数组会让下面的 effect 每帧重跑，
  // 而 effect 里又 setState，等价于无限重渲染（窗口直接卡死）。
  const templateVars = useMemo(
    () => parseTemplateVariables(prompt.system_prompt),
    [prompt.system_prompt],
  );
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setVarValues((prev) => {
      let changed = false;
      const next: Record<string, string> = { ...prev };
      for (const v of templateVars) {
        if (!(v.name in next)) {
          next[v.name] = v.options[0] ?? "";
          changed = true;
        }
      }
      // 没有新增变量时返回原对象，避免这次 effect 再触发一轮渲染
      return changed ? next : prev;
    });
  }, [templateVars]);

  function setVar(name: string, value: string) {
    setVarValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleRun() {
    if (!input.trim()) return;
    // 未填的变量以前会静默渲染成空串，产出「作为 工程师 翻译」这种坏提示词
    const missing = missingTemplateVars(prompt.system_prompt, varValues);
    if (missing.length > 0) {
      setError(`请先填写参数：${missing.join("、")}`);
      return;
    }
    const controller = begin();
    if (!controller) return;
    try {
      const apiKey = await getApiKey();
      await stream.consume(
        customPromptStream(
          config.provider,
          getEffectiveModel(config),
          apiKey,
          prompt.system_prompt,
          input,
          varValues,
          controller.signal,
          thinking,
        ),
      );
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof Error ? e.message : "执行失败");
    } finally {
      finish(controller);
    }
  }

  function handleClear() {
    stop();
    clearInput();
    stream.reset();
    setError("");
  }

  return (
    <div className="flex flex-col gap-3">
      {templateVars.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {templateVars.map((v) => (
            <div key={v.name} className="flex items-center gap-1.5">
              <Label className="text-[10px] text-muted-foreground">{v.name}</Label>
              {v.options.length > 0 ? (
                <Select
                  value={varValues[v.name] ?? v.options[0]}
                  onValueChange={(val) => val && setVar(v.name, val)}
                  items={v.options.map((o) => ({ value: o, label: o }))}
                >
                  <SelectTrigger className="h-7 w-auto min-w-20 gap-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {v.options.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={varValues[v.name] ?? ""}
                  onChange={(e) => setVar(v.name, e.target.value)}
                  placeholder={v.name}
                  className="h-7 w-28 text-xs"
                />
              )}
            </div>
          ))}
        </div>
      )}
      <InputWithHint
        textareaRef={textareaRef}
        hint="Ctrl+Enter 执行"
        placeholder={prompt.placeholder || "输入内容..."}
        value={input}
        onChange={(e) => changeInput(e.target.value)}
        className="min-h-16 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleRun();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <Button size="sm" variant="destructive" onClick={stop}>
            <Square className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={handleRun} disabled={!input.trim()}>
            <MessageSquare className="size-3.5" />
            执行
          </Button>
        )}
        <ThinkingSelect
          providerId={config.provider}
          value={thinking}
          onChange={setThinking}
        />
        {stream.output && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => copy.copy(stream.output)}
          >
            {copy.copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copy.copied ? "已复制" : "复制"}
          </Button>
        )}
        {(input || stream.output || stream.thinking) && (
          <Button
            size="sm"
            variant="ghost"
            className={stream.output ? undefined : "ml-auto"}
            onClick={handleClear}
          >
            <RotateCcw className="size-3.5" />
            清空
          </Button>
        )}
      </div>
      <ErrorLine message={error || copy.error} />
      {loading && !stream.output && !stream.thinking && (
        <p className="text-xs text-muted-foreground">等待模型响应 · {elapsed}s</p>
      )}
      <Suspense fallback={null}>
        <OutputArea
          thinking={stream.thinking}
          output={stream.output}
          truncated={stream.truncated}
          loading={loading}
          elapsed={elapsed}
        />
      </Suspense>
    </div>
  );
}

interface ShortcutStatus {
  active: string;
  error: string | null;
}

function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [hasKey, setHasKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState("translate");
  const [clipboardText, setClipboardText] = useState("");
  const [wipeToken, setWipeToken] = useState(0);
  /** 窗口重新获得焦点 / 关闭设置 / 切换标签页时自增，通知当前面板聚焦输入框。 */
  const [focusToken, setFocusToken] = useState(0);
  const [shortcutHint, setShortcutHint] = useState("");
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const clipboardAutoReadRef = useRef(true);

  const tabValues = useMemo(
    () => ["translate", "naming", ...config.custom_prompts.map((p) => p.id)],
    [config.custom_prompts],
  );

  // 在设置里删掉当前打开的自定义提示词后，Tabs 的选中值会指向一个已经不存在的
  // 面板，界面上就只剩一片空白。这里统一回退到「翻译」。
  useEffect(() => {
    if (!tabValues.includes(activeTab)) setActiveTab("translate");
  }, [activeTab, tabValues]);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setFocusToken((n) => n + 1);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const cfg = (await invoke("get_config")) as AppConfig;
      const [keySet, shortcut] = await Promise.all([
        invoke("has_api_key", { provider: cfg.provider }).catch(() => false),
        invoke("shortcut_status").catch(() => null),
      ]);
      setConfig(cfg);
      setHasKey(Boolean(keySet));
      setBannerDismissed(false);
      clipboardAutoReadRef.current = cfg.clipboard_auto_read;
      applyTheme(cfg.theme || "system");

      // 启动后静默探测一次，只用来点亮齿轮；下载交给设置面板，避免两处共享同一个更新资源
      if (cfg.auto_check_updates) {
        void check({ timeout: 10000 })
          .then((found) => {
            setHasUpdate(Boolean(found));
            if (found) void found.close().catch(() => {});
          })
          .catch(() => {
            // 离线、或最新 Release 还没有可用更新包时不打扰用户
          });
      } else {
        setHasUpdate(false);
      }

      const status = shortcut as ShortcutStatus | null;
      if (status?.error) {
        setShortcutHint(status.error);
      } else if (status && status.active && status.active !== cfg.shortcut) {
        setShortcutHint(`当前实际生效的唤起快捷键是 ${status.active}`);
      } else {
        setShortcutHint("");
      }
    } catch (e) {
      setShortcutHint(e instanceof Error ? e.message : "读取配置失败");
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          // 窗口被唤起 / 重新激活：把光标送回当前面板的输入框
          setFocusToken((n) => n + 1);
          if (clipboardAutoReadRef.current) {
            invoke("get_clipboard_text")
              .then((text) => {
                if (typeof text === "string" && text.trim()) setClipboardText(text);
              })
              .catch(() => {
                // 剪贴板里是图片/文件时原生读取会失败，这里静默跳过
              });
          }
        } else {
          // 失焦即隐藏：把没被编辑过的剪贴板内容从内存里抹掉
          setClipboardText("");
          setWipeToken((n) => n + 1);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    // 拖拽期间系统会捕获鼠标，mouseup 不一定回到页面，
    // 因此 native 侧在下次显示窗口时会兜底复位标志位。
    const onPointerUp = () => {
      void invoke("set_dragging", { dragging: false }).catch(() => {});
    };
    window.addEventListener("mouseup", onPointerUp);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, []);

  // 跟随系统主题时需要监听变更：应用常驻托盘，系统换主题后窗口不会自己重绘
  useEffect(() => {
    if (config.theme !== "system") {
      applyTheme(config.theme || "system");
      return;
    }
    const mq = prefersDark();
    const onChange = () => applyTheme("system");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [config.theme]);

  // Esc 收起浮窗：置顶小窗最自然的「退出」手势。设置面板打开时由面板自己处理。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || showSettings) return;
      const target = e.target as HTMLElement | null;
      // 下拉框/菜单正在用 Esc 关闭自己，别顺手把整个窗口也收起来
      if (
        target?.closest('[data-slot="select-content"], [role="listbox"], [role="menu"]') ||
        document.querySelector('[data-slot="select-content"]')
      ) {
        return;
      }
      e.preventDefault();
      void getCurrentWindow().hide();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [showSettings]);

  async function getApiKey(): Promise<string> {
    const key = (await invoke("get_api_key", { provider: config.provider })) as
      | string
      | null;
    if (!key) throw new Error("请先在设置中配置 API Key");
    return key;
  }

  return (
    <div className="relative flex h-screen flex-col bg-background p-4">
      {/* 设置打开时把背景设为 inert：焦点与 Tab 顺序都留在浮层里，避免
          键盘用户在看不见的控件上输入 */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        inert={showSettings || undefined}
        aria-hidden={showSettings || undefined}
      >
        <div
          data-tauri-drag-region
          className="mb-2 flex items-center gap-2 select-none cursor-move"
          onMouseDown={(e) => {
            if (e.buttons === 1 && !(e.target as HTMLElement).closest("button")) {
              void invoke("set_dragging", { dragging: true }).catch(() => {});
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
              title="点击忽略本次剪贴板内容"
              onClick={() => setClipboardText("")}
            >
              <ClipboardPaste className="size-3" />
              已读取剪贴板
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="relative h-7 w-7 p-0"
            aria-label={hasUpdate ? "设置（发现新版本，可更新）" : "设置"}
            title={hasUpdate ? "设置（发现新版本，可更新）" : "设置"}
            onClick={() => setShowSettings(true)}
          >
            <Settings className="size-3.5" />
            {hasUpdate && (
              <span
                aria-hidden
                className="absolute right-0 top-0 size-2 rounded-full bg-destructive ring-2 ring-background"
              />
            )}
          </Button>
        </div>

      {!hasKey && !bannerDismissed && (
        <div
          className="mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="status"
        >
          <span
            className="flex-1 cursor-pointer"
            onClick={() => setShowSettings(true)}
          >
            点击配置 API Key 后开始使用
          </span>
          <button
            type="button"
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label="本次运行内隐藏提示"
            title="本次运行内隐藏提示"
            onClick={() => setBannerDismissed(true)}
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {shortcutHint && (
        <div className="mb-2 rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-500">
          {shortcutHint}
          <span className="opacity-70">（在设置中换一个未被占用的组合键）</span>
        </div>
      )}

        <Tabs
          value={activeTab}
          onValueChange={(v) => v && setActiveTab(v)}
          className="flex flex-1 flex-col gap-3"
        >
          <TabsList
            variant="default"
            className="w-full max-w-full justify-start"
            onWheel={(e) => {
              // 标签很多时鼠标滚轮也能横向滚动，避免只能拖滚动条
              const el = e.currentTarget;
              if (el.scrollWidth > el.clientWidth) {
                el.scrollLeft += e.deltaY + e.deltaX;
              }
            }}
          >
            <TabsTrigger value="translate">
              <Languages className="size-3.5" />
              翻译
            </TabsTrigger>
            <TabsTrigger value="naming">
              <Variable className="size-3.5" />
              命名
            </TabsTrigger>
            {config.custom_prompts.map((p) => (
              <TabsTrigger
                key={p.id}
                value={p.id}
                className="min-w-0 max-w-20 px-1"
                title={p.name}
              >
                <span className="min-w-0 truncate">{p.name}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          {/* keepMounted：切标签页不再丢掉已经生成的输入与输出 */}
          <TabsContent value="translate" keepMounted className="flex-1 overflow-auto">
            <TranslatePanel
              config={config}
              getApiKey={getApiKey}
              clipboardText={clipboardText}
              wipeToken={wipeToken}
              active={activeTab === "translate"}
              focusToken={focusToken}
            />
          </TabsContent>
          <TabsContent value="naming" keepMounted className="flex-1 overflow-auto">
            <NamingPanel
              config={config}
              getApiKey={getApiKey}
              clipboardText={clipboardText}
              wipeToken={wipeToken}
              active={activeTab === "naming"}
              focusToken={focusToken}
            />
          </TabsContent>
          {config.custom_prompts.map((p) => (
            <TabsContent key={p.id} value={p.id} keepMounted className="flex-1 overflow-auto">
              <CustomPromptPanel
                config={config}
                getApiKey={getApiKey}
                prompt={p}
                clipboardText={clipboardText}
                wipeToken={wipeToken}
                active={activeTab === p.id}
                focusToken={focusToken}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <SettingsPanel
        open={showSettings}
        onClose={closeSettings}
        onConfigSaved={refreshStatus}
        hasUpdate={hasUpdate}
      />
    </div>
  );
}

export default App;
