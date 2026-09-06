export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
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
  },
];

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function getBaseUrl(providerId: string): string {
  return PROVIDERS.find((p) => p.id === providerId)?.baseUrl ?? "";
}

function parseApiError(status: number, body: string): string {
  if (status === 401) return "API Key 无效或已过期，请在设置中检查";
  if (status === 403) return "无权访问该服务，请检查 API Key 权限";
  if (status === 429) return "请求过于频繁，请稍后再试";
  if (status >= 500) return "服务端异常，请稍后重试";
  try {
    const json = JSON.parse(body);
    const msg = json?.error?.message ?? json?.message;
    if (msg) return msg;
  } catch {
    // ignore
  }
  return `请求失败 (${status})${body ? `: ${body}` : ""}`;
}

async function chat(
  providerId: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = getBaseUrl(providerId);
  if (!baseUrl) throw new Error(`未知供应商: ${providerId}`);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
      signal,
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("网络连接失败，请检查网络");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(parseApiError(res.status, text));
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

async function* chatStream(
  providerId: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const baseUrl = getBaseUrl(providerId);
  if (!baseUrl) throw new Error(`未知供应商: ${providerId}`);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.3, stream: true }),
      signal,
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("网络连接失败，请检查网络");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(parseApiError(res.status, text));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* translateStream(
  providerId: string,
  model: string,
  apiKey: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const isChinese = /[\u4e00-\u9fff]/.test(text);
  const target = isChinese ? "英文" : "中文";

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
  );
}

export async function* customPromptStream(
  providerId: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userText: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    providerId,
    model,
    apiKey,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    signal,
  );
}

export interface NamingResult {
  style: string;
  name: string;
}

export async function generateNames(
  providerId: string,
  model: string,
  apiKey: string,
  description: string,
  signal?: AbortSignal,
): Promise<NamingResult[]> {
  const content = await chat(
    providerId,
    model,
    apiKey,
    [
      {
        role: "system",
        content:
          '你是一个编程变量命名助手。根据用户描述生成5种命名风格的变量名。严格按JSON数组格式返回：[{"style":"camelCase","name":"xxx"},{"style":"snake_case","name":"xxx"},{"style":"PascalCase","name":"xxx"},{"style":"SCREAMING_SNAKE","name":"xxx"},{"style":"kebab-case","name":"xxx"}]。只返回JSON，不要其他内容。',
      },
      { role: "user", content: description },
    ],
    signal,
  );

  try {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (r: unknown): r is NamingResult =>
            typeof r === "object" && r !== null &&
            typeof (r as NamingResult).style === "string" &&
            typeof (r as NamingResult).name === "string"
        );
        if (valid.length > 0) return valid;
      }
    }
  } catch {
    // fall through
  }

  return [{ style: "raw", name: content }];
}
