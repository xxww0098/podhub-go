import type { AppScreen } from "@/lib/app-screens"
import type { ConsoleLedgerEntry, ListingCardSummary } from "@/bindings/commands"
import type { IntentReviewCounts } from "@/bindings/http-listing-intents"
import type { StateTone } from "@/lib/receipt-state"
import type { ReviewKind } from "./recent-submissions-read"
import { ledgerMayBeTruncated } from "@/features/console/console-board"
import { summarizeLedger } from "@/features/console/console-metrics"
import { parseStoreIds } from "@/features/workflow/store-quota"

export const HOME_MODULES = [
  { id: "listing", label: "批量上架", description: "从选品到发布，让商品更快抵达店铺。", keywords: ["上架", "发布商品", "listing", "publish"] },
  { id: "catalog", label: "平台商品库", description: "发现优质货源，挑选下一款热卖商品。", keywords: ["选品", "货源", "catalog", "supplier"] },
  { id: "products", label: "我的商品", description: "查看和管理店铺商品。", keywords: ["店铺商品", "商品管理", "products"] },
  { id: "ops-shipping", label: "订单发货", description: "查看待发订单，安排打包与物流。", keywords: ["订单", "发货", "物流", "shipping", "orders"] },
  { id: "console", label: "经营数据", description: "查看上架、销量与店铺经营数据。", keywords: ["数据", "数据大屏", "大屏", "销售", "经营", "报表", "dashboard", "sales"] },
  { id: "stores", label: "店铺管理", description: "连接你的 Ozon 店铺，管理 Seller 密钥。", keywords: ["店铺", "密钥", "连接", "stores", "ozon"] },
  { id: "message-center", label: "客服消息", description: "跟进买家消息，及时回应每一个问题。", keywords: ["消息", "客服", "聊天", "message"] },
  { id: "delegate-orders", label: "委托订单", description: "追踪委托订单，协同完成生产与履约。", keywords: ["委托", "生产", "delegate"] },
  { id: "ops-returns", label: "售后退货", description: "查看 Ozon 退货单与取消申请。", keywords: ["售后", "退货", "退款", "returns"] },
  { id: "ops-supply", label: "入仓供货", description: "管理供货与入仓，保持库存有序流转。", keywords: ["入仓", "供货", "仓库", "supply"] },
  { id: "ops-voice", label: "评价口碑", description: "查看商品评价，了解买家的真实反馈。", keywords: ["评价", "口碑", "反馈", "reviews"] },
  { id: "usage", label: "用量", description: "查看工作空间用量与费用明细。", keywords: ["用量", "费用", "账单", "usage"] },
] as const satisfies readonly { id: AppScreen; label: string; description: string; keywords: readonly string[] }[]

export function findHomeModules(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return [...HOME_MODULES]
  return HOME_MODULES.filter((module) => {
    const words = [module.label, ...module.keywords].map((word) => word.toLocaleLowerCase())
    return terms.every((term) => words.some((word) => word.includes(term) || term.includes(word)))
  })
}

export function homeListingSummary(entries: ConsoleLedgerEntry[], nowMs: number) {
  const listing = entries.filter((entry) => entry.kind === "listing")
  return {
    ...summarizeLedger(listing, nowMs),
    mayBeTruncated: ledgerMayBeTruncated(entries),
    unknown: listing.filter((entry) => entry.status === "unknown" || entry.status === "result_unknown").length,
    failed: listing.filter((entry) => entry.status === "failed" || entry.status === "conflict").length,
  }
}

export function homeListingCount(value: number, mayBeTruncated: boolean): string {
  return `${mayBeTruncated ? "≥" : ""}${value}`
}

export function homeListingHeadline(summary: Pick<ReturnType<typeof homeListingSummary>, "needsAction" | "mayBeTruncated">): string {
  if (summary.needsAction > 0) return `${summary.mayBeTruncated ? "至少 " : ""}${summary.needsAction} 项上架提交需要核对`
  return summary.mayBeTruncated ? "上架账本可能不完整" : "近期上架提交暂无待核对事项"
}

/** The one review breakdown the status bar and its group chips share. */
export function reviewAttention(counts: IntentReviewCounts): { kind: ReviewKind; label: string; count: number; tone: StateTone }[] {
  const items: { kind: ReviewKind; label: string; count: number; tone: StateTone }[] = [
    { kind: "unknown", label: "结果未知", count: counts.unknown, tone: "unknown" },
    { kind: "failed", label: "失败或冲突", count: counts.rejected + counts.conflict, tone: "bad" },
    { kind: "accepted_issue", label: "受理后需核对", count: counts.accepted_issue, tone: "bad" },
  ]
  return items.filter((item) => item.count > 0)
}

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  unknown: "结果未知",
  failed: "失败或冲突",
  accepted_issue: "受理后需核对",
}

/** The count an attention entry opens; counts always cover the whole workspace. */
export function reviewScopeCount(counts: IntentReviewCounts, kind: ReviewKind | "all"): number {
  switch (kind) {
    case "unknown": return counts.unknown
    case "failed": return counts.rejected + counts.conflict
    case "accepted_issue": return counts.accepted_issue
    default: return counts.needs_review
  }
}

/** An empty search is not a navigation; it must not open the first module. */
export function homeSearchTarget(query: string, selection: number): AppScreen | undefined {
  if (!query.trim()) return undefined
  const matches = findHomeModules(query)
  return matches[Math.max(0, Math.min(selection, matches.length - 1))]?.id
}

export function recentHomePlans(cards: ListingCardSummary[], query: string, storeId = "") {
  const term = query.trim().toLocaleLowerCase()
  return cards
    .filter((card) => !term || card.display_name.toLocaleLowerCase().includes(term))
    .filter((card) => !storeId || parseStoreIds(card.target_store_id).includes(storeId))
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
    .slice(0, 5)
}
