import { AI_MODEL_CHOICES } from "@/lib/ai-model-presets"
import { estimateCallYuan, type AiCallPrice } from "@/lib/ai-call-estimate"
import { formatYuan } from "@/lib/money"

/**
 * How a catalogue model is named in the workbench picker.
 *
 * 档位 is the thinking tier already shown on the account form (`关闭思考` /
 * `低思考`), not a quality grade. Paid quality measurement is not approved,
 * so neither known nor unknown models are labeled 高精度. An id this list
 * does not name stays `未分档`.
 *
 * The single-call estimate matches `docs/pricing.md` §0 item 4 and
 * `ai-price-billing.ts` (`estimateCallYuan`): 40k uncached input + 3.5k
 * output. The published cache rate is displayed as stored and is not an
 * input to the estimate — do not apply a 5× cache factor here.
 */
export type OcrPriceRates = AiCallPrice & {
  cached_input_microfen_per_million: number
  reasoning_microfen_per_million: number
}

export type OcrModelFace = {
  tier: string
  displayName: string
  modelId: string
  /** 档位在前，展示名在后。模型 id 不在这一行。 */
  headline: string
}

function namedChoice(model: string) {
  const bare = model.slice(model.lastIndexOf("/") + 1).replace(/-\d{4}-\d{2}-\d{2}$/, "")
  return AI_MODEL_CHOICES.find(choice => choice.model.slice(choice.model.lastIndexOf("/") + 1) === bare)
}

export function ocrModelFace(model: string): OcrModelFace {
  const choice = namedChoice(model)
  if (!choice) {
    return { tier: "未分档", displayName: model, modelId: model, headline: `未分档 · ${model}` }
  }
  const tier = choice.label.split(" · ").at(-1) || "未分档"
  return {
    tier,
    displayName: choice.accountLabel,
    modelId: model,
    headline: `${tier} · ${choice.accountLabel}`,
  }
}

/** Published unit prices. Cache is the stored rate, not a derived multiple. */
export function ocrUnitPriceText(price: OcrPriceRates): string {
  if (price.billing_mode === "per_request") return `按次 ${formatYuan(price.per_request_microfen ?? 0)}/次`
  return [
    `输入 ${formatYuan(price.input_microfen_per_million)}/百万`,
    `缓存 ${formatYuan(price.cached_input_microfen_per_million)}/百万`,
    `输出 ${formatYuan(price.output_microfen_per_million)}/百万`,
    `思考 ${formatYuan(price.reasoning_microfen_per_million)}/百万`,
  ].join(" · ")
}

export function estimateCallMicrofen(price: OcrPriceRates): number {
  return Math.round(estimateCallYuan(price) * 100_000_000)
}

export function ocrEstimateText(price: OcrPriceRates): string {
  return `单次约 ${formatYuan(estimateCallMicrofen(price))}`
}
