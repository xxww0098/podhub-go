/**
 * 店铺商品详情：这一件商品能参加的 Ozon 平台活动，以及按折扣率或活动价加入、改价、退出。
 * 批量入口仍是列表上的「促销活动」；这里只写当前这一件。
 */
import { useEffect, useState } from "react"

import { opsHttp } from "@/bindings/http-ops"
import type {
  ProductPromotionActionView,
  ProductPromotionOfferView,
} from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { formatStoreMoney } from "@/lib/format"
import { errorMessage } from "@/lib/error-message"

import { elasticPriceRange, promotionDiscountPercent, promotionFrozen, shortDate } from "./product-list-model"
import type { StoreProductRow } from "./products-api"
import { actionBlockReason } from "./products-mutation"
import { ProductPromotionDialog } from "./products-promotion-dialog"

export function ProductDetailSheet({
  row,
  currency,
  onClose,
  onApplied,
}: {
  row: StoreProductRow | null
  currency: string | null
  onClose: () => void
  onApplied: (row: StoreProductRow) => void
}) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent size="detail" aria-label={row ? `${row.name ?? "未命名商品"} 详情` : "商品详情"}>
        <SheetHeader>
          <SheetTitle>{row?.name ?? "未命名商品"}</SheetTitle>
          <SheetDescription>
            {row
              ? `${row.offer_id}${row.sku ? ` · SKU ${row.sku}` : ""} · ${row.store_name} · 售价 ${formatStoreMoney(row.price, currency, 2)}`
              : ""}
          </SheetDescription>
        </SheetHeader>
        {row ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
            <h2 className="text-sm font-medium">Ozon 促销活动</h2>
            <ProductPromotionBoard row={row} currency={currency} onApplied={onApplied} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/** 这一件商品的活动列表。详情抽屉和表格展开行共用，避免两套写入。 */
export function ProductPromotionBoard({
  row,
  currency,
  onApplied,
}: {
  row: StoreProductRow
  currency: string | null
  onApplied: (row: StoreProductRow) => void
}) {
  const [actions, setActions] = useState<ProductPromotionActionView[]>([])
  const [offers, setOffers] = useState<ProductPromotionOfferView[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState("")
  const blocked = actionBlockReason("promotion", row)
  const [loading, setLoading] = useState(blocked === null)

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    setLoading(true)
    setError("")
    setActions([])
    setOffers([])
    void opsHttp
      .productsListPromotions({ store_id: row.store_id, product_ids: [row.product_id] })
      .then((view) => {
        if (cancelled) return
        setActions(view.actions)
        setOffers(view.offers)
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason, "无法读取这件商品的 Ozon 促销活动，请重试"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [row, blocked, reloadKey])

  if (blocked) return <p className="text-sm text-muted-foreground">{blocked}</p>
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" aria-label="正在读取促销活动" />
        正在读取可参加的活动…
      </div>
    )
  }
  if (error) return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">{error}<Button size="xs" variant="outline" onClick={() => setReloadKey((value) => value + 1)}>重试活动</Button></div>
  if (actions.length === 0) {
    return <p className="text-sm text-muted-foreground">这件商品当前没有可参加的 Ozon 活动。</p>
  }
  return (
    <div className="grid gap-2">
      {actions.map((action) => {
        const offer = offers.find((item) => item.action_id === action.action_id)
        if (!offer) return null
        return (
          <PromotionOfferEditor
            key={action.action_id}
            row={row}
            currency={currency}
            action={action}
            offer={offer}
            onDone={() => {
              setReloadKey((key) => key + 1)
              onApplied(row)
            }}
          />
        )
      })}
    </div>
  )
}

function PromotionOfferEditor({ row, action, offer, onDone }: {
  row: StoreProductRow
  currency: string | null
  action: ProductPromotionActionView
  offer: ProductPromotionOfferView
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const elastic = elasticPriceRange(offer)
  const discount = offer.price_currency_code === offer.currency_code ? promotionDiscountPercent(offer.price, offer.action_price) : null
  return <section className="grid gap-2 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="min-w-0 font-medium">{action.title}</h3>
      <span className="text-xs text-muted-foreground">{shortDate(action.date_start)}–{shortDate(action.date_end)}</span>
    </div>
    <p className="text-sm">
      {offer.participating ? `已参加 · ${formatStoreMoney(offer.action_price, offer.currency_code, 2)}${discount === null ? "" : ` · 折扣 ${discount}%`}` : "未参加"}
      {` · 上限 ${formatStoreMoney(offer.max_action_price, offer.currency_code, 2)}`}
      {elastic ? ` · 弹性 ${formatStoreMoney(elastic.low, offer.currency_code, 2)}–${formatStoreMoney(elastic.high, offer.currency_code, 2)}` : ""}
      {promotionFrozen(action.freeze_date) ? " · 已冻结" : ""}
    </p>
    {action.action_type === "ELASTIC_BOOSTING" ? <Button className="w-fit" size="sm" variant="outline" onClick={() => setOpen(true)}>调整促销</Button> : null}
    <ProductPromotionDialog open={open} rows={[row]} storeName={row.store_name} initialActionId={action.action_id} onClose={() => setOpen(false)} onApplied={onDone} />
  </section>
}
