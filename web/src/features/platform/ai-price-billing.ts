import { estimateCallYuan } from "@/lib/ai-call-estimate"
import type { AiPriceView, PublishAiPriceRequest } from "@/bindings/commands"

/** 计费编辑态。输入单位一律是人民币元；换算成整数 microfen 只在存取边界做。 */
export type AiBillingDraft = {
  mode: "token" | "per_request"
  rateInput: string
  rateCachedInput: string
  rateOutput: string
  rateReasoning: string
  holdYuan: string
  perRequestYuan: string
}

/** 1 元 = 10^8 microfen，也是费率（元/百万 tokens）能精确到的位数。 */
const MICROFEN_PER_YUAN = 100_000_000

/** 元输入 → 整数 microfen；按数字串拼接，不过浮点，非法返回 undefined。 */
export function parseYuanToMicrofen(value: string): number | undefined {
  const text = value.trim()
  if (!/^\d{1,7}(\.\d{1,8})?$/.test(text)) return undefined
  const [whole, fraction = ""] = text.split(".")
  return Number(whole + fraction.padEnd(8, "0"))
}

/** 整数 microfen → 元输入串（去掉尾随零；小值不走科学计数法）。 */
export function microfenToYuan(microfen: number): string {
  return (microfen / MICROFEN_PER_YUAN).toFixed(8).replace(/\.?0+$/, "")
}

/** 元金额 → 展示串：最多 4 位小数，去掉尾随零。 */
export function formatYuan(yuan: number): string {
  return yuan.toFixed(4).replace(/\.?0+$/, "")
}

/** 编辑态 ← 当前生效价（无价则给可直接发布的空白默认）。 */
export function billingDraftFromPrice(price?: AiPriceView): AiBillingDraft {
  if (!price) {
    return {
      mode: "token",
      rateInput: "",
      rateCachedInput: "0",
      rateOutput: "",
      rateReasoning: "0",
      holdYuan: "0.05",
      perRequestYuan: "",
    }
  }
  return {
    mode: price.billing_mode === "per_request" ? "per_request" : "token",
    rateInput: microfenToYuan(price.input_microfen_per_million),
    rateCachedInput: microfenToYuan(price.cached_input_microfen_per_million),
    rateOutput: microfenToYuan(price.output_microfen_per_million),
    rateReasoning: microfenToYuan(price.reasoning_microfen_per_million),
    holdYuan: microfenToYuan(price.max_request_microfen),
    perRequestYuan: price.per_request_microfen
      ? microfenToYuan(price.per_request_microfen)
      : "",
  }
}

/** 发布请求 ← 编辑态；非法输入返回 undefined（保存按钮据此禁用）。 */
export function publishRequestFromBilling(
  model: string,
  billing: AiBillingDraft,
): PublishAiPriceRequest | undefined {
  const modelId = model.trim()
  // Cloud 也只收无空白、无控制字符的 id——客户端先拦，提示才能指名问题。
  if (!modelId || /\s/.test(modelId)) return undefined
  if (billing.mode === "per_request") {
    const perRequest = parseYuanToMicrofen(billing.perRequestYuan)
    if (perRequest === undefined || perRequest <= 0) return undefined
    return {
      model: modelId,
      billing_mode: "per_request",
      input_microfen_per_million: 0,
      cached_input_microfen_per_million: 0,
      output_microfen_per_million: 0,
      reasoning_microfen_per_million: 0,
      per_request_microfen: perRequest,
      max_request_microfen: perRequest,
    }
  }
  const input = parseYuanToMicrofen(billing.rateInput)
  const cached = parseYuanToMicrofen(billing.rateCachedInput.trim() || "0")
  const output = parseYuanToMicrofen(billing.rateOutput)
  const reasoning = parseYuanToMicrofen(billing.rateReasoning.trim() || "0")
  const hold = parseYuanToMicrofen(billing.holdYuan.trim() || "0.05")
  if (
    input === undefined ||
    cached === undefined ||
    output === undefined ||
    reasoning === undefined ||
    hold === undefined ||
    hold <= 0
  ) {
    return undefined
  }
  // 全零的 Token 价是被发布的免费识图——与服务端同一条拒绝规则。
  if (input + cached + output + reasoning === 0) return undefined
  return {
    model: modelId,
    billing_mode: "token",
    input_microfen_per_million: input,
    cached_input_microfen_per_million: cached,
    output_microfen_per_million: output,
    reasoning_microfen_per_million: reasoning,
    per_request_microfen: 0,
    max_request_microfen: hold,
  }
}

/** 编辑态折算出的单次典型识图成本（元）；输入不全时 undefined。 */
export function estimateDraftYuan(billing: AiBillingDraft): number | undefined {
  if (billing.mode === "per_request") {
    const flat = parseYuanToMicrofen(billing.perRequestYuan)
    return flat !== undefined && flat > 0 ? flat / MICROFEN_PER_YUAN : undefined
  }
  const input = parseYuanToMicrofen(billing.rateInput)
  const output = parseYuanToMicrofen(billing.rateOutput)
  if (input === undefined || output === undefined) return undefined
  return estimateCallYuan({ input_microfen_per_million: input, output_microfen_per_million: output })
}
