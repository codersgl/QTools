import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

/**
 * 渲染层兜底：无边框窗口一旦白屏，用户既看不到地址栏也没有刷新入口，
 * 这里至少把错误原因和「重新加载」按钮留在界面上。
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("QTools 界面渲染失败", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
          <p className="text-sm font-semibold text-destructive">界面出错了</p>
          <pre className="max-h-48 flex-1 overflow-auto rounded-md bg-muted/50 p-2 text-[10px] whitespace-pre-wrap break-words">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="h-8 shrink-0 rounded-lg bg-primary text-xs text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            重新加载界面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
);
