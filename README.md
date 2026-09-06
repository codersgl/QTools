# QTools

一个常驻系统托盘的桌面快捷助手。按下全局快捷键即可唤出一个置顶浮窗，完成翻译、变量命名，或运行你自己定义的提示词任务，失焦自动隐藏。

基于 **Tauri 2 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui** 构建，当前主要面向 Windows。

## 功能

**窗口与交互**

- 全局快捷键唤起 / 隐藏，默认 `Alt+Space`，可在设置中录制自定义组合（支持 `Ctrl`/`Alt`/`Shift`/`Win` + 字母、数字、功能键）
- 无边框、置顶、不占任务栏；失焦自动隐藏
- 自定义标题栏可拖拽移动，窗口位置自动记忆；记录的位置若已落在断开连接的显示器上，下次唤起自动回中并清除记录
- 系统托盘图标：左键切换显示 / 隐藏，右键菜单「显示窗口 / 退出」
- 聚焦时自动读取剪贴板并填入输入框（可在设置中关闭）；自动填入且未被编辑过的内容会在窗口隐藏时从界面状态中清除
- 主题跟随系统 / 强制浅色 / 强制深色；系统主题运行时变更会即时生效

**LLM 能力**

- **翻译** — 默认自动判断中↔英方向，也可手动锁定为「中 → 英」或「英 → 中」并显示实际目标语言；SSE 流式输出，可随时中断。默认即为「关闭思考」
- **变量命名** — 输入中文描述或英文说明，一次返回 camelCase / snake_case / PascalCase / SCREAMING_SNAKE / kebab-case 五种风格，点击单行即复制，也可一键复制全部。固定不带思考
- **自定义提示词** — 自行添加标签页，每个标签页配置独立的 System Prompt、输入框占位文案与**思考档位**（模型默认 / 关闭 / 轻量 / 充分），同样支持流式输出。System Prompt 支持模板变量（见下）
- **思考开销可控** — 档位只对声明了该能力的供应商下发参数（当前是 DeepSeek V4：`thinking.type` 配 `reasoning_effort`）；OpenAI 与硅基流动列表里的模型没有对应开关，控件会灰掉并说明原因，不会出现「改了没作用」。等待期间界面显示已等待秒数，首字返回前也不再是一片空白
- **输出 Markdown 渲染** — 翻译与自定义提示词的结果按 Markdown 呈现（标题、列表、代码块、表格、引用），并保留单换行。推理模型的思考过程单独收进一行可展开的「思考过程」，默认隐藏。模型输出按**不可信内容**处理：原始 HTML 被转义，链接点击一律被拦下并交给系统浏览器，绝不允许窗口自身导航
- 多供应商：DeepSeek、OpenAI、硅基流动；模型可从预设列表选择，也可填写自定义模型名

### 模板变量

自定义提示词的 System Prompt 中可使用 `{{...}}` 插槽，运行面板会自动为每个变量生成控件：

| 语法 | 含义 | 控件 |
|---|---|---|
| `{{input}}` | 用户输入插槽。含它时整条模板替换后作为**单条 user 消息**发送（模板完全控制输入如何被框定） | 不生成控件 |
| `{{变量名}}` | 自由文本参数 | 文本输入框 |
| `{{变量名:选项1\|选项2}}` | 枚举参数，如目标语言、语气、输出格式 | 下拉选择 |

不含 `{{input}}` 时保持传统结构：替换变量后的模板作为 system 消息，用户输入作为独立 user 消息。

`input` 是保留名，只为它生成一个插槽而不生成参数控件：误写成 `{{input:中文|英文}}` 时后缀会被忽略，仍按 `{{input}}` 处理，不会把字面量花括号留进提示词。

示例：

```
把下面这段文字翻译成 {{lang:中文|英文|日文}}，语气 {{tone:正式|口语}}。
只输出译文。

{{input}}
```

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js | `^20.19.0 \|\| >=22.12.0`（Vite 8 要求；开发使用 v24） |
| Rust | stable MSVC 工具链（开发使用 1.98） |
| WebView2 | Windows 运行时，Win11 已内置 |
| Visual Studio | 需含「使用 C++ 的桌面开发」工作负载 |

验证环境：

```bash
node --version && npm --version
rustc --version && cargo --version
npm run tauri info
```

## 快速开始

```bash
npm install
npm run tauri dev
```

