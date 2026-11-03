import { useEffect, useState } from "react"
import { ClipboardList, Package, RefreshCw, Search } from "lucide-react"
import type { OzonStoreView } from "@/bindings/commands"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import type { ListingRowView } from "@/bindings/listing-projection"
import { useScreenActive } from "@/components/screen-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ProductThumb } from "@/features/products/product-thumb"
import { cn } from "@/lib/utils"
import { readRecentSubmissions, type RecentSubmission } from "./recent-submissions-read"

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "attention", label: "需要核对" },
  { id: "accepted", label: "平台受理" },
] as const
type Filter = typeof FILTERS[number]["id"]

export function submissionStatus(intent: Pick<ListingIntent, "state" | "current_issue_status">): { label: string; group: Exclude<Filter, "all"> | "other" } {
  switch (intent.state) {
    case "queued": return { label: "已排队", group: "active" }
    case "submitting": return { label: "发送中", group: "active" }
    case "accepted": return intent.current_issue_status === "absent"
      ? { label: "平台受理", group: "accepted" }
      : { label: "受理后需核对", group: "attention" }
    case "unknown":
    case "outcome_unknown": return { label: "结果未知", group: "attention" }
    case "rejected": return { label: "发送未完成", group: "attention" }
    case "conflict": return { label: "结果冲突", group: "attention" }
    case "superseded": return { label: "已替代", group: "other" }
    case "cancelled": return { label: "已取消", group: "other" }
    case "reconciled": return { label: "已核对", group: "other" }
    case "operator_attested": return { label: "人工封存", group: "other" }
    default: return { label: "未知状态", group: "attention" }
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
  const date = new Date(ms)
  return ms > 0 && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : "—"
}

type RecentRead = { workspaceId: number; phase: "loading" | "ready" | "error"; items?: RecentSubmission[] }

export function RecentSubmissions({ workspaceId, stores, storeId, onOpen }: {
  workspaceId?: number
  stores?: OzonStoreView[]
  storeId: string
  onOpen: (cardId: string) => void
}) {
  const active = useScreenActive()
  const [read, setRead] = useState<RecentRead>()
  const [retry, setRetry] = useState(0)
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const current = read?.workspaceId === workspaceId ? read : undefined
  const searched = filterRecentSubmissions(current?.items ?? [], stores, storeId, query)
  const items = searched.filter(({ intent }) => filter === "all" || submissionStatus(intent).group === filter)

  useEffect(() => {
    if (!active || !workspaceId) return
    const controller = new AbortController()
    setRead({ workspaceId, phase: "loading" })
    void readRecentSubmissions(controller.signal).then((items) => {
      if (!controller.signal.aborted) setRead({ workspaceId, phase: "ready", items })
    }).catch(() => {
      if (!controller.signal.aborted) setRead({ workspaceId, phase: "error" })
    })
    return () => controller.abort()
  }, [active, workspaceId, retry])

  return <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="home-submissions" aria-busy={Boolean(workspaceId && (!current || current.phase === "loading"))}>
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-2">
      <h2 id="home-submissions" className="flex items-center gap-2 text-base font-semibold"><ClipboardList className="size-4" aria-hidden />上架任务</h2>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <label className="relative min-w-0"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索最近上架任务" placeholder="搜索商品名称或货号" className="h-9 w-52 max-w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
        <IconButton icon={RefreshCw} label="刷新最近上架提交" variant="outline" size="icon-sm" disabled={!workspaceId || current?.phase === "loading"} onClick={() => setRetry((value) => value + 1)} />
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1 px-3 pb-3" aria-label="筛选最近 5 条提交">
      {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring", filter === item.id ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground hover:bg-muted")}>
        {item.label}<span className={cn("rounded-full px-1.5 py-0.5 tabular-nums", filter === item.id ? "bg-primary/15" : "bg-muted")}>{current?.phase === "ready" ? searched.filter(({ intent }) => item.id === "all" || submissionStatus(intent).group === item.id).length : "—"}</span>
      </button>)}
      <span className="ml-auto px-1 text-xs text-muted-foreground">最近 5 条提交</span>
    </div>
    {!workspaceId ? <p className="px-3 py-5 text-sm text-muted-foreground">请先创建或选择工作空间。</p>
      : !current || current.phase === "loading" ? <p className="px-3 py-5 text-sm text-muted-foreground" role="status">正在读取上架提交</p>
      : current.phase === "error" ? <div className="flex flex-wrap items-center gap-2 px-3 py-5 text-sm" role="status"><span className="text-muted-foreground">上架提交读取失败。</span><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>重试</Button></div>
      : <Table className="min-w-[38rem] [&_td]:py-2">
        <TableHeader className="bg-muted/60"><TableRow><TableHead>商品信息</TableHead><TableHead>店铺</TableHead><TableHead>当前草稿价</TableHead><TableHead>最近更新</TableHead><TableHead>提交状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
        <TableBody>{items.length ? items.map(({ intent, row }) => {
          const status = submissionStatus(intent)
          const storeName = stores?.find((store) => store.cloud_store_uuid === intent.store_id || store.id === intent.store_id)?.label.trim()
          const media = row?.media as { images?: { phase?: string; public_url?: string }[] } | undefined
          const url = Array.isArray(media?.images) ? media.images.find((image) => image?.phase === "public_ready" && typeof image.public_url === "string")?.public_url?.trim() : undefined
          const image = url && /^https?:\/\//i.test(url) ? url : undefined
          const name = row ? draftText(row, "name") || sourceName(row) || "未命名商品" : "商品详情读取失败"
          return <TableRow key={intent.id}>
            <TableCell><div className="flex min-w-0 items-center gap-2">{image ? <ProductThumb src={image} name={name} className="size-12" /> : <span className="grid size-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Package className="size-4" aria-hidden /></span>}<div className="min-w-0"><p className="max-w-48 truncate font-medium" title={name}>{name}</p>{row && draftText(row, "offer_id") ? <p className="max-w-48 truncate text-xs text-muted-foreground">{draftText(row, "offer_id")}</p> : null}</div></div></TableCell>
            <TableCell>{storeName || "店铺信息不可用"}</TableCell>
            <TableCell>{row ? draftText(row, "price") || "—" : "—"}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{updatedAt(intent.updated_at_ms)}</TableCell>
            <TableCell><Badge variant={status.group === "attention" ? "destructive" : status.group === "active" ? "brand" : "secondary"}>{status.label}</Badge></TableCell>
            <TableCell><Button type="button" variant="outline" size="sm" disabled={!row} onClick={() => row && onOpen(row.card_id)}>查看<span className="sr-only">{name}</span></Button></TableCell>
          </TableRow>
        }) : <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground"><span role="status">{!query && !storeId && filter === "all" ? "暂无上架提交" : "最近 5 条提交中没有符合条件的记录"}</span></TableCell></TableRow>}</TableBody>
      </Table>}
  </section>
}
