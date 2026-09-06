/**
 * 思考档位。`auto` 表示不向服务端下发任何思考相关参数，跟随模型默认行为；
 * 其余档位只有具备该能力的供应商才会真正生效，见 `api.ts` 的 `supportsThinking`。
 */
export type ThinkingMode = "auto" | "off" | "low" | "high";

export const THINKING_OPTIONS: { value: ThinkingMode; label: string }[] = [
  { value: "auto", label: "模型默认" },
  { value: "off", label: "关闭思考" },
  { value: "low", label: "轻量思考" },
  { value: "high", label: "充分思考" },
];

export interface CustomPrompt {
  id: string;
  name: string;
  system_prompt: string;
  placeholder: string;
  /** 缺省按 `auto` 处理，兼容没有该字段的历史配置。 */
  thinking?: ThinkingMode;
}

export interface AppConfig {
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
  auto_check_updates: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
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
  auto_check_updates: true,
};

export function getEffectiveModel(config: AppConfig): string {
  return config.model === "custom" ? config.custom_model : config.model;
}
