/**
 * 店铺商品表「改价格」：两种口径同一个入口——
 * 按优惠率（以划线价与售价取高者为基准打折）或直接指定售价 / 划线价。
 */
import { useEffect, useState } from "react"

import type { ProductMutationRequest } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { buildDiscountMutation } from "@/features/products/product-list-model"
import { formatStoreMoney } from "@/lib/format"
import { notifyCommandError } from "@/lib/notify"

import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import {
  PRICE_MUTATION_LIMIT,
  buildFixedPriceMutation,
  chunkRows,
  parseDiscountPercent,
  parseMoneyInput,
} from "./products-mutation"

type PriceMode = "discount" | "fixed"

export type AppliedPrice = { productId: number; price: string; oldPrice: string }

export function ProductPriceDialog({
  open,
  rows,
  storeName,
  currency,
  onClose,
  onApplied,
}: {
  open: boolean
  rows: StoreProductRow[]
  storeName: string
  /** 店铺币种（`store_product_sync.currency`）；空值时拒绝提交——Ozon 要求币种与店铺一致。 */
  currency: string
  onClose: () => void
  /** 已成功写入的镜像行身份（product_id）与各自的 price/old_price。 */
  onApplied: (applied: AppliedPrice[]) => void
}) {
  const [mode, setMode] = useState<PriceMode>("discount")
  const [percentInput, setPercentInput] = useState("")
  const [priceInput, setPriceInput] = useState("")
  const [oldPriceInput, setOldPriceInput] = useState("")
  const [mutating, setMutating] = useState(false)
  const operationIdsFor = useOperationIds(open)
  const currencyReady = currency.trim() !== ""
  const example = rows[0]
  const single = rows.length === 1

  const percent = parseDiscountPercent(percentInput)
  const price = parseMoneyInput(priceInput)
  const oldPrice = oldPriceInput.trim() === "" ? null : parseMoneyInput(oldPriceInput)
  const oldPriceInvalid = oldPriceInput.trim() !== "" && oldPrice === null
  const valid = mode === "discount" ? percent !== null : price !== null && !oldPriceInvalid

  useEffect(() => {
    if (!open) return
    // 单件打开时预填现价，方便微调；批量不预填，免得误把一件的价格刷给全部。
    setMode(single ? "fixed" : "discount")
    setPercentInput("")
    const current = Number(example?.price ?? "")
    const strike = Number(example?.old_price ?? "")
    setPriceInput(single && current > 0 ? String(current) : "")
    setOldPriceInput(single && strike > current ? String(strike) : "")
  }, [open, single, example])

  function preview(): string | null {
    if (!example) return null
    const current = formatStoreMoney(example.price, currency, 2)
    if (mode === "fixed") {
      return price === null ? null : `${current} → ${formatStoreMoney(price, currency, 2)}`
    }
    if (percent === null) return null
    const base = Math.max(Number(example.old_price ?? "") || 0, Number(example.price ?? "") || 0)
    if (base <= 0) return null
    const next = percent === 0 ? base : Math.max(0.01, base * (1 - percent / 100))
    // 预览必须和实际写入同一币种口径——写入按 `currency` 提交。
    return `${current} → ${formatStoreMoney(next, currency, 2)}`
  }

  function buildRequests(): ProductMutationRequest[] {
    return chunkRows(rows, PRICE_MUTATION_LIMIT).map((chunk) =>
      mode === "fixed"
        ? buildFixedPriceMutation(chunk, price ?? 0, oldPrice, currency)
        : buildDiscountMutation(
            chunk.map((row) => ({
              productId: row.product_id,
              offerId: row.offer_id,
              price: Number(row.price ?? 0),
              oldPrice: Number(row.old_price ?? 0),
              currencyCode: currency,
            })),
            percent ?? 0,
          ),
    )
  }

  async function submit() {
    const storeId = rows[0]?.store_id
    if (!storeId || !valid || !currencyReady) return
    let requests: ProductMutationRequest[]
    try {
      requests = buildRequests()
    } catch (reason) {
      notifyCommandError(reason, "操作参数无效，请检查填写内容后重试。")
      return
    }
    setMutating(true)
    try {
      const { items, failure } = await dispatchChunks(storeId, requests, operationIdsFor(requests))
      if (items.length > 0) {
        const succeeded = new Set(
          reportOutcome(items, (count) => `已更新 ${count} 件商品的价格`),
        )
        // 价格回执只回 offer_id：每个 item 按自己的 offer 是否成功来判定。
        onApplied(
          requests.flatMap((request) =>
            request.kind !== "price"
              ? []
              : request.items
                .filter((item) => item.offer_id && succeeded.has(item.offer_id))
                .map((item) => ({
                  productId: item.product_id,
                  price: item.price,
                  oldPrice: item.old_price,
                })),
          ),
        )
      }
      if (failure !== undefined) {
        // 对话框保持打开：同内容重试复用同一组 operation_id，已落地分块由账本重放。
        notifyCommandError(failure, "部分分块未提交；已提交的分块不会重复写入，请稍后重试。")
        return
      }
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "Ozon 价格写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setMutating(false)
    }
  }

  const previewText = preview()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !mutating && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>修改价格</DialogTitle>
          <DialogDescription>
            {single
              ? `${storeName} · ${example?.offer_id ?? ""}（币种 ${currency || "未知"}）`
              : `将对 ${storeName} 中的 ${rows.length} 件商品统一改价（币种 ${currency || "未知"}）。`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!currencyReady ? (
            <p className="text-xs text-st-attest-ink">
              店铺币种未知，无法提交价格写入；请先对本店执行一次「立即更新」。
            </p>
          ) : null}
          <Tabs value={mode} onValueChange={(next) => setMode(next as PriceMode)}>
            <TabsList aria-label="改价方式" className="h-8 w-fit">
              <TabsIndicator />
              <TabsTrigger value="discount" className="h-7 w-20">按优惠率</TabsTrigger>
              <TabsTrigger value="fixed" className="h-7 w-20">指定价格</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "discount" ? (
            <label className="grid gap-1.5 text-compact">
              <span className="font-medium">优惠率（%）</span>
              <Input
                type="number"
                min={0}
                max={99}
                step={0.1}
                value={percentInput}
                aria-invalid={(percentInput.trim() !== "" && percent === null) || undefined}
                onChange={(event) => setPercentInput(event.target.value)}
              />
              <small className="text-muted-foreground">
                以各商品当前标价（划线价与售价取高者）为基准打折；0 表示清除优惠、恢复原价。
              </small>
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-compact">
                <span className="font-medium">售价</span>
                <Input
                  inputMode="decimal"
                  value={priceInput}
                  aria-invalid={(priceInput.trim() !== "" && price === null) || undefined}
                  onChange={(event) => setPriceInput(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-compact">
                <span className="font-medium">划线价（可选）</span>
                <Input
                  inputMode="decimal"
                  value={oldPriceInput}
                  aria-invalid={oldPriceInvalid || undefined}
                  onChange={(event) => setOldPriceInput(event.target.value)}
                />
              </label>
              <small className="col-span-2 text-muted-foreground">
                划线价需高于售价才会展示；留空表示不设划线价。
              </small>
            </div>
          )}
          {previewText ? (
            <p className="text-xs text-muted-foreground">
              {single ? "" : `示例 ${example?.offer_id}：`}
              {previewText}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={mutating} onClick={onClose}>
            取消
          </Button>
          <Button disabled={mutating || !valid || !currencyReady} onClick={() => void submit()}>
            {mutating ? "正在提交…" : "确认提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
