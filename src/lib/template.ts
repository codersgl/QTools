export interface TemplateVariable {
  name: string;
  options: string[];
}

function tokenRegex(): RegExp {
  // 变量名支持中文等 Unicode 字母：文档与设置里写作 `{{变量名}}`，
  // 只认 ASCII 会让用户照抄示例后变量被原样发给模型。
  return /\{\{\s*([\p{L}_][\p{L}\p{N}_]*)(?:\s*:\s*([^}]*?))?\s*\}\}/gu;
}

/** `input` 是保留名：带不带 `:选项` 后缀都代表同一个用户输入插槽。 */
const INPUT_TOKEN_SOURCE = String.raw`\{\{\s*input(?:\s*:\s*[^}]*?)?\s*\}\}`;

function inputTokenRegex(): RegExp {
  return new RegExp(INPUT_TOKEN_SOURCE, "g");
}

function isInputToken(name: string): boolean {
  return name === "input";
}

export function parseTemplateVariables(template: string): TemplateVariable[] {
  const seen = new Map<string, TemplateVariable>();
  for (const m of template.matchAll(tokenRegex())) {
    const name = m[1];
    if (isInputToken(name) || seen.has(name)) continue;
    const options = (m[2] ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    seen.set(name, { name, options });
  }
  return [...seen.values()];
}

/** 模板声明了但用户还没填的变量，提交前用来给出明确提示。 */
export function missingTemplateVars(
  template: string,
  vars: Record<string, string>,
): string[] {
  return parseTemplateVariables(template)
    .filter((v) => !(vars[v.name] ?? "").trim())
    .map((v) => v.name);
}

export function templateUsesInput(template: string): boolean {
  return new RegExp(INPUT_TOKEN_SOURCE).test(template);
}

export function substituteTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(tokenRegex(), (full, name: string) =>
    isInputToken(name) ? full : (vars[name] ?? ""),
  );
}

export function substituteInput(template: string, input: string): string {
  // 用函数返回替换值，避免输入文本里的 `$&`、`$1` 被当成替换模式
  return template.replace(inputTokenRegex(), () => input);
}
