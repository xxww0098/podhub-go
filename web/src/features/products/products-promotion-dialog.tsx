import { useEffect, useMemo, useState } from "react"
import { opsHttp } from "@/bindings/http-ops"
import type { ProductPromotionsView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/error-message"
import type { StoreProductRow } from "./products-api"
import { PromotionChangeForm } from "./promotion-change-dialog"

export function ProductPromotionDialog({ open, rows, storeName, initialActionId, onClose, onApplied }: {
  open: boolean
  rows: StoreProductRow[]
  storeName: string
  initialActionId?: number
  onClose: () => void
  onApplied: () => void
}) {
  const [view, setView] = useState<ProductPromotionsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [actionId, setActionId] = useState("")
  const [busy, setBusy] = useState(false)
  const storeId = rows[0]?.store_id ?? ""
  const idsKey = JSON.stringify(rows.map((row) => row.product_id))
  useEffect(() => {
    if (!open || !storeId) return
    let cancelled = false
    setLoading(true)
    setView(null)
    setError("")
    void opsHttp.productsListPromotions({ store_id: storeId, product_ids: JSON.parse(idsKey) }).then((next) => {
      if (cancelled) return
      setView(next)
      setActionId(String(next.actions.find((action) => action.action_id === initialActionId)?.action_id ?? next.actions[0]?.action_id ?? ""))
    }).catch((reason) => {
      if (!cancelled) setError(errorMessage(reason, "无法读取 Ozon 促销活动，请重试"))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, storeId, idsKey, reload, initialActionId])
  const target = useMemo(() => {
    const action = view?.actions.find((item) => String(item.action_id) === actionId)
    return action ? { storeId, storeName, action, offers: view!.offers.filter((offer) => offer.action_id === action.action_id) } : null
  }, [view, actionId, storeId, storeName])
  return <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
    <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>促销活动</DialogTitle><DialogDescription>{storeName} · 已选 {rows.length} 件商品</DialogDescription></DialogHeader>
      {loading ? <p role="status" className="text-sm text-muted-foreground">正在读取活动与商品资格…</p> : error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">{error}<Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>重试</Button></div> : view?.actions.length === 0 ? <p className="text-sm text-muted-foreground">已选商品当前没有可参加的活动。</p> : <>
        <Select value={actionId} disabled={busy} onValueChange={(value) => value && setActionId(value)}>
          <SelectTrigger aria-label="选择活动" className="w-full"><SelectValue>{() => target?.action.title ?? "选择活动"}</SelectValue></SelectTrigger>
          <SelectContent>{view?.actions.map((action) => <SelectItem key={action.action_id} value={String(action.action_id)}>{action.title}</SelectItem>)}</SelectContent>
        </Select>
        {target ? <PromotionChangeForm key={`${open}:${actionId}`} target={target} onClose={onClose} onApplied={onApplied} onBusy={setBusy} /> : null}
      </>}
    </DialogContent>
  </Dialog>
}
