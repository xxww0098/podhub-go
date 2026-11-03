import { useEffect, useState } from "react"
import { ArrowRight, Eye, FileText, RefreshCw, Search } from "lucide-react"
import type { ListingCardSummary, OzonStoreView } from "@/bindings/commands"
import { useScreenActive } from "@/components/screen-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CardStoreChips } from "@/features/workflow/card-store-chips"
import { loadListingCardList } from "@/features/workflow/listing-card-list-cache"
import { recentHomePlans } from "./home-model"

function updatedAt(ms: number) {
  const date = new Date(ms)
  return ms > 0 && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
    : "—"
}

export function RecentPlans({ workspaceId, stores, onOpen, onOpenLibrary }: {
  workspaceId?: number
  stores?: OzonStoreView[]
  onOpen: (cardId: string) => void
  onOpenLibrary: () => void
}) {
  const active = useScreenActive()
  const [result, setResult] = useState<{ workspaceId: number; cards: ListingCardSummary[]; phase: "loading" | "ready" | "error" }>()
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState("")
  const [storeId, setStoreId] = useState("")
  const current = result?.workspaceId === workspaceId ? result : undefined
  const selectedStore = stores?.some((store) => store.id === storeId) ? storeId : ""
  const cards = recentHomePlans(current?.cards ?? [], query, selectedStore)

  useEffect(() => {
    if (!active || !workspaceId) return
    let cancelled = false
    setResult({ workspaceId, cards: [], phase: "loading" })
    void loadListingCardList({ force: retry > 0 }).then((items) => {
      if (!cancelled) setResult({ workspaceId, cards: items, phase: "ready" })
    }).catch(() => {
      if (!cancelled) setResult({ workspaceId, cards: [], phase: "error" })
    })
    return () => { cancelled = true }
  }, [active, workspaceId, retry])

  return <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="home-plans" aria-busy={Boolean(workspaceId && (!current || current.phase === "loading"))}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
      <h2 id="home-plans" className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4" aria-hidden />最近方案</h2>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <label className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索最近方案" placeholder="搜索方案名称" className="h-9 w-44 max-w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" />
        </label>
        {stores?.length ? <Select value={selectedStore || "all"} onValueChange={(value) => setStoreId(value === "all" ? "" : value ?? "")}>
          <SelectTrigger aria-label="筛选方案店铺" className="max-w-44"><SelectValue>{() => stores.find((store) => store.id === selectedStore)?.label ?? "全部店铺"}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部店铺</SelectItem>{stores.map((store) => <SelectItem key={store.id} value={store.id}>{store.label}</SelectItem>)}</SelectContent>
        </Select> : null}
        <Button type="button" variant="outline" size="sm" onClick={onOpenLibrary}>全部方案<ArrowRight className="size-3.5" aria-hidden /></Button>
      </div>
    </div>
    {!workspaceId ? <p className="px-3 py-5 text-sm text-muted-foreground">请先创建或选择工作空间。</p>
      : !current || current.phase === "loading" ? <div className="space-y-2 p-4" aria-label="正在读取上架方案"><Skeleton className="h-10" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      : current.phase === "error" ? <div className="flex flex-wrap items-center gap-2 px-3 py-5 text-sm" role="status"><span className="text-muted-foreground">方案读取失败。</span><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}><RefreshCw className="size-3.5" aria-hidden />重试</Button></div>
      : cards.length ? <Table className="min-w-[40rem] [&_td]:py-2">
        <TableHeader><TableRow><TableHead>方案</TableHead><TableHead>店铺</TableHead><TableHead>默认价格</TableHead><TableHead>更新时间</TableHead><TableHead>状态</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
        <TableBody>{cards.map((card) => <TableRow key={card.draft_id}>
          <TableCell><div className="flex min-w-0 items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-4" aria-hidden /></span><span className="max-w-56 truncate font-medium">{card.display_name.trim() || "未命名方案"}</span></div></TableCell>
          <TableCell>{stores ? <CardStoreChips storeIdString={card.target_store_id} stores={stores} /> : <span className="text-muted-foreground">—</span>}</TableCell>
          <TableCell className="tabular-nums">{card.price?.trim() || "—"}</TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{updatedAt(card.updated_at_ms)}</TableCell>
          <TableCell><Badge variant={card.supplier_unavailable ? "destructive" : "secondary"}>{card.supplier_unavailable ? "货源不可用" : "方案"}</Badge></TableCell>
          <TableCell><IconButton icon={Eye} label={`查看方案 ${card.display_name.trim() || "未命名方案"}`} tip="查看方案" variant="outline" size="icon-sm" disabled={card.supplier_unavailable} disabledReason="货源暂不可用，请在方案列表中处理" title={card.supplier_unavailable ? "货源暂不可用，请在方案列表中处理。" : undefined} onClick={() => onOpen(card.draft_id)} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      : <div className="flex flex-wrap items-center gap-2 px-3 py-5 text-sm text-muted-foreground">{query.trim() || selectedStore ? "没有匹配的方案" : "还没有方案"}{!query.trim() && !selectedStore ? <Button type="button" variant="outline" size="sm" onClick={onOpenLibrary}>创建方案<ArrowRight className="size-3.5" aria-hidden /></Button> : null}</div>}
  </section>
}
