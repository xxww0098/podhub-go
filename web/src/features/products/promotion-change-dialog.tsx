import { useMemo, useState } from "react"
import { opsHttp } from "@/bindings/http-ops"
import type { ProductMutationRequest, ProductPromotionActionView, ProductPromotionOfferView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { commandErrorCode, errorMessage, SELLER_RESULT_UNKNOWN_CODE, WRITES_DISABLED_CODE } from "@/lib/error-message"
import { formatStoreMoney } from "@/lib/format"
import { buildPromotionJoinMutation, buildPromotionLeaveMutation, promotionFrozen, promotionWritePrice } from "./product-list-model"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { chunkRows, parseDiscountPercent, PROMOTION_MUTATION_LIMIT } from "./products-mutation"

export type PromotionTarget = {
  storeId: string
  storeName: string
  action: ProductPromotionActionView
  offers: ProductPromotionOfferView[]
}

export function PromotionChangeDialog({ target, onClose, onApplied }: {
  target: PromotionTarget | null
  onClose: () => void
  onApplied: () => void
}) {
  const [busy, setBusy] = useState(false)
  return <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>调整促销</DialogTitle>
        <DialogDescription>{target ? `${target.storeName} · ${target.action.title}` : ""}</DialogDescription>
      </DialogHeader>
      {target ? <PromotionChangeForm key={`${target.storeId}:${target.action.action_id}:${target.offers.map((offer) => offer.product_id).join(",")}`} target={target} onClose={onClose} onApplied={onApplied} onBusy={setBusy} /> : null}
    </DialogContent>
  </Dialog>
}

export function PromotionChangeForm({ target, onClose, onApplied, onBusy }: {
  target: PromotionTarget
  onClose: () => void
  onApplied: () => void
  onBusy: (busy: boolean) => void
}) {
  const { storeId, action, offers } = target
  const [mode, setMode] = useState<"join" | "leave">("join")
  const [priceMode, setPriceMode] = useState<"price" | "percent">("price")
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState("")
  const [uncertain, setUncertain] = useState(false)
  const [submittedIds, setSubmittedIds] = useState<readonly string[]>([])
  const operationIdsFor = useOperationIds(`${storeId}:${action.action_id}`)
  const frozen = promotionFrozen(action.freeze_date)
  const percent = parseDiscountPercent(input)
  const prepared = useMemo(() => {
    try {
      // Only the live-verified activity family is admitted to the product UI.
      if (action.action_type !== "ELASTIC_BOOSTING") throw new Error("此类活动暂不支持在此调整，请到 Ozon 卖家后台操作")
      if (frozen) throw new Error("活动已冻结，暂不能在此修改")
      const requests = chunkRows(offers, PROMOTION_MUTATION_LIMIT).map((chunk): ProductMutationRequest => {
        if (mode === "leave") return buildPromotionLeaveMutation(action.action_id, action.action_type, chunk)
        const prices = new Map(chunk.map((offer) => [offer.product_id, promotionWritePrice(offer, priceMode === "percent" ? { kind: "percent", percent: percent ?? -1 } : { kind: "price", price: input })]))
        return buildPromotionJoinMutation(action.action_id, action.action_type, chunk, chunk.map((offer) => ({ product_id: offer.product_id, offer_id: offer.offer_id ?? "" })), (offer) => {
          const price = prices.get(offer.product_id)
          if (!price) throw new Error(priceMode === "percent" && offer.currency_code !== offer.price_currency_code ? "售价与活动币种不同，请直接输入活动价" : "请输入大于 0、最多两位小数的价格，或 0–100% 之间的折扣率")
          return price
        })
      })
      const prices = new Map<number, string>()
      for (const request of requests) {
        if (request.kind === "promotion_join") request.items.forEach((item) => prices.set(item.product_id, item.action_price))
        if (request.kind === "promotion_leave") request.exit_prices?.forEach((item) => prices.set(item.product_id, item.exit_price))
      }
      return { requests, prices, error: "" }
    } catch (reason) {
      return { requests: [], prices: new Map<number, string>(), error: errorMessage(reason, "请检查活动参数") }
    }
  }, [action, offers, mode, priceMode, input, percent, frozen])

  async function submit() {
    if (busy || uncertain || prepared.error || prepared.requests.length === 0) return
    setBusy(true)
    onBusy(true)
    setFailure("")
    const ids = operationIdsFor(prepared.requests)
    setSubmittedIds(ids)
    const result = await dispatchChunks(storeId, prepared.requests, ids)
    if (result.items.length > 0) {
      reportOutcome(result.items, (count) => `已核实 ${count} 件商品${mode === "leave" ? "退出活动" : "的活动价格"}`)
    }
    if (result.failure !== undefined) {
      const code = commandErrorCode(result.failure)
      setUncertain(code !== WRITES_DISABLED_CODE && (code === SELLER_RESULT_UNKNOWN_CODE || ![400, 401, 403, 404, 422].includes((result.failure as { status?: number })?.status ?? 0)))
      setFailure(errorMessage(result.failure, "结果未确认，请先重新读取活动，勿重复提交"))
    } else {
      if (result.items.length > 0) onApplied()
      onClose()
    }
    setBusy(false)
    onBusy(false)
  }

  async function verify() {
    setBusy(true)
    onBusy(true)
    try {
      const result = await opsHttp.consoleReconcileActiveWorkspace()
      const entries = result.entries.filter((entry) => submittedIds.some((id) => entry.offer_id === `ozon.product-mutation:${storeId}:${id}`))
      if (entries.length === 0 || entries.some((entry) => entry.outcome !== "reconciled")) {
        setFailure(entries.map((entry) => entry.reason).filter(Boolean).join("；") || "结果仍未确认，请稍后再次核实或核对任务记录")
        return
      }
      onApplied()
      onClose()
    } catch (reason) {
      setFailure(errorMessage(reason, "核实失败，请稍后重试"))
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }

  if (action.action_type !== "ELASTIC_BOOSTING") return <div className="grid gap-3 text-sm"><p>请在 Ozon 卖家后台调整此类活动。</p><Button className="justify-self-end" variant="outline" onClick={onClose}>关闭</Button></div>

  return <div className="grid min-h-0 gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={mode === "join" ? "secondary" : "outline"} aria-pressed={mode === "join"} disabled={busy || uncertain} onClick={() => setMode("join")}>加入 / 改价</Button>
      <Button size="sm" variant={mode === "leave" ? "secondary" : "outline"} aria-pressed={mode === "leave"} disabled={busy || uncertain || frozen || offers.every((offer) => !offer.participating)} onClick={() => setMode("leave")}>退出活动</Button>
      {mode === "join" ? <>
        <Button size="sm" variant="ghost" aria-pressed={priceMode === "percent"} disabled={busy || uncertain} onClick={() => { setPriceMode((value) => value === "price" ? "percent" : "price"); setInput("") }}>{priceMode === "price" ? "改用折扣率" : "改用活动价"}</Button>
        <label className="flex items-center gap-2 text-sm">
          <span>{priceMode === "price" ? "活动价" : "折扣率 %"}</span>
          <Input className="w-32" inputMode="decimal" aria-label={priceMode === "price" ? "目标活动价" : "相对售价折扣率"} value={input} disabled={busy || uncertain} onChange={(event) => setInput(event.target.value)} placeholder={priceMode === "price" ? "0.00" : "例如 15"} />
        </label>
      </> : null}
    </div>
    <p className="text-sm">{mode === "leave" ? "退出将把商品售价提高至活动上限以上。" : "加入或改价会同步修改商品售价。"}请核对下列金额后确认。{frozen ? " 活动已冻结。" : ""}</p>
    <Table containerClassName="max-h-64 overflow-auto" aria-label="促销价格变更预览">
      <TableHeader><TableRow><TableHead>商品 / 货号</TableHead><TableHead className="text-right">确认后售价</TableHead><TableHead className="text-right">当前售价</TableHead><TableHead className="text-right">当前活动价</TableHead><TableHead className="text-right">活动上限</TableHead></TableRow></TableHeader>
      <TableBody>{offers.map((offer) => <TableRow key={offer.product_id}>
        <TableCell className="max-w-64"><div className="truncate" title={offer.name}>{offer.name || offer.offer_id || offer.product_id}</div><span className="text-xs text-muted-foreground">{offer.offer_id || offer.product_id}</span></TableCell>
        <TableCell className="text-right font-medium tabular-nums whitespace-nowrap">{prepared.prices.has(offer.product_id) ? formatStoreMoney(prepared.prices.get(offer.product_id), offer.currency_code, 2) : "—"}</TableCell>
        <TableCell className="text-right tabular-nums whitespace-nowrap">{formatStoreMoney(offer.price, offer.price_currency_code, 2)}</TableCell>
        <TableCell className="text-right tabular-nums whitespace-nowrap">{offer.participating ? formatStoreMoney(offer.action_price, offer.currency_code, 2) : "未参加"}</TableCell>
        <TableCell className="text-right tabular-nums whitespace-nowrap">{formatStoreMoney(offer.max_action_price, offer.currency_code, 2)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
    {prepared.error && (input !== "" || mode === "leave" || frozen || action.action_type !== "ELASTIC_BOOSTING") ? <p role="alert" className="text-sm text-destructive">{prepared.error}</p> : null}
    {failure ? <p role="alert" className="text-sm text-destructive">{failure}{uncertain ? " 请先核实结果，勿重复提交。" : ""}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
      {uncertain ? <Button variant="outline" disabled={busy} onClick={() => void verify()}>{busy ? "正在核实…" : "核实并重新读取"}</Button> : <Button disabled={busy || !!prepared.error || prepared.requests.length === 0} onClick={() => void submit()}>{busy ? "正在提交并核实…" : mode === "leave" ? "确认退出并改价" : "确认加入 / 改价"}</Button>}
    </div>
  </div>
}
