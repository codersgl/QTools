import { useEffect, useRef } from "react";
import { Separator } from "@/components/ui/separator";
import {
  MarkdownOutput,
  ThinkingBlock,
  TruncatedNotice,
} from "@/components/MarkdownOutput";

interface OutputAreaProps {
  thinking: string;
  output: string;
  truncated: boolean;
  /** 请求是否仍在进行：决定正文按流式纯文本还是完整 Markdown 渲染。 */
  loading: boolean;
  /** 本次请求已等待的秒数，用于思考块上的进行中标记。 */
  elapsed: number;
}

/** 找到真正负责滚动的祖先（这里是标签页内容区）。 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 结果区整体作为懒加载边界。
 *
 * react-markdown 与两个 remark 插件占了主包的大部分体积，而只有真正产出内容时
 * 才用得上；默认导出是为了让上层的 `lazy(() => import(...))` 不必再做名称转换。
 */
export default function OutputArea({
  thinking,
  output,
  truncated,
  loading,
  elapsed,
}: OutputAreaProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** 用户是否仍停在底部。向上翻看时不再劫持滚动位置。 */
  const stickRef = useRef(true);

  const hasContent = Boolean(output || thinking);

  useEffect(() => {
    if (!hasContent) return;
    const scroller = findScrollParent(rootRef.current);
    if (!scroller) return;
    // 之前可能已经被浏览器钳到新的底部，先按当前距离重新判断一次
    stickRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const onScroll = () => {
      stickRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [hasContent]);

  // 每一次新的请求都重新跟随输出，避免上次手动上滚后新回答停在视口外
  useEffect(() => {
    if (loading) stickRef.current = true;
  }, [loading]);

  // 流式输出时自动跟随到底部；用户主动上滚后就不再抢滚动位置
  useEffect(() => {
    if (!loading || !stickRef.current) return;
    const scroller = findScrollParent(rootRef.current);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [output, thinking, loading]);

  if (!hasContent) return null;

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <Separator />
      <ThinkingBlock text={thinking} active={loading && !output} seconds={elapsed} />
      {output && <MarkdownOutput content={output} streaming={loading} />}
      {truncated && <TruncatedNotice />}
    </div>
  );
}
