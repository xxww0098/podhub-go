/**
 * 店铺期末余额的展示口径。
 *
 * 数字来自 `POST /v1/finance/balance` 的 `total.closing_balance`：期末余额，
 * 不是可提现额度（Seller API 没有这个字段）。币种只认接口带回的
 * `currency_code`。只有原币是 RUB、且读取时盖上了俄罗斯央行对合同币种的
 * 报价，才按 `amount / fxRate` 换成合同币种；否则原样标成接口币种，绝不
 * 把空币种或非卢布金额写成卢布。
 */
import { formatStoreMoney } from "@/lib/format"

export type StoreFinanceBalance = {
  outcome: "ready" | "forbidden" | "unavailable" | "error"
  amount?: string | null
  currency_code?: string | null
  period_to: string
  fetched_at_ms: number
  fx_quote?: string | null
  fx_rate?: string | null
  fx_as_of?: string | null
  fx_source?: string | null
}

export type FinanceBalanceDisplay = {
  text: string
  title: string
  /** 上次读取失败，格子可以再请求一次刷新。 */
  retry: boolean
  /** 状态字（尚未读取、无权限、失败）用弱色；金额用正常前景。 */
  muted: boolean
}

const ISO = /^[A-Z]{3}$/

export function financeBalanceDisplay(
  snapshot: StoreFinanceBalance | null | undefined,
  options: { configured: boolean; reading: boolean },
): FinanceBalanceDisplay {
  if (!options.configured) {
    return { text: "—", title: "尚未登记密钥", retry: false, muted: true }
  }
  if (!snapshot) {
    return options.reading
      ? { text: "读取中", title: "正在读取期末余额", retry: false, muted: true }
      : { text: "—", title: "尚未读取期末余额", retry: false, muted: true }
  }
  switch (snapshot.outcome) {
    case "forbidden":
      return { text: "无权限", title: "Ozon 拒绝了这把密钥读取财务余额", retry: false, muted: true }
    case "unavailable":
      return { text: "暂无", title: "财务余额接口没有返回期末金额或币种", retry: false, muted: true }
    case "error":
      return { text: "读取失败", title: "上次读取财务余额失败，可重试", retry: true, muted: true }
    case "ready":
      return ready(snapshot)
  }
}

function ready(snapshot: StoreFinanceBalance): FinanceBalanceDisplay {
  const amount = Number(snapshot.amount)
  const currency = snapshot.currency_code?.trim().toUpperCase() ?? ""
  if (!Number.isFinite(amount) || !currency) {
    return { text: "暂无", title: "财务余额接口没有返回期末金额或币种", retry: false, muted: true }
  }
  const quote = snapshot.fx_quote?.trim().toUpperCase() ?? ""
  const rate = snapshot.fx_rate == null ? Number.NaN : Number(snapshot.fx_rate)
  if (
    currency === "RUB" &&
    ISO.test(quote) &&
    quote !== "RUB" &&
    Number.isFinite(rate) &&
    rate > 0 &&
    snapshot.fx_as_of &&
    snapshot.fx_source === "cbr"
  ) {
    const converted = amount / rate
    return {
      text: formatStoreMoney(converted, quote, 2),
      title: `期末 ${snapshot.period_to} · 原值 ${formatStoreMoney(amount, "RUB", 2)} · 1 ${quote} = ${formatRate(rate)} RUB · ${snapshot.fx_as_of} · 俄罗斯央行`,
      retry: false,
      muted: false,
    }
  }
  return {
    text: formatStoreMoney(amount, currency, 2),
    title: `期末 ${snapshot.period_to}`,
    retry: false,
    muted: false,
  }
}

function formatRate(rate: number): string {
  return rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
}
