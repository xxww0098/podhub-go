import { AI_MODEL_CHOICES, type AiModelChoice } from "@/lib/ai-model-presets"
import type { AiAccountView, AiApiFormat, AiThinking, AiThinkingFormat, ListAiModelsRequest } from "@/bindings/commands"

/** Pick a matching account for a read-only probe; runtime rotation remains server-owned. */
export function accountForModel(accounts: AiAccountView[] | undefined, model: string): AiAccountView | undefined {
  return accounts?.filter((row) => row.active && row.configured && row.api_format === "chat_completions" && row.model === model)
    .sort((a, b) => b.priority - a.priority)[0]
}

/** Normalize an endpoint for identity comparison; trailing slashes are cosmetic. */
export function endpointIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export type ModelCatalogueProbe =
  | { status: "ready"; request: ListAiModelsRequest }
  | { status: "blocked"; reason: string }

/**
 * Model-catalogue preconditions mirror the Cloud probe contract
 * (`src/ai/probe.rs::resolve`): a stored account's key may serve an unchanged
 * endpoint, but a new account or a changed endpoint must carry its own key.
 */
export function modelCatalogueProbe(input: {
  account?: AiAccountView
  baseUrl: string
  apiKey: string
  apiFormat: AiApiFormat
}): ModelCatalogueProbe {
  const baseUrl = input.baseUrl.trim()
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return { status: "blocked", reason: "请先在高级设置中填写有效的服务地址。" }
  }
  const endpointChanged = Boolean(input.account && (
    endpointIdentity(baseUrl) !== endpointIdentity(input.account.base_url) ||
    input.apiFormat !== input.account.api_format
  ))
  if ((endpointChanged || !input.account) && !input.apiKey.trim()) {
    return {
      status: "blocked",
      reason: endpointChanged
        ? "更换服务地址或接口格式后，需要重新填写密钥。"
        : "请先填写密钥，再拉取模型列表。",
    }
  }
  return {
    status: "ready",
    request: {
      id: input.account?.id ?? null,
      base_url: baseUrl,
      api_format: input.apiFormat,
      api_key: input.apiKey.trim(),
    },
  }
}

export function matchModelChoice(account: {
  model: string
  base_url: string
  api_format: AiApiFormat
  thinking: AiThinking
  thinking_format: AiThinkingFormat
}): AiModelChoice | undefined {
  if (account.api_format !== "chat_completions") return undefined
  return AI_MODEL_CHOICES.find((choice) =>
    choice.model === account.model
    && endpointIdentity(choice.baseUrl) === endpointIdentity(account.base_url)
    && choice.thinking === account.thinking
    && choice.thinkingFormat === account.thinking_format,
  )
}

/** A blank name, or a name still equal to a choice's default, may be replaced when the choice changes. */
export function accountLabelFollowsChoice(label: string): boolean {
  const trimmed = label.trim()
  return trimmed.length === 0 || AI_MODEL_CHOICES.some((choice) => choice.accountLabel === trimmed)
}

export function accountModelLine(account: {
  model: string
  base_url: string
  api_format: AiApiFormat
  thinking: AiThinking
  thinking_format: AiThinkingFormat
}): { model: string; service: string } {
  const choice = matchModelChoice(account)
  return choice
    ? { model: choice.label, service: choice.service }
    : { model: account.model, service: account.base_url }
}

export type ConnectionProbeRequest = {
  id: string | null
  model: string
  baseUrl: string
  apiKey?: string
  apiFormat: AiApiFormat
}

export type ConnectionProbe =
  | { status: "ready"; request: ConnectionProbeRequest }
  | { status: "blocked"; reason: string }

/**
 * Connection test reads the upstream model catalogue. It checks the key and
 * whether the chosen model is listed; it does not send a completion.
 */
export function connectionProbe(input: {
  accountId?: string | null
  stored?: { base_url: string; api_format: AiApiFormat; configured: boolean }
  baseUrl: string
  apiKey: string
  apiFormat: AiApiFormat
  model: string
}): ConnectionProbe {
  const model = input.model.trim()
  if (!model || /\s/.test(model)) return { status: "blocked", reason: "请先选择或填写模型。" }
  const baseUrl = input.baseUrl.trim()
  if (!baseUrl || !URL.canParse(baseUrl)) return { status: "blocked", reason: "请先在高级设置中填写有效的服务地址。" }
  const endpointChanged = Boolean(input.stored && (
    endpointIdentity(baseUrl) !== endpointIdentity(input.stored.base_url)
    || input.apiFormat !== input.stored.api_format
  ))
  const apiKey = input.apiKey.trim()
  const canUseStored = Boolean(input.accountId && input.stored?.configured && !endpointChanged)
  if (!apiKey && !canUseStored) {
    return {
      status: "blocked",
      reason: endpointChanged
        ? "更换服务地址或接口格式后，需要重新填写密钥。"
        : "请先填写密钥，再测试连接。",
    }
  }
  return {
    status: "ready",
    request: {
      id: input.accountId?.trim() || null,
      model,
      baseUrl,
      apiFormat: input.apiFormat,
      ...(apiKey ? { apiKey } : {}),
    },
  }
}
