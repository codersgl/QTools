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
  if (!output && !thinking) return null;

  return (
    <>
      <Separator />
      <ThinkingBlock text={thinking} active={loading && !output} seconds={elapsed} />
      {output && <MarkdownOutput content={output} streaming={loading} />}
      {truncated && <TruncatedNotice />}
    </>
  );
}
