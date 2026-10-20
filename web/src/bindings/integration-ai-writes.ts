import type { components } from "@/api/schema"
import { refuse } from "./refusal"

type Config = components["schemas"]["IntegrationConfigData"]
type Account = components["schemas"]["IntegrationAiAccountView"]
export type AiAccountDraft = Omit<Required<Account>, "id"> & { id: string | null; apiKey: string }

export function applyAiUpsert(config: Config, draft: AiAccountDraft): {
  config: Config; credential?: [string, string]
} {
  const existing = draft.id ? config.ai_accounts.find((row) => row.id === draft.id) : undefined
  if (draft.id && !existing) throw refuse("integration_ai_invalid", "账号已变化，请刷新后重试")
  if (!existing && config.ai_accounts.length >= 64) throw refuse("integration_ai_invalid", "最多配置 64 个 AI 账号")
  const apiKey = draft.apiKey.trim()
  if (!existing && !apiKey) throw refuse("integration_ai_invalid", "新增账号必须填写 API Key")
  const model = draft.model.trim()
  const label = draft.label.trim()
  let url: URL
  try { url = new URL(draft.base_url.trim()) } catch { throw refuse("integration_ai_invalid", "请输入完整的服务地址") }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw refuse("integration_ai_invalid", "服务地址不能包含凭据、查询参数或片段")
  }
  if (!label || !model || model.length > 128 || /\s/.test(model) || !Number.isInteger(draft.priority) || draft.priority < -2147483648 || draft.priority > 2147483647) {
    throw refuse("integration_ai_invalid", "请检查账号名称、模型 id 和整数优先级")
  }
  const id = existing?.id ?? `ai_${crypto.randomUUID().replaceAll("-", "")}`
  const { apiKey: _key, ...fields } = draft
  const row: Account = { ...fields, id, label, model, base_url: draft.base_url.trim().replace(/\/+$/, "") }
  return {
    config: { ...config, ai_accounts: existing ? config.ai_accounts.map((item) => item.id === id ? row : item) : [...config.ai_accounts, row] },
    credential: apiKey ? [id, apiKey] : undefined,
  }
}

export function applyAiActive(config: Config, id: string, active: boolean): Config {
  if (!config.ai_accounts.some((row) => row.id === id)) throw refuse("integration_ai_invalid", "AI 账号不存在")
  return { ...config, ai_accounts: config.ai_accounts.map((row) => row.id === id ? { ...row, active } : row) }
}

export function applyAiDelete(config: Config, id: string): Config {
  if (!config.ai_accounts.some((row) => row.id === id)) throw refuse("integration_ai_invalid", "AI 账号不存在")
  return { ...config, ai_accounts: config.ai_accounts.filter((row) => row.id !== id) }
}

export function applyAiDefaultModel(config: Config, model: string): Config {
  const target = model.trim()
  if (!target || !config.ai_accounts.some((row) => row.active && row.api_format === "chat_completions" && row.model === target)) {
    throw refuse("integration_ai_invalid", "请先启用支持该模型的 Chat Completions 账号")
  }
  // Pricing is also checked by Cloud atomically with the replace; account models stay independent.
  return { ...config, ai_default_model: target }
}