首次启动窗口是隐藏的（`visible: false`），按 `Alt+Space` 或点击托盘图标唤起。

### 首次配置

1. 唤起窗口后点击右上角齿轮图标
2. 选择供应商与模型
3. 填入 API Key，保存

未配置 Key 时主界面会显示红色提示条，点击即可跳转到设置。

## 生产构建

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`。发布配置已开启 `lto`、`opt-level=3`、`codegen-units=1`、`strip`，并设置 `panic = "abort"`。

其他命令：

```bash
npm run build        # 仅构建前端（tsc + vite build）
npm run dev          # 仅启动 Vite 开发服务器
```

## 数据存储

**配置文件** — `%APPDATA%\com.codersgl.qtools\config.json`

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "custom_model": "",
  "theme": "system",
  "custom_prompts": [],
  "autostart": false,
  "shortcut": "Alt+Space",
  "window_x": null,
  "window_y": null,
  "clipboard_auto_read": true
}
```

`custom_prompts` 的每一项形如 `{ id, name, system_prompt, placeholder, thinking }`，`thinking` 取 `auto` / `off` / `low` / `high`。

写入采用「临时文件 + rename」的原子方式，并由进程内 `Mutex` 串行化，避免窗口失焦保存位置与设置面板保存配置互相覆盖。

字段缺省依赖 `#[serde(default)]`，但**它是容器级开关，只覆盖标注到的那个结构体**。给 `AppConfig` 加字段时它已被标注、天然兼容；给 `CustomPrompt` 这类内层结构体加字段时必须再单独标注一次，否则历史 `config.json` 里缺少该字段的条目会让整份配置解析失败，`load_config` 会静默回退成默认值、把用户的全部自定义提示词丢掉。`thinking` 字段就是这么处理的，并用 `#[serde(default = "default_thinking")]` 让缺省值落在前端联合类型的范围内。

`model` 为 `"custom"` 时是哨兵值，实际模型名取 `custom_model`。

**API Key** — 不写入配置文件，存储于操作系统凭据管理器（Windows 凭据管理器 / macOS Keychain），服务名 `com.codersgl.qtools`，按供应商分别存放。

## 安全设计

- **模型输出按不可信内容处理** — react-markdown 不渲染原始 HTML；输出里的链接被 `MarkdownOutput` 全量拦截，只经 `open_external` 校验协议（仅 `http`/`https`）后交给系统浏览器。窗口自身永不导航：这个无边框、无地址栏、无返回入口的窗口一旦被带走就无法恢复
- **CSP 已启用** — `connect-src` 仅放行三个已知 API 域名与 Tauri IPC（`ipc:` / `http://ipc.localhost`），即使渲染层被注入脚本也无法将 Key 外发到任意地址；`img-src` 不放行远程地址，远程图片直接加载失败
- **Key 不进入持久化明文** — 前端仅在发起请求的瞬间通过 `invoke("get_api_key")` 取值，不写 localStorage
- **凭据命名空间白名单** — `provider` 参数来自渲染层，`config.rs` 只接受 `deepseek` / `openai` / `siliconflow`，避免任意字符串被当作凭据条目名写入
- **思考过程与正文分离** — 推理模型的 `reasoning_content` 单独累计，界面默认折叠成一行「思考过程 · n 字」，展开才可读，复制也只复制正文
- **输出上限交给服务端，截断如实上报** — 请求不发送 `max_tokens`：显式上限会把长回答拦腰截断，而推理模型的思考与正文共用这份预算，截断得更早。改为读取 `finish_reason`，等于 `"length"` 时在输出下方提示被截断
- **请求规模受限** — 单次用户输入上限 8000 字（按码点计）；连接 20s、流式 45s 无进展即中止，避免悬挂的代理把界面永久卡在加载态
- **Capabilities 最小化** — `src-tauri/capabilities/default.json` 只声明实际用到的权限，窗口权限单独授予 `allow-start-dragging` 而非整个 `core:window:default`

若新增其他供应商，需同步把它的域名加入 `tauri.conf.json` 的 `connect-src`、`api.ts` 的 `PROVIDERS` 以及 `config.rs` 的 `KNOWN_PROVIDERS`，否则请求会被 CSP 或凭据白名单拦下。

## 项目结构

