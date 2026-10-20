/**
 * 漏斗销售额的展示口径。
 *
 * `revenue` 是 Ozon `/v1/analytics/data` 的卢布原值，没有币种字段。
 * 只有当记录的报价币种就是店铺合同币种、且汇率为正时，才换成该币种
 * （人民币店即 `revenue / fxRate`）。否则原样标成 RUB，绝不套合同币种代码。
 */
import { formatStoreMoney } from "@/lib/format"

import type { StoreProductMetrics } from "./products-api"

export type AnalyticsAmount = {
  /** 展示用金额，已经是 `currency` 的单位。 */
  amount: number
  currency: string
  text: string
  /** 换算过时给悬停：卢布原值、汇率与汇率日。未换算则为 null。 */
  title: string | null
}

const ISO = /^[A-Z]{3}$/

export function analyticsRevenue(
  metrics: Pick<
    StoreProductMetrics,
    "revenue" | "revenue_currency" | "fx_quote" | "fx_rate" | "fx_as_of"
  >,
  storeCurrency: string | null | undefined,
): AnalyticsAmount {
  const unit = (metrics.revenue_currency || "RUB").trim().toUpperCase()
  if (unit !== "RUB") {
    return plain(metrics.revenue, unit)
  }
  const quote = metrics.fx_quote?.trim().toUpperCase() ?? ""
  const store = storeCurrency?.trim().toUpperCase() ?? ""
  const rate = metrics.fx_rate
  if (
    ISO.test(quote) &&
    quote !== "RUB" &&
    quote === store &&
    rate != null &&
    Number.isFinite(rate) &&
    rate > 0 &&
    metrics.fx_as_of
  ) {
    return {
      amount: metrics.revenue / rate,
      currency: quote,
      text: formatStoreMoney(metrics.revenue / rate, quote),
      title: `原销售额 ${formatStoreMoney(metrics.revenue, "RUB")} · 1 ${quote} = ${formatRate(rate)} RUB · ${metrics.fx_as_of} · 俄罗斯央行`,
    }
  }
  return plain(metrics.revenue, "RUB")
}

function plain(amount: number, currency: string): AnalyticsAmount {
  return {
    amount,
    currency,
    text: formatStoreMoney(amount, currency),
    title: null,
  }
}

function formatRate(rate: number): string {
  return rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
}
