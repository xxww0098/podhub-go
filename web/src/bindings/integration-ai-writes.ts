import type { components } from "@/api/schema"
import type { AiAccountView, AiPurpose, AiRuntime } from "./commands"
import { refuse } from "./refusal"

type Config = components["schemas"]["AdminIntegrationConfigView"]
type Account = components["schemas"]["AdminIntegrationAiAccountView"]
/** `purpose` places a new account in its pool; an edit keeps the stored row's purpose. */
export type AiAccountDraft = Omit<AiAccountView, "id" | "ref_id" | "configured" | "purpose"> & { id: string | null; apiKey: string; purpose: AiPurpose }

export function applyAiUpsert(config: Config, draft: AiAccountDraft): {
  config: Config; credential?: [string, string]
} {
  const existing = draft.id ? config.ai_accounts.find((row) => row.id === draft.id) : undefined
  if (draft.id && !existing) throw refuse("integration_ai_invalid", "账号已变化，请刷新后重试")
  if (existing && existing.purpose !== "ocr" && existing.purpose !== "image" && existing.purpose !== "chat") throw refuse("integration_ai_invalid", "账号用途未确认，请更新服务并刷新后重试")
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
  const row: Account = {
    id, label, model, base_url: draft.base_url.trim().replace(/\/+$/, ""),
    api_format: draft.api_format, active: draft.active,
    thinking: draft.thinking === false ? "disabled" : draft.thinking,
    thinking_format: draft.thinking_format, priority: draft.priority,
    purpose: existing?.purpose ?? draft.purpose,
  }
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
  if (!target || !config.ai_accounts.some((row) => row.active && row.purpose === "ocr" && row.api_format === "chat_completions" && row.model === target)) {
    throw refuse("integration_ai_invalid", "请先启用支持该模型的 Chat Completions 账号")
  }
  // Pricing is also checked by Cloud atomically with the replace; account models stay independent.
  return { ...config, ai_default_model: target }
}

const RUNTIME_COUNT_MAX = 100_000
const RUNTIME_LEASE_MAX = 3600

/** What Cloud would refuse about these ceilings, in the words the form shows; `undefined` when valid. */
export function aiRuntimeProblem(runtime: AiRuntime): string | undefined {
  const counts = [runtime.max_concurrency_global, runtime.max_concurrency_user, runtime.max_concurrency_account, runtime.user_rate_per_minute]
  if (!counts.every((value) => Number.isInteger(value) && value >= 0 && value <= RUNTIME_COUNT_MAX)) {
    return `并发与频率须为 0 到 ${RUNTIME_COUNT_MAX} 的整数，0 表示不限`
  }
  const lease = runtime.lease_ttl_seconds
  if (!Number.isInteger(lease) || lease < 1 || lease > RUNTIME_LEASE_MAX) {
    return `租约时长须为 1 到 ${RUNTIME_LEASE_MAX} 秒的整数`
  }
  return undefined
}

/** Replace the runtime settings; accounts, default model and keys travel unchanged. */
export function applyAiRuntime(config: Config, runtime: AiRuntime): Config {
  const problem = aiRuntimeProblem(runtime)
  if (problem) throw refuse("integration_ai_invalid", problem)
  return { ...config, ai_runtime: { ...runtime } }
}
