/**
 * Console display formatters — one home so the screen never drifts on what
 * "9/7" or "2.5 小时" means.
 */

const consoleNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
})
const consoleInteger = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 })

export function formatInteger(value: number): string {
  return consoleInteger.format(value)
}

export function formatAge(hours: number | null): string {
  if (hours === null) return "无"
  if (hours < 1) return "不足 1 小时"
  if (hours < 24) return `${consoleNumber.format(hours)} 小时`
  return `${consoleNumber.format(hours / 24)} 天`
}

/** "+12.5%" / "-3.5%"；无对照为 null 时给 "—"。 */
export function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${consoleNumber.format(value)}%`
}