```
src/
├── App.tsx                    # 主界面：翻译 / 命名 / 自定义提示词三类面板
├── components/
│   ├── SettingsPanel.tsx      # 设置浮层：供应商、模型、Key、主题、快捷键、自启动、提示词管理
│   └── ui/                    # shadcn/ui 组件
├── services/
│   └── api.ts                 # LLM 调用：供应商注册表、chat / chatStream（SSE 解析）
├── types.ts                   # 共享类型 AppConfig / CustomPrompt 与 DEFAULT_CONFIG
└── index.css                  # Tailwind v4 + shadcn 主题变量

src-tauri/
├── src/
│   ├── lib.rs                 # 应用装配：托盘、全局快捷键、窗口事件、11 个 command
│   ├── config.rs              # 配置读写（原子 + 加锁）与 keyring 封装
│   └── main.rs                # 进程入口
├── capabilities/default.json  # 渲染层权限白名单
└── tauri.conf.json            # 窗口、CSP、打包配置
```

### Rust ↔ 前端 Command 一览

| Command | 作用 |
|---|---|
| `get_config` / `save_config` | 读写配置 |
| `get_api_key` / `has_api_key` / `set_api_key` / `delete_api_key` | keyring 中的 Key 管理（provider 受白名单约束） |
| `get_clipboard_text` / `write_clipboard_text` | 读写剪贴板文本；写入是前端 `navigator.clipboard` 失败时的回退 |
| `open_external` | 校验协议后用系统默认浏览器打开链接，替代窗口自身导航 |
| `change_shortcut` | 切换全局快捷键（先注册新的，成功后再注销 native 记录的当前生效值） |
| `shortcut_status` | 返回实际生效的快捷键与启动期注册失败原因 |
| `set_autostart` / `is_autostart_enabled` | 开机自启动 |
| `set_dragging` | 拖拽期间抑制失焦隐藏；下次显示窗口时由 native 兜底复位 |

## 已知限制

- **自动读剪贴板仍有隐私面** — 未接入 Windows 的 Clipboard Listener 探测（密码管理器借此声明「不要读我的剪贴板」），因此从密码管理器复制的内容若在此刻唤起窗口仍会被填入；只能靠「未编辑的内容在隐藏时清除」缩小驻留时间，介意请在设置中关掉该开关
- **请求从 WebView 直发** — 受供应商自身的 CORS 策略约束，且 API Key 会短暂进入渲染进程内存。彻底闭环需要改用 `tauri-plugin-http` 把请求移到 Rust 侧，代价是失去前端直连的简单性
- **输出长度由服务端默认值决定** — 不发送 `max_tokens` 换来了「不因客户端上限而截断」，代价是个别供应商的模型自带较低的默认输出上限（硅基流动部分模型尤甚），长回答会更早出现截断提示；此时缩短输入或改用输出上限更高的模型即可
- **翻译方向只区分中↔英** — 含汉字的日文、韩文混排文本会被判为中译英，需要时在方向下拉里手动锁定
- 未配置 lint / format / 测试工具链，`tsc` 的 `strict` 是目前唯一的静态检查
- Linux 下 keyring 的 `linux-native` feature 使用内核 keyutils，会话级且不持久，若将来支持 Linux 应改用 `sync-secret-service`
- 窗口 `resizable: false` 且尺寸固定为 480×400，长文本输出区域靠内部滚动
- 品牌图标为单色透明底，在纯白与纯黑背景之间取了一个高饱和青蓝（`#0EA5E9`）作为折中；若将来需要随系统主题切换托盘图标颜色，需改为提供两套图标并按主题切换

## 品牌图标

图标源文件是 `app-icon.svg`（可编辑矢量），渲染产物 `app-icon.png`（1024×1024 透明底）是所有平台图标的唯一来源。

设计为粗体几何字母 Q 单体标，扁平单色 + 透明底，描边刻意加粗（172/1024）以保证 16–32px 托盘尺寸下环形与字腔仍可辨识。

修改 `app-icon.svg` 后重新生成全部尺寸：

```bash
magick -background none app-icon.svg -resize 1024x1024 app-icon.png
npx tauri icon app-icon.png
```

`npx tauri icon` 会重写 `src-tauri/icons/` 下的全部 PNG / `.ico` / `.icns`。图标在编译期经 `tauri::generate_context!()` 嵌入，改完需重新构建。

## 开发建议

VS Code + [Tauri 扩展](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)。

行尾由 `.gitattributes` 统一为 LF，二进制资源（png/ico/icns/woff2）已显式标记。
