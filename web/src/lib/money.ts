export const MIN_TOPUP_CENTS = 100
export const MAX_TOPUP_CENTS = 1_000_000

/** 1 分 = 10^6 microfen，1 元 = 100 分：整数换算，显示精度跟着金额量级走。 */
// 计费的最小一档是一次调用 ¥0.003 —— 两位小数会把它显示成 ¥0.00，用户看到的是
// "扣了钱但数字没动"。所以 ¥1 以下放宽到 4 位，¥1 以上仍是 2 位：余额读成钱，
// 消费读成账。上限而非定宽，¥23.26 不会被补成 ¥23.2600。
export function formatYuan(microfen: number) {
  const yuan = microfen / 100_000_000
  return `¥${yuan.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(yuan) < 1 ? 4 : 2,
  })}`
}

/**
 * 元 typed by an operator → 分 the wallet moves in. The rounding happens once,
 * here, so no float reaches the request body; anything that is not a positive
 * amount is `null` rather than a zero the server has to refuse.
 */
export function topupCentsFromYuan(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === "") return null
  const yuan = Number(trimmed)
  if (!Number.isFinite(yuan)) return null
  const cents = Math.round(yuan * 100)
  return cents > 0 ? cents : null
}

/** 分 → ¥: the commission wallet's own unit, shown with the same rules. */
export function formatCents(cents: number): string {
  return formatYuan(cents * 1_000_000)
}
