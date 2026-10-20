/**
 * Shared display formatters. `Intl` constructors are expensive; every
 * formatter here is a module-level singleton so table cells can call them
 * per row without rebuilding one per render.
 */

/** 月-日 时:分:秒，日志与审计表的时间戳口径。 */
const DATE_TIME_SECONDS = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/** 年月日 时:分，通知、成员与订单列表的时间戳口径。 */
const DATE_TIME_SHORT = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
})

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return DATE_TIME_SECONDS.format(date)
}

export function formatDateTimeShort(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return DATE_TIME_SHORT.format(date)
}

/** 年月日（`2026/01/05`）；期限类日期要写明是哪一年，跨年才不歧义。 */
const DATE_ONLY = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function formatDate(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return DATE_ONLY.format(date)
}

/** ISO 日（`2026-01-05`）→ 月/日短口径（`01/05`）；图表轴与窗口区间的统一写法。 */
export function formatShortDay(day: string): string {
  return day.slice(5).replace("-", "/")
}

/** 字节数的可读形式；0 与非法输入返回 "0 B"，需要空串语义的调用方自己前置判断。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024)
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024
    return `${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)} KB`
  }
  return `${bytes} B`
}

/**
 * 卢布金额（`1 349,36 ₽`）— `formatStoreMoney` 的 RUB 分支，俄式千分位与
 * 小数逗号。
 */
const RUB_MONEY = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
})

/**
 * 漏斗计数（浏览/访客/加购/出单）的整数口径 — Ozon analytics 回的是 double，
 * 展示层取整；`null`/非有限值给 "—"（缺失不是零）。
 */
const COUNT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 })

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return COUNT.format(value)
}

/**
 * 百分点显示（`7.5%`）— Ozon `conv_tocart` 已是百分数（7.5 即 7.5%），
 * 这里只负责收尾，不再乘 100。
 */
const PERCENT_POINT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 })

export function formatPercentPoint(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${PERCENT_POINT.format(value)}%`
}

/**
 * 店铺合同币种金额 — 标价、活动价。RUB 走卢布格式；其他币种跟 ISO 代码
 * 原文（本函数不做汇率换算）；未知币种只给数字，绝不冒充卢布。金额可传镜像的
 * numeric 文本串（仅在展示层解析）；`fractionDigits: 2` 用于价格
 * 预览这类分币有意义的场合，聚合指标默认取整。
 *
 * 漏斗 `revenue` 不是合同币种（Ozon 固定回卢布）。不要把店铺币种传进来格式化
 * 它；换算与悬停原文在 `analyticsRevenue`。
 */
const MONEY_PLAIN = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 })
const MONEY_PLAIN_2 = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatStoreMoney(
  value: number | string | null | undefined,
  currency: string | null | undefined,
  fractionDigits: 0 | 2 = 0,
): string {
  if (value == null) return "—"
  const num = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  const code = currency?.trim().toUpperCase()
  if (code === "RUB") return RUB_MONEY.format(num)
  const amount = (fractionDigits === 2 ? MONEY_PLAIN_2 : MONEY_PLAIN).format(num)
  return code ? `${amount} ${code}` : amount
}
