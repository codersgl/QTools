import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarkdownOutputProps {
  content: string;
  /** 流式输出中：markdown 尚未闭合，按纯文本渲染避免整段闪烁成代码/粗体。 */
  streaming?: boolean;
}

export function MarkdownOutput({ content, streaming = false }: MarkdownOutputProps) {
  const [notice, setNotice] = useState("");

  async function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    // 窗口没有地址栏也没有返回入口，一旦被模型输出的链接导航走就只能杀进程恢复，
    // 所以任何跳转都必须拦下来交给系统浏览器。
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    try {
      await invoke("open_external", { url: href });
      setNotice("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "无法打开链接");
    }
  }

  return (
    <div
      className="md-body rounded-lg bg-muted/50 p-3 text-sm leading-relaxed"
      onClickCapture={handleClick}
    >
      {streaming ? (
        <pre className="font-sans whitespace-pre-wrap break-words">{content}</pre>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {content}
        </ReactMarkdown>
      )}
      {notice && <p className="mt-1 text-xs text-destructive">{notice}</p>}
    </div>
  );
}

interface ThinkingBlockProps {
  text: string;
  /** 思考仍在流入、正文还没开始：标题上给出进行中标记。 */
  active?: boolean;
  /** 本次请求已等待的秒数。 */
  seconds?: number;
}

/** 推理模型的思考过程。默认收起，避免盖掉真正要看的译文/结果。 */
export function ThinkingBlock({ text, active = false, seconds }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex-1 text-left">
          思考过程 · {text.length} 字{active ? ` · 思考中 ${seconds ?? 0}s` : ""}
        </span>
        <span className="shrink-0 opacity-70">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 leading-relaxed text-muted-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}

export function TruncatedNotice() {
  return (
    <p className="rounded-md bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-700 dark:text-yellow-500">
      输出达到长度上限被截断，可缩短输入或换用非推理模型重试
    </p>
  );
}
