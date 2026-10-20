/** 店铺商品表「改库存」：按 FBS / rFBS 仓库写同一绝对数量。 */
import { useEffect, useState } from "react"

import { opsHttp } from "@/bindings/http-ops"
import type {
  ProductMutationRequest,
  ProductWarehouseStockView,
  ProductWarehouseView,
} from "@/bindings/commands"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  buildStockMutation,
  currentStockPresent,
  warehouseStatusLabel,
} from "@/features/products/product-list-model"
import { clearLive, notifyCommandError, notifyError, notifyInfo } from "@/lib/notify"

import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { STOCK_MUTATION_LIMIT, chunkRows, parseStockInput } from "./products-mutation"

export function ProductStockDialog({
  open,
  rows,
  storeName,
  onClose,
  onApplied,
}: {
  open: boolean
  /** 同一家店铺的可写行（外层已过滤+按店分组）。 */
  rows: StoreProductRow[]
  storeName: string
  onClose: () => void
  /** 有分块成功落地时通知外层。镜像的库存是跨来源合计，写入只动了单个
   * 仓库——这里不回填行，由外层向 Ozon 核实真实合计。 */
  onApplied: () => void
}) {
  const [warehouses, setWarehouses] = useState<ProductWarehouseView[]>([])
  const [warehouseStocks, setWarehouseStocks] = useState<ProductWarehouseStockView[]>([])
  const [warehousesLoading, setWarehousesLoading] = useState(false)
  const [warehouseId, setWarehouseId] = useState("")
  const [stockInput, setStockInput] = useState("")
  const [mutating, setMutating] = useState(false)
  const operationIdsFor = useOperationIds(open)
  const storeId = rows[0]?.store_id ?? ""
  const stock = parseStockInput(stockInput)
  const stockInputValid = stock !== null
  const selectedWarehouse = warehouses.find(
    (warehouse) => String(warehouse.warehouse_id) === warehouseId,
  )

  /** The one-line hint under the warehouse picker, first match wins. */
  function stockHint(): { text: string; tone: "plain" | "attest" } {
    if (!warehousesLoading && warehouses.length === 0) {
      return {
        text: "当前店铺没有可由 Seller API 修改的 FBS / rFBS 仓库；Ozon FBO 库存由平台管理。",
        tone: "plain",
      }
    }
    if (selectedWarehouse && !selectedWarehouse.is_active) {
      return {
        text: `该仓库当前为「${warehouseStatusLabel(selectedWarehouse.status)}」，写入仍会提交，但商品不会在此仓库开卖。`,
        tone: "attest",
      }
    }
    if (rows.length === 1) {
      return {
        text: "已读取该商品在所选仓库的当前库存；提交后会设置为上方绝对数量。",
        tone: "plain",
      }
    }
    return {
      text: `批量操作会把 ${rows.length} 件商品在所选仓库统一设置为同一绝对数量。`,
      tone: "plain",
    }
  }

  useEffect(() => {
    if (stockInput.trim() === "" || stockInputValid) {
      clearLive("products-stock-input")
      return
    }
    notifyError("请输入大于或等于 0 的整数。", { id: "products-stock-input" })
  }, [stockInput, stockInputValid])

  useEffect(() => {
    if (!open || !storeId || rows.length === 0) return
    let cancelled = false
    setWarehousesLoading(true)
    setWarehouses([])
    setWarehouseStocks([])
    setWarehouseId("")
    setStockInput("")
    void opsHttp
      .productsListWarehouses({
        store_id: storeId,
        skus: rows.map((row) => row.sku ?? 0),
      })
      .then((next) => {
        if (cancelled) return
        setWarehouses(next.warehouses)
        setWarehouseStocks(next.stocks)
        const nextWarehouseId = String(next.warehouses[0]?.warehouse_id ?? "")
        setWarehouseId(nextWarehouseId)
        const currentStock = rows.length === 1
          ? currentStockPresent(next.stocks, rows[0]?.sku ?? 0, nextWarehouseId)
          : undefined
        // 预填只信仓库口径的读数；镜像的 stockPresent 是跨来源合计（含
        // FBO），拿它当单仓预填会把 FBO 量灌进 FBS——查不到时按 0 起步。
        setStockInput(rows.length === 1 ? String(currentStock ?? 0) : "")
        if (next.warehouses.length === 0) {
          notifyInfo(
            rows.length > 1
              ? "所选商品没有共同可编辑的 FBS / rFBS 仓库，请减少选择后重试。"
              : "Ozon 未返回可编辑的 FBS / rFBS 仓库；FBO 库存不能手动修改。",
          )
        }
      })
      .catch((reason) => {
        if (!cancelled) notifyCommandError(reason, "无法读取 Ozon 仓库，请稍后重试。")
      })
      .finally(() => {
        if (!cancelled) setWarehousesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, storeId, rows])

  async function submit() {
    if (!storeId || stock === null || !warehouseId) return
    let requests: ProductMutationRequest[]
    try {
      requests = chunkRows(rows, STOCK_MUTATION_LIMIT).map((chunk) =>
        buildStockMutation(
          chunk.map((row) => ({
            productId: row.product_id,
            offerId: row.offer_id,
            sku: row.sku ?? 0,
          })),
          Number(warehouseId),
          stock,
        ),
      )
    } catch (reason) {
      notifyCommandError(reason, "操作参数无效，请检查填写内容后重试。")
      return
    }
    setMutating(true)
    try {
      const { items, failure } = await dispatchChunks(storeId, requests, operationIdsFor(requests))
      if (items.length > 0) {
        reportOutcome(items, (count) => `已将 ${count} 件商品库存设为 ${stock}`)
        onApplied()
      }
      if (failure !== undefined) {
        // 对话框保持打开：同内容重试复用同一组 operation_id，已落地分块由账本重放。
        notifyCommandError(failure, "部分分块未提交；已提交的分块不会重复写入，请稍后重试。")
        return
      }
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "Ozon 库存写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setMutating(false)
    }
  }

  const hint = stockHint()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !mutating && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>修改库存</DialogTitle>
          <DialogDescription>
            将对 {storeName} 中的 {rows.length} 件商品设置为同一可售库存。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-compact">
            <span className="font-medium">FBS / rFBS 仓库</span>
            <Select
              disabled={warehousesLoading || warehouses.length === 0}
              value={warehouseId}
              onValueChange={(value) => {
                if (!value) return
                setWarehouseId(value)
                if (rows.length === 1) {
                  const currentStock = currentStockPresent(
                    warehouseStocks,
                    rows[0]?.sku ?? 0,
                    value,
                  )
                  setStockInput(String(currentStock ?? 0))
                }
              }}
            >
              <SelectTrigger aria-label="目标仓库">
                <SelectValue>
                  {() => {
                    if (warehousesLoading) return "正在读取仓库…"
                    if (warehouses.length === 0) return "没有可编辑仓库"
                    return (
                      warehouses.find((item) => String(item.warehouse_id) === warehouseId)?.name
                      ?? "选择仓库"
                    )
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.warehouse_id} value={String(warehouse.warehouse_id)}>
                    {warehouse.name} · {warehouse.is_rfbs ? "rFBS" : "FBS"}
                    {warehouse.is_active ? "" : ` · ${warehouseStatusLabel(warehouse.status)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p
            className={
              hint.tone === "attest" ? "text-xs text-st-attest-ink" : "text-xs text-muted-foreground"
            }
          >
            {hint.text}
          </p>
          <label className="grid gap-1.5 text-compact">
            <span className="font-medium">目标可售库存</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={stockInput}
              aria-invalid={(stockInput.trim() !== "" && !stockInputValid) || undefined}
              onChange={(event) => setStockInput(event.target.value)}
            />
            <small className="text-muted-foreground">
              设置绝对数量；0 表示该仓库售罄。
            </small>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={mutating} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={mutating || !warehouseId || !stockInputValid}
            onClick={() => void submit()}
          >
            {mutating ? "正在提交…" : "确认提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
