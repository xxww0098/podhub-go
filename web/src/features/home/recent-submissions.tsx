import { useEffect, useRef, useState } from "react"
import { ClipboardList, Package, RefreshCw, Search } from "lucide-react"
import type { OzonStoreView } from "@/bindings/commands"
import type { IntentReviewCounts, ListingIntent } from "@/bindings/http-listing-intents"
import type { ListingRowView } from "@/bindings/listing-projection"
import { useScreenActive } from "@/components/screen-pane"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ProductThumb } from "@/features/products/product-thumb"
import { formatDateTimeYearMinute } from "@/lib/format"
import type { StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import { REVIEW_KIND_LABELS, reviewScopeCount } from "./home-model"
import { readRecentSubmissions, type RecentSubmission, type ReviewKind, type ReviewRead } from "./recent-submissions-read"

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "attention", label: "需要核对" },
  { id: "accepted", label: "平台受理" },
] as const
type Filter = typeof FILTERS[number]["id"]

const REVIEW_KINDS: { id: ReviewKind | "all"; label: string }[] = [
  { id: "all", label: "全部待核对" },
  { id: "unknown", label: REVIEW_KIND_LABELS.unknown },
  { id: "failed", label: REVIEW_KIND_LABELS.failed },
  { id: "accepted_issue", label: REVIEW_KIND_LABELS.accepted_issue },
]

/** An attention entry on the dashboard points the queue at its own records. */
export type ReviewFocus = { kind: ReviewKind | "all"; token: number }

export function submissionStatus(intent: Pick<ListingIntent, "state" | "current_issue_status">): { label: string; group: Exclude<Filter, "all"> | "other"; tone: StateTone } {
  switch (intent.state) {
    case "queued": return { label: "已排队", group: "active", tone: "flight" }
    case "submitting": return { label: "发送中", group: "active", tone: "flight" }
    case "accepted": return intent.current_issue_status === "absent"
      ? { label: "平台受理", group: "accepted", tone: "idle" }
      : { label: "受理后需核对", group: "attention", tone: "bad" }
    case "unknown":
    case "outcome_unknown": return { label: "结果未知", group: "attention", tone: "unknown" }
    case "rejected": return { label: "发送未完成", group: "attention", tone: "bad" }
    case "conflict": return { label: "结果冲突", group: "attention", tone: "bad" }
    case "superseded": return { label: "已替代", group: "other", tone: "idle" }
    case "cancelled": return { label: "已取消", group: "other", tone: "idle" }
    case "reconciled": return { label: "已核对", group: "other", tone: "idle" }
    case "operator_attested": return { label: "人工封存", group: "other", tone: "attest" }
    default: return { label: "未知状态", group: "attention", tone: "unknown" }
  }
}

function draftText(row: ListingRowView | undefined, field: string): string {
  const value = row?.draft.values[field]
  if (value?.kind === "text" && typeof value.value === "string") return value.value.trim()
  if ((value?.kind === "integer" || value?.kind === "decimal") && Number.isFinite(value.value)) return String(value.value)
  return ""
}

function sourceName(row: ListingRowView | undefined): string {
  return typeof row?.source?.fileName === "string" ? row.source.fileName.trim() : ""
}

export function filterRecentSubmissions(items: RecentSubmission[], stores: OzonStoreView[] | undefined, storeId: string, query: string): RecentSubmission[] {
  const term = query.trim().toLocaleLowerCase()
  return items.filter(({ intent, row }) => {
    if (storeId && intent.store_id !== storeId) return false
    const store = stores?.find((item) => item.cloud_store_uuid === intent.store_id || item.id === intent.store_id)
    return !term || [draftText(row, "name"), draftText(row, "offer_id"), sourceName(row), store?.label ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(term))
  })
}

function updatedAt(ms: number): string {
  return ms > 0 && Number.isFinite(ms) ? formatDateTimeYearMinute(ms) : "—"
}

/** The draft price carries the contract currency; a missing code is not invented. */
export function submissionPrice(intent: Pick<ListingIntent, "store_id">, row: ListingRowView | undefined, stores: OzonStoreView[] | undefined): string {
  const price = draftText(row, "price")
  if (!price) return "—"
  const currency = draftText(row, "currency_code")
    || stores?.find((store) => store.cloud_store_uuid === intent.store_id || store.id === intent.store_id)?.company_currency?.trim()
  return currency ? `${price} ${currency}` : price
}

type RecentRead = {
  workspaceId: number
  mode: "recent" | "review"
  scope: ReviewKind | "all"
  phase: "loading" | "ready" | "error"
  items?: RecentSubmission[]
  nextCursor?: string
}

