import { ArrowLeft, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { opsHttp } from "@/bindings/http-ops"
import type { ProductPromotionActionView, ProductPromotionOfferView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { errorMessage } from "@/lib/error-message"
import { formatDate, formatStoreMoney } from "@/lib/format"
import { promotionFrozen } from "./product-list-model"
import type { StoreProductOverviewRow } from "./products-api"
import { PromotionChangeDialog, type PromotionTarget } from "./promotion-change-dialog"

export function ProductsPromotions({ stores, initialStoreId, onBack, onApplied }: {
  stores: StoreProductOverviewRow[]
  initialStoreId: string | null
  onBack: () => void
  onApplied: () => void
}) {
  const [storeId, setStoreId] = useState(stores.find((store) => store.store_id === initialStoreId)?.store_id ?? stores[0]?.store_id ?? "")
  const [actions, setActions] = useState<ProductPromotionActionView[]>([])
  const [actionId, setActionId] = useState("")
  const [participating, setParticipating] = useState(true)
  const [offers, setOffers] = useState<ProductPromotionOfferView[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [catalogError, setCatalogError] = useState("")
  const [pageError, setPageError] = useState("")
  const [reload, setReload] = useState(0)
  const [target, setTarget] = useState<PromotionTarget | null>(null)
  const pageSeq = useRef(0)
  const store = stores.find((item) => item.store_id === storeId)
  const action = actions.find((item) => String(item.action_id) === actionId)

  useEffect(() => {
    if (!storeId) return
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError("")
    setActions([])
    setActionId("")
    setTarget(null)
    void opsHttp.productsListPromotions({ store_id: storeId, product_ids: [] }).then((view) => {
      if (cancelled) return
      setActions(view.actions)
      setActionId(String(view.actions[0]?.action_id ?? ""))
    }).catch((reason) => { if (!cancelled) setCatalogError(errorMessage(reason, "活动目录读取失败")) })
      .finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => { cancelled = true }
  }, [storeId, reload])

  async function loadPage(next?: string) {
    if (!storeId || !actionId) return
    const seq = ++pageSeq.current
    setLoading(true)
    setPageError("")
    if (!next) { setOffers([]); setTotal(null); setCursor(null); setSelected(new Set()) }
    try {
      const view = await opsHttp.productsListPromotions({ store_id: storeId, product_ids: [], action_id: Number(actionId), participating, ...(next ? { cursor: next } : {}) })
      if (seq !== pageSeq.current) return
      const rows = next ? [...offers, ...view.offers] : view.offers
      if (view.total === undefined || (next && view.total !== total) || rows.length > view.total || new Set(rows.map((offer) => offer.product_id)).size !== rows.length || (rows.length < view.total && (!view.next_cursor || view.next_cursor === next))) throw new Error("活动商品发生变化或分页不完整，请重新读取活动")
      setOffers(rows)
      setTotal(view.total)
      setCursor(rows.length < view.total ? view.next_cursor! : null)
    } catch (reason) {
      if (seq === pageSeq.current) setPageError(errorMessage(reason, "活动商品读取失败，请重试"))
    } finally {
      if (seq === pageSeq.current) setLoading(false)
    }
  }
  useEffect(() => {
    setOffers([]); setTotal(null); setCursor(null); setSelected(new Set()); setTarget(null)
    if (actionId) void loadPage()
    return () => { pageSeq.current += 1 }
    // loadPage belongs to this exact activity/tab; page appends use the current rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, actionId, participating])

  function openChange(rows: ProductPromotionOfferView[]) {
    if (action && store) setTarget({ storeId, storeName: store.name, action, offers: rows })
  }
  const selectedOffers = offers.filter((offer) => selected.has(offer.product_id))
  const allSelected = offers.length > 0 && selectedOffers.length === offers.length
  const manageable = action?.action_type === "ELASTIC_BOOSTING"
  return <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft aria-hidden />商品列表</Button>
      <Select value={storeId} onValueChange={(value) => value && setStoreId(value)}>
        <SelectTrigger size="sm" aria-label="促销店铺" className="min-w-40"><SelectValue>{() => store?.name ?? "选择店铺"}</SelectValue></SelectTrigger>
        <SelectContent>{stores.map((item) => <SelectItem key={item.store_id} value={item.store_id}>{item.name}</SelectItem>)}</SelectContent>
      </Select>
      <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:flex-1">
      <Select value={actionId} disabled={catalogLoading || actions.length === 0} onValueChange={(value) => value && setActionId(value)}>
        <SelectTrigger size="sm" aria-label="促销活动" className="min-w-0 flex-1 sm:min-w-72"><SelectValue>{() => catalogLoading ? "正在读取活动…" : action?.title ?? "暂无可参加活动"}</SelectValue></SelectTrigger>
        <SelectContent>{actions.map((item) => <SelectItem key={item.action_id} value={String(item.action_id)}>{item.title}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" variant="outline" aria-label="重新读取促销活动" disabled={catalogLoading || loading} onClick={() => setReload((value) => value + 1)}><RefreshCw aria-hidden /><span className="hidden sm:inline">重新读取</span></Button>
      </div>
    </div>
    {catalogError ? <p role="alert" className="text-sm text-destructive">{catalogError}</p> : null}
    {action ? <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border">
      <Tabs value={participating ? "participating" : "candidates"} onValueChange={(value) => setParticipating(value === "participating")}>
        <TabsList aria-label="活动商品状态"><TabsIndicator /><TabsTrigger value="participating">已参加 {action.participating_products_total}</TabsTrigger><TabsTrigger value="candidates">可参加 {action.potential_products_total}</TabsTrigger></TabsList>
      </Tabs>
      <p className="pb-1 text-xs text-muted-foreground">{action.date_start ? formatDate(action.date_start) : "—"}–{action.date_end ? formatDate(action.date_end) : "—"}{promotionFrozen(action.freeze_date) ? " · 已冻结" : ""}</p>
    </div> : null}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {selectedOffers.length > 0 ? <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"><span className="text-sm">已选 {selectedOffers.length} 件</span>{manageable ? <Button size="sm" onClick={() => openChange(selectedOffers)}>批量调整促销</Button> : null}<Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清除选择</Button></div> : null}
      {pageError ? <div role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-destructive">{pageError}<Button size="xs" variant="outline" disabled={loading} onClick={() => void loadPage(cursor ?? undefined)}>重试</Button></div> : null}
      <Table containerClassName="min-h-0 flex-1 overflow-auto" aria-label="促销活动商品">
        <TableHeader><TableRow><TableHead className="w-10"><Checkbox aria-label="选择已加载的全部活动商品" checked={allSelected} indeterminate={!allSelected && selectedOffers.length > 0} disabled={offers.length === 0 || loading} onCheckedChange={(checked) => setSelected(checked ? new Set(offers.map((offer) => offer.product_id)) : new Set())} /></TableHead><TableHead>商品 / 货号 / SKU</TableHead><TableHead className="text-right">售价</TableHead><TableHead className="text-right">活动价</TableHead><TableHead className="text-right">活动上限</TableHead><TableHead className="text-right">承诺库存 / 最低</TableHead><TableHead>加入方式</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
        <TableBody>{offers.map((offer) => <TableRow key={offer.product_id} data-state={selected.has(offer.product_id) ? "selected" : undefined}>
          <TableCell><Checkbox aria-label={`选择 ${offer.offer_id || offer.product_id}`} checked={selected.has(offer.product_id)} onCheckedChange={(checked) => setSelected((old) => { const next = new Set(old); if (checked) next.add(offer.product_id); else next.delete(offer.product_id); return next })} /></TableCell>
          <TableCell className="min-w-60 max-w-96"><div className="line-clamp-2" title={offer.name}>{offer.name || "商品名称未知"}</div><div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>{offer.offer_id || offer.product_id}</span><span>SKU {offer.sku || "未知"}</span>{offer.price_quarantined === true ? <span className="text-destructive">价格隔离</span> : null}</div></TableCell>
          <TableCell className="text-right tabular-nums whitespace-nowrap">{formatStoreMoney(offer.price, offer.price_currency_code, 2)}</TableCell>
          <TableCell className="text-right tabular-nums whitespace-nowrap">{offer.participating ? formatStoreMoney(offer.action_price, offer.currency_code, 2) : "未参加"}</TableCell>
          <TableCell className="text-right tabular-nums whitespace-nowrap">{formatStoreMoney(offer.max_action_price, offer.currency_code, 2)}</TableCell>
          <TableCell className="text-right tabular-nums whitespace-nowrap">{offer.stock ?? "未知"} / {offer.min_stock ?? "未知"}</TableCell>
          <TableCell className="whitespace-nowrap">{offer.add_mode === "AUTO" ? "自动" : offer.add_mode === "SELLER" ? "手动" : "—"}</TableCell>
          <TableCell className="whitespace-nowrap">{manageable ? <Button size="xs" variant="outline" onClick={() => openChange([offer])}>调整促销</Button> : <span className="text-xs text-muted-foreground">请到卖家后台调整</span>}</TableCell>
        </TableRow>)}{offers.length === 0 ? <TableRow><TableCell colSpan={8} className="h-32 text-center text-muted-foreground">{loading || catalogLoading ? <span role="status">正在读取 Ozon 活动商品…</span> : catalogError || pageError ? "读取失败，请重试" : action ? participating ? "此活动暂无已参加商品" : "此活动暂无可参加商品" : "当前店铺暂无活动"}</TableCell></TableRow> : null}</TableBody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground" aria-live="polite"><span>{total === null ? "" : `已加载 ${offers.length} / ${total} 件`}</span>{cursor ? <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadPage(cursor)}>{loading ? "读取中…" : "加载更多"}</Button> : null}</div>
    </div>
    <PromotionChangeDialog target={target} onClose={() => setTarget(null)} onApplied={() => { onApplied(); setReload((value) => value + 1) }} />
  </div>
}
