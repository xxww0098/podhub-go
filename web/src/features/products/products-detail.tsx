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
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { formatStoreMoney } from "@/lib/format"
import { notifyCommandError } from "@/lib/notify"

import {
  PROMOTION_EXITABLE_TYPES,
  buildPromotionJoinMutation,
  buildPromotionLeaveMutation,
  elasticPriceRange,
  promotionDiscountPercent,
  promotionFrozen,
  promotionWritePrice,
  shortDate,
} from "./product-list-model"
import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { actionBlockReason, parseDiscountPercent, parseMoneyInput } from "./products-mutation"

type PriceMode = "percent" | "price"

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
  const blocked = actionBlockReason("promotion", row)
  const [loading, setLoading] = useState(blocked === null)

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    setLoading(true)
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
        if (!cancelled) notifyCommandError(reason, "无法读取这件商品的 Ozon 促销活动，请稍后重试。")
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

function PromotionOfferEditor({
  row,
  currency,
  action,
  offer,
  onDone,
}: {
  row: StoreProductRow
  currency: string | null
  action: ProductPromotionActionView
  offer: ProductPromotionOfferView
  onDone: () => void
}) {
  const [mode, setMode] = useState<PriceMode>("percent")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const operationIdsFor = useOperationIds(`${row.product_id}:${action.action_id}`)
  const frozen = promotionFrozen(action.freeze_date)
  const exitable = PROMOTION_EXITABLE_TYPES.includes(action.action_type)
  const parsed = mode === "percent" ? parseDiscountPercent(value) : parseMoneyInput(value)
  const writePrice =
    parsed === null
      ? null
      : promotionWritePrice(
          offer,
          mode === "percent" ? { kind: "percent", percent: parsed } : { kind: "price", price: parsed },
        )
  const raising =
    frozen && offer.participating && writePrice !== null && writePrice > offer.action_price
  const elastic = elasticPriceRange(offer)
  const currentDiscount = offer.participating
    ? promotionDiscountPercent(offer.price, offer.action_price)
    : null
  const nextDiscount = writePrice === null ? null : promotionDiscountPercent(offer.price, writePrice)

  async function submit(kind: "join" | "leave") {
    setBusy(true)
    try {
      const request =
        kind === "leave"
          ? buildPromotionLeaveMutation(action.action_id, action.action_type, [offer])
          : buildPromotionJoinMutation(action.action_id, [offer], [row], () => {
              if (writePrice === null) throw new Error("请填写有效的折扣率或活动价")
              return writePrice
            })
      const { items, failure } = await dispatchChunks(
        row.store_id,
        [request],
        operationIdsFor([request]),
      )
      if (items.length > 0) {
        reportOutcome(items, (count) =>
          kind === "leave" ? `已让 ${count} 件商品退出活动` : `已更新 ${count} 件商品的活动价`,
        )
        onDone()
      }
      if (failure !== undefined) {
        notifyCommandError(failure, "促销写入未完成，请核对这件商品后再重试。")
      }
    } catch (reason) {
      notifyCommandError(reason, "促销写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="grid gap-2 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate font-medium">{action.title}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {shortDate(action.date_start)}–{shortDate(action.date_end)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {offer.participating
          ? `已参加 · 活动价 ${formatStoreMoney(offer.action_price, currency, 2)}${currentDiscount === null ? "" : ` · 折扣 ${currentDiscount}%`}`
          : "未参加"}
        {offer.max_action_price > 0
          ? ` · 上限 ${formatStoreMoney(offer.max_action_price, currency, 2)}`
          : ""}
        {elastic
          ? ` · 弹性 ${formatStoreMoney(elastic.low, currency, 2)}–${formatStoreMoney(elastic.high, currency, 2)}`
          : ""}
        {frozen ? " · 已冻结" : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "percent" ? "secondary" : "outline"}
          aria-pressed={mode === "percent"}
          onClick={() => {
            setMode("percent")
            setValue("")
          }}
        >
          折扣 %
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "price" ? "secondary" : "outline"}
          aria-pressed={mode === "price"}
          onClick={() => {
            setMode("price")
            setValue("")
          }}
        >
          活动价
        </Button>
        <div className="w-28">
          <Input
            type="text"
            inputMode="decimal"
            aria-label={mode === "percent" ? `${action.title} 的折扣率` : `${action.title} 的活动价`}
            aria-invalid={value.trim() !== "" && parsed === null ? true : undefined}
            value={value}
            placeholder={mode === "percent" ? "15" : "0.00"}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
      </div>
      {writePrice !== null ? (
        <p className="text-xs text-muted-foreground">
          将写入活动价 {formatStoreMoney(writePrice, currency, 2)}
          {nextDiscount === null ? "" : `（折扣 ${nextDiscount}%）`}
          {offer.max_action_price > 0 && writePrice === Number(offer.max_action_price.toFixed(2))
            ? "，已按上限截断"
            : ""}
          。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || writePrice === null || raising}
          onClick={() => void submit("join")}
        >
          {busy ? "正在提交…" : offer.participating ? "保存活动价" : "加入活动"}
        </Button>
        {offer.participating && exitable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || frozen}
            onClick={() => void submit("leave")}
          >
            退出活动
          </Button>
        ) : null}
      </div>
    </section>
  )
}