export function RecentSubmissions({ workspaceId, stores, storeId, onOpen, onReview, reviewCounts, reviewFocus, reviewRetry = 0 }: {
  workspaceId?: number
  stores?: OzonStoreView[]
  storeId: string
  onOpen: (cardId: string) => void
  onReview?: (workspaceId: number | undefined, review: ReviewRead) => void
  reviewCounts?: IntentReviewCounts
  reviewFocus?: ReviewFocus
  reviewRetry?: number
}) {
  const active = useScreenActive()
  const [read, setRead] = useState<RecentRead>()
  const [retry, setRetry] = useState(0)
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle")
  const [filter, setFilter] = useState<Filter>("all")
  const [reviewKind, setReviewKind] = useState<ReviewKind | "all">("all")
  const [query, setQuery] = useState("")
  const cardRef = useRef<HTMLElement | null>(null)
  const moreController = useRef<AbortController | null>(null)
  const attention = filter === "attention"
  const mode = attention ? "review" : "recent"
  const scope = attention ? reviewKind : "all"
  const current = read && read.workspaceId === workspaceId && read.mode === mode && read.scope === scope ? read : undefined
  const searched = filterRecentSubmissions(current?.items ?? [], stores, storeId, query)
  const items = searched.filter(({ intent }) => filter === "all" || submissionStatus(intent).group === filter)
  const scopeCount = reviewCounts ? reviewScopeCount(reviewCounts, scope) : undefined
  // The parent renders the same queue above this card; keep its callback out of
  // the fetch dependency list so an inline parent callback cannot refetch.
  const onReviewRef = useRef(onReview)
  useEffect(() => { onReviewRef.current = onReview }, [onReview])

  useEffect(() => () => moreController.current?.abort(), [])

  // An entry carries the records it counted: switch the queue to that group
  // and bring it into view instead of jumping to an unfiltered list.
  useEffect(() => {
    if (!reviewFocus) return
    setFilter("attention")
    setReviewKind(reviewFocus.kind)
    // A local search term must not hide the records the entry just counted.
    setQuery("")
    const node = cardRef.current
    if (!node) return
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
    node.focus({ preventScroll: true })
  }, [reviewFocus])

  useEffect(() => {
    if (!active || !workspaceId) return
    moreController.current?.abort()
    setMore("idle")
    const controller = new AbortController()
    setRead({ workspaceId, mode, scope, phase: "loading" })
    // Counts come from the recent page. A queue read failure must not erase
    // counts the recent page already established.
    if (mode === "recent") onReviewRef.current?.(workspaceId, { phase: "loading" })
    void readRecentSubmissions(controller.signal, {
      needsReview: mode === "review",
      reviewKind: scope === "all" ? undefined : scope,
    }).then(({ items, review, nextCursor }) => {
      if (controller.signal.aborted) return
      setRead({ workspaceId, mode, scope, phase: "ready", items, nextCursor })
      onReviewRef.current?.(workspaceId, { phase: "ready", counts: review })
    }).catch(() => {
      if (controller.signal.aborted) return
      setRead({ workspaceId, mode, scope, phase: "error" })
      if (mode === "recent") onReviewRef.current?.(workspaceId, { phase: "error" })
    })
    return () => controller.abort()
  }, [active, workspaceId, retry, mode, scope, reviewRetry])

  async function loadMore() {
    if (!current || current.phase !== "ready" || !current.nextCursor || more === "loading") return
    const cursor = current.nextCursor
    const expected = { workspaceId: current.workspaceId, mode: current.mode, scope: current.scope }
    moreController.current?.abort()
    const controller = new AbortController()
    moreController.current = controller
    setMore("loading")
    try {
      const next = await readRecentSubmissions(controller.signal, {
        needsReview: true,
        reviewKind: expected.scope === "all" ? undefined : expected.scope,
        cursor,
      })
      setRead((previous) => {
        if (!previous || previous.workspaceId !== expected.workspaceId || previous.mode !== expected.mode
          || previous.scope !== expected.scope || previous.phase !== "ready") return previous
        const seen = new Set((previous.items ?? []).map((entry) => entry.intent.id))
        return {
          ...previous,
          items: [...(previous.items ?? []), ...next.items.filter((entry) => !seen.has(entry.intent.id))],
          nextCursor: next.nextCursor === cursor ? undefined : next.nextCursor,
        }
      })
      setMore("idle")
    } catch {
      if (!controller.signal.aborted) setMore("error")
    }
  }

  // Workspace counts are not store- or search-scoped, so a filtered view says
  // only what it shows.
  const filtered = Boolean(storeId || query.trim())
  const countNote = current?.phase === "ready"
    ? filtered || scopeCount == null ? `已显示 ${items.length} 项`
      : items.length >= scopeCount ? `共 ${scopeCount} 项` : `已显示 ${items.length} 项，共 ${scopeCount} 项`
    : undefined

  return <section ref={cardRef} id="home-submissions" tabIndex={-1} className="min-w-0 scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-labelledby="home-submissions-title" aria-busy={Boolean(workspaceId && (!current || current.phase === "loading"))}>
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-2">
      <h2 id="home-submissions-title" className="flex items-center gap-2 text-base font-semibold"><ClipboardList className="size-4" aria-hidden />上架任务</h2>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <label className="relative min-w-0"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索上架任务" placeholder="搜索商品名称或货号" className="h-9 w-52 max-w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
        <IconButton icon={RefreshCw} label="刷新上架提交" variant="outline" size="icon-sm" disabled={!workspaceId || current?.phase === "loading"} onClick={() => setRetry((value) => value + 1)} />
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1 px-3 pb-3" aria-label="筛选上架提交">
      {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); if (item.id === "attention") setReviewKind("all") }} className={cn("inline-flex min-h-8 items-center rounded-md border px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring", filter === item.id ? "border-brand bg-brand-soft text-brand-ink" : "border-transparent text-muted-foreground hover:bg-muted")}>
        {item.label}
      </button>)}
      <span className="ml-auto px-1 text-xs text-muted-foreground">{attention ? `待核对 · ${countNote ?? "正在读取"}` : "最近 5 条提交"}</span>
    </div>
    {attention ? <div className="flex flex-wrap items-center gap-1 px-3 pb-3" aria-label="筛选待核对类型">
      {REVIEW_KINDS.map((item) => <button key={item.id} type="button" aria-pressed={reviewKind === item.id} onClick={() => setReviewKind(item.id)} className={cn("inline-flex min-h-8 items-center rounded-md border px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring", reviewKind === item.id ? "border-border bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted")}>
        {item.label}
      </button>)}
    </div> : null}
    {!workspaceId ? <p className="px-3 py-5 text-sm text-muted-foreground">请先创建或选择工作空间。</p>
      : !current || current.phase === "loading" ? <p className="px-3 py-5 text-sm text-muted-foreground" role="status">{mode === "review" ? "正在读取待核对队列" : "正在读取上架提交"}</p>
      : current.phase === "error" ? <div className="flex flex-wrap items-center gap-2 px-3 py-5 text-sm" role="status"><span className="text-muted-foreground">{mode === "review" ? "待核对队列读取失败。" : "上架提交读取失败。"}</span><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>重试</Button></div>
      : <Table className="min-w-[38rem] [&_td]:py-2">
        <TableHeader className="bg-muted/60"><TableRow><TableHead>商品信息</TableHead><TableHead>店铺</TableHead><TableHead>当前草稿价</TableHead><TableHead className="hidden lg:table-cell">最近更新</TableHead><TableHead>提交状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
        <TableBody>{items.length ? items.map(({ intent, row }) => {
          const status = submissionStatus(intent)
          const storeName = stores?.find((store) => store.cloud_store_uuid === intent.store_id || store.id === intent.store_id)?.label.trim()
          const media = row?.media as { images?: { phase?: string; public_url?: string }[] } | undefined
          const url = Array.isArray(media?.images) ? media.images.find((image) => image?.phase === "public_ready" && typeof image.public_url === "string")?.public_url?.trim() : undefined
          const image = url && /^https?:\/\//i.test(url) ? url : undefined
          const name = row ? draftText(row, "name") || sourceName(row) || "未命名商品" : "商品信息读取失败"
          return <TableRow key={intent.id}>
            <TableCell><div className="flex min-w-0 items-center gap-2">{image ? <ProductThumb src={image} name={name} className="size-12" /> : <span className="grid size-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Package className="size-4" aria-hidden /></span>}<div className="min-w-0"><p className="max-w-80 truncate font-medium" title={name}>{name}</p>{row && draftText(row, "offer_id") ? <p className="max-w-56 truncate text-xs text-muted-foreground">{draftText(row, "offer_id")}</p> : null}</div></div></TableCell>
            <TableCell className="whitespace-nowrap">{storeName || "店铺信息不可用"}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{submissionPrice(intent, row, stores)}</TableCell>
            <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{updatedAt(intent.updated_at_ms)}</TableCell>
            <TableCell><StateChip status={intent.state} label={status.label} tone={status.tone} /></TableCell>
            <TableCell>{row ? <Button type="button" variant="outline" size="sm" onClick={() => onOpen(row.card_id)}>查看<span className="sr-only">{name}</span></Button> : <span className="text-xs text-muted-foreground">读取失败，请刷新</span>}</TableCell>
          </TableRow>
        }) : <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground"><span role="status">{!query && !storeId && filter === "all" ? "暂无上架提交"
          : filter === "attention" && !query && !storeId ? scopeCount != null && scopeCount > 0 ? "待核对队列为空，请刷新"
            : scope !== "all" ? `没有“${REVIEW_KIND_LABELS[scope]}”的待核对记录`
              : scopeCount === 0 ? "暂无需要核对的上架结果" : "待核对队列暂无记录"
          : filter === "attention" ? "待核对队列中没有符合条件的记录" : "最近 5 条提交中没有符合条件的记录"}</span></TableCell></TableRow>}</TableBody>
      </Table>}
    {attention && current?.phase === "ready" && (current.nextCursor || more === "error") ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
      {more === "error" ? <span className="text-xs text-destructive">更多记录读取失败。</span> : null}
      {current.nextCursor ? <Button type="button" variant="outline" size="sm" disabled={more === "loading"} onClick={() => void loadMore()}>{more === "loading" ? "正在读取…" : more === "error" ? "重试读取更多" : "加载更多"}</Button> : null}
    </div> : null}
  </section>
}
