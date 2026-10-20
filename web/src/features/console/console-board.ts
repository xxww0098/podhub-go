/**
 * 大屏面板级派生：排行、上架日序列、环比百分比与运营建议。只读
 * console-metrics / console-products 的投影结果，不再回读 wire 形状。
 */
import type { ConsoleLedgerEntry } from "@/bindings/commands"

import type { CohortDelta, StoreRosterRow, StoreRosterSummary } from "./console-metrics"
import { ROSTER_STATUS } from "./console-metrics"
import { formatInteger } from "./console-format"

/**
 * 上架量日序列：submission_intents 的 created 按 UTC 日落到给定的日期轴上。
 * 轴来自店铺出单序列（Ozon analytics 以 UTC 日结算），所以这里同样用 UTC
 * 口径——两条线才能共享一条 X 轴。
 */
export function listingDailySeries(
  entries: Pick<ConsoleLedgerEntry, "kind" | "created_at_ms">[],
  dayKeys: string[],
): number[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== "listing") continue
    const key = new Date(entry.created_at_ms).toISOString().slice(0, 10)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return dayKeys.map((key) => counts.get(key) ?? 0)
}

export type StoreRankRow = {
  storeId: string
  name: string
  /** 窗口内出单量 — 该店 day_series 的合计（当前为近 14 日）。 */
  units: number
  /** 环比：序列后半窗口对前半窗口的百分比；前半为 0 时无对照。 */
  deltaPct: number | null
}

/** 店铺出单排行：只排可读店铺，按窗口出单量降序。 */
export function storeRankings(rows: StoreRosterRow[]): StoreRankRow[] {
  return rows
    .filter((row) => ROSTER_STATUS[row.status].readable)
    .map((row) => {
      const series = row.daySeries
      const units = series.reduce((sum, value) => sum + value, 0)
      const mid = Math.floor(series.length / 2)
      const previous = series.slice(0, mid).reduce((sum, value) => sum + value, 0)
      const recent = series.slice(mid).reduce((sum, value) => sum + value, 0)
      return {
        storeId: row.storeId,
        name: row.name,
        units,
        deltaPct: mid > 0 && previous > 0 ? ((recent - previous) / previous) * 100 : null,
      }
    })
    .sort((left, right) => {
      const units = right.units - left.units
      const name = left.name.localeCompare(right.name, "zh-CN")
      const storeId = left.storeId < right.storeId ? -1 : left.storeId > right.storeId ? 1 : 0
      return units || name || storeId
    })
}

/** 30 日窗口的环比百分比；上一口径为 0 时给不出有意义的百分比。 */
export function cohortPercentDelta(delta: CohortDelta): number | null {
  if (delta.kind !== "comparable" || delta.previous <= 0) return null
  return (delta.delta / delta.previous) * 100
}

/**
 * 出单卡脚注 — 可读数为零时是「没有数据」，绝不说「全部正常」；有读数才
 * 附环比对照。
 */
export function ordersFootnote(roster: StoreRosterSummary): string {
  if (roster.coverage.total === 0) return "暂无可见店铺"
  if (roster.coverage.read === 0) return "暂无可读店铺"
  const coverage = `覆盖 ${roster.coverage.read}/${roster.coverage.total} 店`
  const delta = roster.cohortDelta
  return delta.kind === "comparable"
    ? `${coverage} · 较上 30 日 ${delta.delta > 0 ? "+" : ""}${formatInteger(delta.delta)} 件`
    : `${coverage} · ${delta.reason ?? "暂无同口径对照"}`
}


export type ConsoleAdvice = {
  text: string
  /** 建议指向的屏；null 表示纯观察。 */
  target: "products" | "stores" | "listing" | null
}

/**
 * 运营建议：按优先级取前两条。规则全部从大屏已读的事实推导，一条建议
 * 必须能落到一个动作或一个明确的「继续保持」。
 */
export function buildAdvice(input: {
  failedReads: number
  needsAction: number
  pending: number
  zeroStock: number | null
  quotaUsed: number | null
  quotaLimit: number | null
  /** 近 7 日收敛率（listedSettled/listed %）；无样本为 null。 */
  settleRate: number | null
  listed7d: number
  readableStores: number
}): ConsoleAdvice[] {
  const advice: ConsoleAdvice[] = []
  if (input.readableStores === 0) {
    advice.push({
      text: "暂无可读的店铺经营数据，请先绑定店铺并同步指标。",
      target: "stores",
    })
    return advice
  }
  if (input.failedReads > 0) {
    advice.push({
      text: `${input.failedReads} 家店铺指标读取失败，建议检查店铺凭据后刷新。`,
      target: "stores",
    })
  }
  if (input.needsAction > 0) {
    advice.push({
      text: `${input.needsAction} 项操作待介入，建议先完成对账再继续提交。`,
      target: "products",
    })
  }
  if (input.quotaUsed !== null && input.quotaLimit && input.quotaLimit > 0) {
    const ratio = input.quotaUsed / input.quotaLimit
    if (ratio >= 0.9) {
      advice.push({
        text: `上架额度已用 ${Math.round(ratio * 100)}%，接近上限，建议清理低效在售。`,
        target: "products",
      })
    }
  }
  if (input.pending > 0) {
    advice.push({
      text: `${input.pending} 件商品待处理（隐藏或审核失败），建议检查并修复。`,
      target: "products",
    })
  }
  if (input.zeroStock !== null && input.zeroStock > 0) {
    advice.push({
      text: `${input.zeroStock} 件在售商品零库存，建议补货或下架以免影响转化。`,
      target: "products",
    })
  }
  if (advice.length === 0) {
    if (input.settleRate !== null) {
      const rate = Math.round(input.settleRate)
      advice.push({
        text:
          rate >= 50
            ? `近 7 日上架收敛率 ${rate}%，表现优秀，建议继续保持上新节奏。`
            : `近 7 日上架收敛率 ${rate}%，可关注失败记录并优化商品字段。`,
        target: "listing",
      })
    } else {
      advice.push({
        text: "近 7 日暂无上架记录，保持上新节奏有助于提升曝光。",
        target: "listing",
      })
    }
  }
  return advice.slice(0, 2)
}
