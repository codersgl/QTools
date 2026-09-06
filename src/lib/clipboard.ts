import { invoke } from "@tauri-apps/api/core";

/**
 * 把文本写入系统剪贴板。
 *
 * WebView 的 `navigator.clipboard` 在窗口失焦或权限策略拦截时会直接 reject，
 * 之前的实现把它吞掉，用户点了复制却毫无反应。这里先走 Web API，
 * 失败再回退到原生剪贴板；两条路都失败时抛出，由调用方展示原因。
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 窗口此刻可能已失焦，交给原生剪贴板重试
  }
  await invoke("write_clipboard_text", { text });
}
