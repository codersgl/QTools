import {
  substituteTemplate,
  substituteInput,
  templateUsesInput,
} from "@/lib/template";
import type { ThinkingMode } from "@/types";

/** 该供应商支持的思考参数形态；`none` 表示不下发任何思考参数。 */
type ThinkingCap = "deepseek" | "none";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  thinking: ThinkingCap;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    thinking: "deepseek",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    thinking: "none",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    // 列表里的 R1 恒开思考、V3 与 Qwen2.5 不带思考，都没有可下发的开关
    thinking: "none",
  },
];

export function supportsThinking(providerId: string): boolean {
  return (getProvider(providerId)?.thinking ?? "none") !== "none";
}

/** 档位名到 DeepSeek `reasoning_effort` 取值的白名单映射。 */
const DEEPSEEK_EFFORT: Partial<Record<ThinkingMode, string>> = {
  low: "low",
  high: "high",
};

/**
 * 思考档位 → 请求体字段。`auto` 完全不下发，跟随模型默认行为；
 * 未声明思考能力的供应商一律不下发，避免被服务端判成未知参数。
 */
function buildThinkingParams(
  providerId: string,
  mode: ThinkingMode,
): Record<string, unknown> {
  if (mode === "auto") return {};
  if (getProvider(providerId)?.thinking !== "deepseek") return {};
  if (mode === "off") return { thinking: { type: "disabled" } };

  // mode 来自磁盘上的 config.json，被手改成非法值时不该原样转给服务端
  const effort = DEEPSEEK_EFFORT[mode];
  if (!effort) return {};
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

export type TranslateDirection = "auto" | "zh2en" | "en2zh";

/** 单次请求发出去的正文字符上限，防止一整份日志被自动填入后直接计费。 */
export const MAX_INPUT_CHARS = 8000;

const CONNECT_TIMEOUT_MS = 20_000;
/** 流式响应连续这么久没有新字符才算卡死。 */
const STALL_TIMEOUT_MS = 45_000;
// 刻意不发送 max_tokens：显式上限会把长回答截断，而推理模型的
// reasoning_content 与正文共用这份预算，截断得更早。交给服务端按上下文
// 剩余量放开，服务端侧真的截断时由 finish_reason === "length" 报给界面。

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function getProvider(providerId: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === providerId);
}

function getBaseUrl(providerId: string): string {
  return getProvider(providerId)?.baseUrl ?? "";
}

class ApiError extends Error {}

function clamp(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function parseApiError(status: number, body: string): string {
  if (status === 401) return "API Key 无效或已过期，请在设置中检查";
  if (status === 403) return "无权访问该服务，请检查 API Key 权限";
  if (status === 429) return "请求过于频繁，请稍后再试";
  if (status >= 500) return "服务端异常，请稍后重试";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message) {
      return clamp(`接口返回错误：${translateApiMessage(message)}`, 300);
    }
  } catch {
    // 非 JSON 响应体，走下面的兜底分支
  }
  // 不透传原始响应体：部分内容会回显请求头，且长文本会撑破固定尺寸的窗口
  return clamp(`请求失败 (${status})${body ? `：${body}` : ""}`, 240);
}

function translateApiMessage(message: string): string {
  if (/insufficient|quota|balance/i.test(message)) return "账户余额或额度不足";
  if (/context length|maximum context|too long/i.test(message)) {
    return `文本过长，超出模型上下文（单次最多 ${MAX_INPUT_CHARS} 字）`;
  }
  if (/model.*(not exist|not found|invalid)/i.test(message)) {
    return "模型名称无效，请在设置中检查";
  }
  return message;
}

function assertInputSize(text: string): void {
  // 按码点计数，避免 emoji 等代理对被当成一个字，与用户看到的字数不一致
  const length = [...text].length;
  if (length > MAX_INPUT_CHARS) {
    throw new ApiError(
      `输入过长（${length} 字），上限 ${MAX_INPUT_CHARS} 字，请拆分后重试`,
    );
  }
}

/** 把外部取消信号与内部超时信号合并成一个，超时能自动收尾而不影响手动停止。 */
function createLinkedSignal(external?: AbortSignal) {
  const controller = new AbortController();
  const forward = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    abortWith: (message: string) =>
      controller.abort(new DOMException(message, "TimeoutError")),
    dispose: () => external?.removeEventListener("abort", forward),
  };
}

function rethrowWithProviderHint(e: unknown, providerName: string): never {
  if (e instanceof DOMException) throw e;
  // 浏览器不会把 CORS 失败与 DNS 失败区分开，两种情况一起提示
  throw new ApiError(
    `无法连接 ${providerName}：请检查网络，或确认该服务允许从桌面应用跨域调用`,
  );
}

