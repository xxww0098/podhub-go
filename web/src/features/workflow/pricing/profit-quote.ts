import type { ManualProfitAssumptions, PricingCurrency } from "@/bindings/listing-projection"
import type { WorkflowDraftValue } from "@/bindings/commands"
export type { ManualProfitAssumptions, PricingCurrency } from "@/bindings/listing-projection"

export type ManualProfitQuote = {
  basis: "manual_assumptions"
  currency: PricingCurrency
  price: string
  priceMinor: string
  fixedCostMinor: string
  costs: { name: string; sourceCurrency: PricingCurrency; sourceMinor: string; convertedMinor: string }[]
  fees: { name: string; rateBps: number; amountMinor: string }[]
  profitMinor: string
  targetMarginBps: number
}

const BPS = 10_000n
const MAX_MINOR = 999_999_999_999n

export function percentToBps(value: string): number {
  let amount: bigint, scale: bigint
  try { [amount, scale] = decimal(value, 2) } catch { throw new Error("费率与净利率请填写 0–99.99 的百分比") }
  const result = amount * 100n / scale
  if (result >= BPS) throw new Error("费率与净利率必须低于 100%")
  return Number(result)
}

export function minorMoney(value: string): string {
  const amount = BigInt(value)
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`
}

/** Rechecked against the latest card inside the CAS builder, including a conflict replay. */
export function profitQuoteApplyIssue(
  savedCurrency: WorkflowDraftValue | undefined,
  quoteCurrency: PricingCurrency,
  price: string,
  oldPrice?: string,
): string | undefined {
  if (savedCurrency?.kind !== "text" || !savedCurrency.value.trim()) return "未取得方案售价币种，当前仅可试算"
  if (savedCurrency.value.trim() !== quoteCurrency) return `方案币种 ${savedCurrency.value.trim()} 与试算币种不一致`
  if (oldPrice === undefined) return undefined
  try {
    const [old, scale] = decimal(oldPrice, 8)
    const [sale, saleScale] = decimal(price, 2)
    if (old !== 0n && sale * scale >= old * saleScale) return "建议售价需小于当前划线价"
  } catch {
    return "当前划线价格式无效，请先修正"
  }
  return undefined
}

function currency(value: unknown): asserts value is PricingCurrency {
  if (value !== "CNY" && value !== "RUB") throw new Error("试算仅支持 CNY 与 RUB，金额精度为两位小数")
}

function decimal(input: string, digits: number): [bigint, bigint] {
  if (typeof input !== "string" || input.trim().length > 24) throw new Error("金额或汇率格式无效")
  const matched = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input.trim())
  if (!matched || (matched[2]?.length ?? 0) > digits) throw new Error("金额或汇率格式无效")
  const fraction = matched[2] ?? ""
  return [BigInt(matched[1]! + fraction), 10n ** BigInt(fraction.length)]
}

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

function bounded(value: bigint): bigint {
  if (value > MAX_MINOR) throw new Error("金额超出试算上限")
  return value
}

function bps(value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || value >= 10_000) throw new Error("费率与利润率必须是 0–9999 的整数基点")
  return BigInt(value)
}

/** Conservative per-item quote for supplied assumptions; never an official fee estimate. */
export function calculateManualProfitQuote(input: ManualProfitAssumptions): ManualProfitQuote {
  currency(input.currency)
  if (!Array.isArray(input.costs) || !input.costs.length || input.costs.length > 32 || !Array.isArray(input.fees) || input.fees.length > 32) {
    throw new Error("请提供 1–32 项成本及不超过 32 项费率")
  }
  const margin = bps(input.targetMarginBps)
  const costs = input.costs.map((cost) => {
    currency(cost.currency)
    if (typeof cost.name !== "string" || !cost.name.trim() || [...cost.name.trim()].length > 80) throw new Error("成本名称必须为 1–80 字")
    const [amount, scale] = decimal(cost.amount, 2)
    const source = bounded(amount * 100n / scale)
    const [rate, rateScale] = cost.exchangeRate === undefined ? [1n, 1n] : decimal(cost.exchangeRate, 8)
    if (rate <= 0n || rate > rateScale * 1_000_000n) throw new Error("汇率必须大于零且不超过 1000000")
    if (cost.currency !== input.currency && cost.exchangeRate === undefined) throw new Error("跨币种成本必须明确提供成本币种到售价币种的汇率")
    if (cost.currency === input.currency && rate !== rateScale) throw new Error("同币种成本不能使用非 1 汇率")
    return { name: cost.name.trim(), sourceCurrency: cost.currency, sourceMinor: source.toString(), convertedMinor: bounded(ceil(source * rate, rateScale)).toString() }
  })
  const fixed = bounded(costs.reduce((sum, cost) => sum + BigInt(cost.convertedMinor), 0n))
  const fees = input.fees.map((fee) => {
    if (typeof fee.name !== "string" || !fee.name.trim() || [...fee.name.trim()].length > 80) throw new Error("费用名称必须为 1–80 字")
    return { name: fee.name.trim(), rate: bps(fee.rateBps), rateBps: fee.rateBps }
  })
  const headroom = BPS - margin - fees.reduce((sum, fee) => sum + fee.rate, 0n)
  if (headroom <= 0n) throw new Error("总费率与目标利润率达到 100%，无法求得正售价")
  const lower = ceil(fixed * BPS, headroom) || 1n
  let price: bigint | undefined
  // Rounded margins need not be monotone. Each 10000-minor-unit step adds exactly headroom.
  for (let offset = 0n; offset < BPS; offset += 1n) {
    const first = lower + offset
    if (first > MAX_MINOR || price !== undefined && first >= price) break
    const slack = first - fixed - fees.reduce((sum, fee) => sum + ceil(first * fee.rate, BPS), 0n) - ceil(first * margin, BPS)
    const candidate = first + (slack < 0n ? ceil(-slack, headroom) * BPS : 0n)
    if (candidate <= MAX_MINOR && (price === undefined || candidate < price)) price = candidate
  }
  if (price === undefined) throw new Error("金额上限内无法达到目标利润率")
  const resultFees = fees.map((fee) => ({ name: fee.name, rateBps: fee.rateBps, amountMinor: ceil(price * fee.rate, BPS).toString() }))
  const profit = price - fixed - resultFees.reduce((sum, fee) => sum + BigInt(fee.amountMinor), 0n)
  return {
    basis: "manual_assumptions", currency: input.currency,
    price: `${price / 100n}.${(price % 100n).toString().padStart(2, "0")}`, priceMinor: price.toString(),
    fixedCostMinor: fixed.toString(), costs, fees: resultFees, profitMinor: profit.toString(), targetMarginBps: input.targetMarginBps,
  }
}
