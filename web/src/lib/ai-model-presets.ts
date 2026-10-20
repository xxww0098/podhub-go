/**
 * Named models the account form offers before any endpoint or thinking dialect.
 *
 * The first row is the new-account default: DeepSeek 4.1 Flash with thinking
 * off through Cline (`https://api.cline.bot/api/v1`), using Cline's public
 * catalogue id `deepseek/deepseek-v4.1-flash`; `thinking_type` + `off` is the
 * body `{"thinking":{"type":"disabled"}}`. Legacy ids stay available under 自定义.
 */
export const AI_MODEL_CHOICES = [
  {
    id: "deepseek-4-1-flash-off",
    label: "DeepSeek 4.1 Flash · 关闭思考",
    summary: "默认项。经 Cline 调用 DeepSeek，关闭思考。",
    accountLabel: "DeepSeek 4.1 Flash",
    service: "Cline",
    model: "deepseek/deepseek-v4.1-flash",
    baseUrl: "https://api.cline.bot/api/v1",
    thinking: false,
    thinkingFormat: "thinking_type",
  },
  {
    id: "qwen-3-7-flash-off",
    label: "千问 3.7 Flash · 关闭思考",
    summary: "阿里云百炼北京接口，关闭思考。",
    accountLabel: "千问 3.7 Flash",
    service: "千问 · 北京",
    model: "qwen3.7-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    thinking: false,
    thinkingFormat: "enable_thinking",
  },
  {
    id: "glm-5-3-flash-low",
    label: "GLM 5.3 Flash · 低思考",
    summary: "OpenCode Go。该型号不能关闭思考，已使用最低档。",
    accountLabel: "GLM 5.3 Flash",
    service: "OpenCode Go",
    model: "glm-5.3-flash",
    baseUrl: "https://opencode.ai/zen/go/v1",
    thinking: "low",
    thinkingFormat: "reasoning_effort",
  },
] as const

export type AiModelChoice = (typeof AI_MODEL_CHOICES)[number]

export const AI_CUSTOM_CHOICE = "custom"

export const DEFAULT_AI_MODEL_CHOICE: AiModelChoice = AI_MODEL_CHOICES[0]