async function request(
  providerId: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const baseUrl = getBaseUrl(providerId);
  if (!baseUrl) throw new ApiError(`未知供应商: ${providerId}`);

  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface StreamChunk {
  /** 正式回答。 */
  content: string;
  /** 推理模型的思考过程，界面默认折叠。 */
  reasoning: string;
  /** finish_reason === "length"，说明回答被长度上限切断了。 */
  truncated: boolean;
}

type SseEvent =
  | { kind: "chunk"; chunk: StreamChunk }
  | { kind: "done" }
  | null;

/** 解析单条 SSE 行。思考过程与正文分开返回，不做互相回退。 */
function parseSseLine(line: string): SseEvent {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return { kind: "done" };

  try {
    const parsed = JSON.parse(payload) as {
      choices?: { delta?: unknown; finish_reason?: unknown }[];
    };
    const choice = parsed.choices?.[0];
    const delta = choice?.delta as
      | { content?: unknown; reasoning_content?: unknown }
      | undefined;
    return {
      kind: "chunk",
      chunk: {
        content: textOf(delta?.content),
        reasoning: textOf(delta?.reasoning_content),
        truncated: choice?.finish_reason === "length",
      },
    };
  } catch {
    // 不完整或畸形分片：跳过而不是打断整个流
    return null;
  }
}

async function chat(
  providerId: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  thinking: ThinkingMode = "auto",
): Promise<StreamChunk> {
  const linked = createLinkedSignal(signal);
  const timer = setTimeout(
    () => linked.abortWith(`${getProvider(providerId)?.name ?? "服务"} 响应超时`),
    CONNECT_TIMEOUT_MS,
  );

  try {
    let res: Response;
    try {
      res = await request(
        providerId,
        apiKey,
        { model, messages, temperature: 0.3, ...buildThinkingParams(providerId, thinking) },
        linked.signal,
      );
    } catch (e: unknown) {
      rethrowWithProviderHint(e, getProvider(providerId)?.name ?? providerId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(parseApiError(res.status, text));
    }

    const data = (await res.json().catch(() => {
      throw new ApiError("服务返回了无法解析的内容，请稍后重试");
    })) as {
      choices?: { message?: unknown; finish_reason?: unknown }[];
    };
    const choice = data.choices?.[0];
    const message = choice?.message as
      | { content?: unknown; reasoning_content?: unknown }
      | undefined;
    return {
      content: textOf(message?.content),
      reasoning: textOf(message?.reasoning_content),
      truncated: choice?.finish_reason === "length",
    };
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}

async function* chatStream(
  providerId: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  thinking: ThinkingMode = "auto",
): AsyncGenerator<StreamChunk> {
  const providerName = getProvider(providerId)?.name ?? providerId;
  const linked = createLinkedSignal(signal);
  const connectTimer = setTimeout(
    () => linked.abortWith(`${providerName} 响应超时`),
    CONNECT_TIMEOUT_MS,
  );
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallWatchdog = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => linked.abortWith(`${providerName} 长时间没有返回内容`),
      STALL_TIMEOUT_MS,
    );
  };

  try {
    let res: Response;
    try {
      res = await request(
        providerId,
        apiKey,
        {
          model,
          messages,
          temperature: 0.3,
          stream: true,
          ...buildThinkingParams(providerId, thinking),
        },
        linked.signal,
      );
    } catch (e: unknown) {
      rethrowWithProviderHint(e, providerName);
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(parseApiError(res.status, text));
    }

    const reader = res.body?.getReader();
    if (!reader) throw new ApiError("无法读取响应流");

    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    armStallWatchdog();

    // 返回 true 表示这一行是流终止标记
    function* flushLine(line: string): Generator<StreamChunk, boolean> {
      const event = parseSseLine(line);
      if (!event) return false;
      if (event.kind === "done") return true;
      const { content, reasoning, truncated } = event.chunk;
      if (content || reasoning || truncated) yield event.chunk;
      return false;
    }

    try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;
        armStallWatchdog();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (yield* flushLine(line)) {
            sawDone = true;
            break;
          }
        }
      }

      // 收尾必须冲刷：最后一条事件常常不带换行结尾（尤其是 [DONE] 与正文同属
      // 一个网络分块时），它会被 split/pop 留在 buffer 里；TextDecoder 也可能
      // 扣着半个多字节汉字。两者不冲刷就直接表现为「回答少了尾巴」。
      buffer += decoder.decode();
      if (!sawDone && buffer.trim()) {
        yield* flushLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(stallTimer);
    linked.dispose();
  }
}

