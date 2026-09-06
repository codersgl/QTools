import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Download, RefreshCw } from "lucide-react";

type Phase = "idle" | "checking" | "ready" | "downloading" | "installing" | "error";

/** 下载/安装一旦开始就无法取消，卸载组件时不能顺手 close 掉在途的更新资源。 */
const BUSY_PHASES: Phase[] = ["downloading", "installing"];

/** latest.json 的 version 取决于取标签名还是配置版本，前导 v 可能有也可能无。 */
function formatVersion(v: string): string {
  return v.startsWith("v") ? v : `v${v}`;
}

function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/404|not found/i.test(text)) {
    return `检查更新失败：最新 Release 里还没有可用的更新包（${text}）`;
  }
  if (/timeout|timed out/i.test(text)) {
    return "检查更新超时，请确认网络可用后重试";
  }
  return `检查更新失败：${text}`;
}

export function UpdateSection() {
  const [currentVersion, setCurrentVersion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const updateRef = useRef<Update | null>(update);
  updateRef.current = update;
  const percentRef = useRef<number | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  // 设置面板关闭即卸载本组件：放弃这次检查结果，避免原生侧资源一直挂着
  useEffect(
    () => () => {
      if (!BUSY_PHASES.includes(phaseRef.current)) {
        void updateRef.current?.close().catch(() => {});
      }
    },
    [],
  );

  async function handleCheck() {
    const stale = updateRef.current;
    setUpdate(null);
    setPercent(null);
    setMessage("");
    setPhase("checking");
    if (stale) void stale.close().catch(() => {});
    try {
      const found = await check({ timeout: 15000 });
      if (!found) {
        setPhase("idle");
        setMessage(`${formatVersion(currentVersion)} 已是最新版本`);
        return;
      }
      setUpdate(found);
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      setMessage(errorMessage(e));
    }
  }

  async function handleInstall() {
    if (!update) return;
    setMessage("");
    setPhase("downloading");
    percentRef.current = null;
    setPercent(null);

    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (!total) return;
          // 分片回调很密，只在整数百分比变化时提交，避免逐块重渲染
          const next = Math.min(99, Math.floor((received / total) * 100));
          if (next !== percentRef.current) {
            percentRef.current = next;
            setPercent(next);
          }
        } else {
          setPhase("installing");
        }
      });
      setPhase("installing");
      // Windows 下 install 会自行退出并交给安装器重启，走不到这一行；
      // macOS / Linux 必须 relaunch 才能用上新版本。
      await relaunch();
    } catch (e) {
      setPhase("error");
      setMessage(
        e instanceof Error ? e.message : "更新失败，可以从 Release 页面手动下载安装包",
      );
    }
  }

  const busy = BUSY_PHASES.includes(phase);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <Label className="text-xs">更新</Label>
          <span className="text-[10px] text-muted-foreground">
            {currentVersion
              ? `当前版本 ${formatVersion(currentVersion)}`
              : "读取版本中..."}
          </span>
        </div>
        {phase === "ready" && update ? (
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1 text-xs"
            onClick={handleInstall}
          >
            <Download className="size-3" />
            更新到 {formatVersion(update.version)}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 text-xs"
            onClick={handleCheck}
            disabled={phase === "checking" || busy}
          >
            <RefreshCw className={`size-3 ${phase === "checking" ? "animate-spin" : ""}`} />
            {phase === "checking" ? "检查中..." : "检查更新"}
          </Button>
        )}
      </div>

      {phase === "ready" && (
        <p className="text-[10px] text-muted-foreground">
          下载完成后会校验签名，安装好即自动重启
        </p>
      )}
      {phase === "downloading" && (
        <p className="text-[10px] text-muted-foreground">
          正在下载更新{percent !== null ? ` · ${percent}%` : "..."}
        </p>
      )}
      {phase === "installing" && (
        <p className="text-[10px] text-muted-foreground">正在安装，应用随后会自动重启</p>
      )}
      {message && (
        <p
          className={`text-[10px] break-words ${
            phase === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {message}
        </p>
      )}
      {phase === "idle" && !message && (
        <p className="text-[10px] text-muted-foreground">
          从 GitHub Releases 检查并安装新版本
        </p>
      )}
    </div>
  );
}