const CJK_CHARS = /[㐀-䶿一-鿿豈-﫿]/g;
/** 一个拉丁/西里尔单词，用于与单个汉字对齐比较。 */
const LATIN_WORDS = /[A-Za-zÀ-ɏЀ-ӿ]+/g;

/**
 * 只按「是否含中日韩字符」判方向会把 `把 user_list 传给函数` 这类技术句
 * 误判成中译英再原样吐回来。按 CJK 字符数与拉丁单词数比较，长标识符才不会被
 * 字母数量放大成「英文为主」。判断仍可能被误伤，所以界面上允许手动改方向。
 */
export function detectTranslateDirection(
  text: string,
): Exclude<TranslateDirection, "auto"> {
  const cjk = text.match(CJK_CHARS)?.length ?? 0;
  if (cjk === 0) return "en2zh";
  const latinWords = text.match(LATIN_WORDS)?.length ?? 0;
  return cjk >= latinWords ? "zh2en" : "en2zh";
}

const TARGET_LABEL: Record<Exclude<TranslateDirection, "auto">, string> = {
  zh2en: "英文",
  en2zh: "中文",
};

export function resolveTranslateDirection(
  text: string,
  direction: TranslateDirection,
): Exclude<TranslateDirection, "auto"> {
  return direction === "auto" ? detectTranslateDirection(text) : direction;
}

export async function* translateStream(
  providerId: string,
  model: string,
  apiKey: string,
  text: string,
  signal?: AbortSignal,
  direction: TranslateDirection = "auto",
  thinking: ThinkingMode = "auto",
): AsyncGenerator<StreamChunk> {
  assertInputSize(text);
  const target = TARGET_LABEL[resolveTranslateDirection(text, direction)];

  yield* chatStream(
    providerId,
    model,
    apiKey,
    [
      {
        role: "system",
        content: `你是一个专业翻译器。将用户输入翻译成${target}，只输出翻译结果，不要任何解释。保持原文的语气和风格。`,
      },
      { role: "user", content: text },
    ],
    signal,
    thinking,
  );
}

export async function* customPromptStream(
  providerId: string,
  model: string,
  apiKey: string,
  systemPromptTemplate: string,
  userText: string,
  vars: Record<string, string>,
  signal?: AbortSignal,
  thinking: ThinkingMode = "auto",
): AsyncGenerator<StreamChunk> {
  assertInputSize(userText);
  const rendered = substituteTemplate(systemPromptTemplate, vars);

  const messages: ChatMessage[] = templateUsesInput(systemPromptTemplate)
    ? [{ role: "user", content: substituteInput(rendered, userText) }]
    : [
        { role: "system", content: rendered },
        { role: "user", content: userText },
      ];

  yield* chatStream(providerId, model, apiKey, messages, signal, thinking);
}

export interface NamingResult {
  style: string;
  name: string;
}

const NAMING_SYSTEM_PROMPT =
  '你是一个编程变量命名助手。根据用户描述生成5种命名风格的变量名。严格按JSON数组格式返回：[{"style":"camelCase","name":"xxx"},{"style":"snake_case","name":"xxx"},{"style":"PascalCase","name":"xxx"},{"style":"SCREAMING_SNAKE","name":"xxx"},{"style":"kebab-case","name":"xxx"}]。只返回JSON，不要其他内容。';

export async function generateNames(
  providerId: string,
  model: string,
  apiKey: string,
  description: string,
  signal?: AbortSignal,
  thinking: ThinkingMode = "off",
): Promise<NamingResult[]> {
  assertInputSize(description);
  const reply = await chat(providerId, model, apiKey, [
    { role: "system", content: NAMING_SYSTEM_PROMPT },
    { role: "user", content: description },
  ], signal, thinking);
  const content = reply.content;

  if (reply.truncated) {
    throw new ApiError("模型输出达到长度上限被截断，命名结果不完整；请缩短描述或改用非推理模型");
  }

  try {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        const valid: NamingResult[] = [];
        for (const item of parsed as Partial<NamingResult>[]) {
          const style = typeof item?.style === "string" ? item.style.trim() : "";
          const name = typeof item?.name === "string" ? item.name.trim() : "";
          // 模型偶尔会重复同一个 style，或给出空 name：点上去只会复制一个空串
          if (!style || !name || seen.has(style)) continue;
          seen.add(style);
          valid.push({ style, name });
        }
        if (valid.length > 0) return valid;
      }
    }
  } catch {
    // 落到兜底分支
  }

  const raw = content.trim();
  if (!raw) throw new ApiError("模型没有返回内容，请稍后重试或换用非推理模型");
  return [{ style: "raw", name: raw }];
}
