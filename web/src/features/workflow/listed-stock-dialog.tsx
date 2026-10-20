import { useEffect, useState } from "react"
import { opsHttp } from "@/bindings/http-ops"
import type {
  ProductWarehouseStockView,
  ProductWarehouseView,
  WorkflowDraftView,
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
import { clearLive, notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { readProductSnapshot } from "@/features/products/product-snapshot-store"
import { parseStoreIds } from "./store-quota"
import type { ListingRow } from "./model/listing-row"
import { bucketOf } from "./model/listing-row-lifecycle"
import { offerIdForSource } from "./product-instances"
import { valueAsText } from "./workflow-draft"

export type ListedStockTarget = {
  rowId: string
  storeId: string
  productId: number
  offerId: string
  sku: number
}

/**
 * Rows the toolbar 改库存 can write: selected rows, or every listed row
 * when nothing is ticked. Identity comes from the ListingRowView lifecycle
 * plus the Draft offer_id, falling back to the 商品 snapshot for a Seller SKU
 * assigned after the submission receipt was frozen.
 */
export function listedStockTargets(
  rows: readonly ListingRow[],
  productDrafts: Readonly<Record<string, WorkflowDraftView>>,
  selectedRowIds: ReadonlySet<string>,
  cardStoreId: string,
  readSnapshot = readProductSnapshot,
): ListedStockTarget[] {
  const bound = parseStoreIds(cardStoreId)
  const fallback = bound.length === 1 ? bound[0]! : ""
  const scope = selectedRowIds.size > 0
    ? rows.filter((row) => selectedRowIds.has(row.id))
    : rows
  const targets: ListedStockTarget[] = []
  const snapshots = new Map<string, ReturnType<typeof readSnapshot>>()
  for (const row of scope) {
    const product = productDrafts[row.draftId]
    let sku = product?.lifecycle.ozon_sku ?? 0
    let productId = product?.lifecycle.ozon_product_id ?? 0
    const offerId = valueAsText(product?.draft.values.offer_id).trim()
      || offerIdForSource(row.imageName).trim()
    const storeId = product?.target_store_id?.trim() || fallback
    if (!offerId || !storeId) continue
    // Submission receipts are frozen before Seller assigns a SKU. Resolve the
    // inventory identity from the same account/store snapshot as 商品 instead.
    if (sku <= 0 || productId <= 0) {
      if (!product || bucketOf(product.lifecycle) !== "sent") continue
      if (!snapshots.has(storeId)) snapshots.set(storeId, readSnapshot(storeId))
      const matches = snapshots.get(storeId)?.products.filter((item) =>
        item.offerId === offerId && (productId <= 0 || item.productId === productId),
      ) ?? []
      if (matches.length === 1) {
        sku = matches[0]!.sku
        productId = matches[0]!.productId
      }
    }
    if (sku <= 0 || productId <= 0) continue
    targets.push({ rowId: row.id, storeId, productId, offerId, sku })
  }
  return targets
}

export function listedStockStoreId(
  targets: readonly ListedStockTarget[],
): string | undefined {
  if (targets.length === 0) return undefined
  const storeId = targets[0]!.storeId
  return targets.every((target) => target.storeId === storeId) ? storeId : undefined
}

export function ListedStockDialog({
  open,
  targets,
  storeLabel,
  onClose,
}: {
  open: boolean
  targets: ListedStockTarget[]
  storeLabel: string
  onClose: () => void
}) {
  const [warehouses, setWarehouses] = useState<ProductWarehouseView[]>([])
  const [warehouseStocks, setWarehouseStocks] = useState<ProductWarehouseStockView[]>([])
  const [warehousesLoading, setWarehousesLoading] = useState(false)
  const [warehouseId, setWarehouseId] = useState("")
  const [stockInput, setStockInput] = useState("")
  const [mutating, setMutating] = useState(false)
  const [operationId, setOperationId] = useState("")
  const storeId = listedStockStoreId(targets)
  const stockValue = Number(stockInput)
  const stockInputValid =
    stockInput.trim() !== "" && Number.isSafeInteger(stockValue) && stockValue >= 0
  const selectedWarehouse = warehouses.find(
    (warehouse) => String(warehouse.warehouse_id) === warehouseId,
  )

  useEffect(() => {
    if (stockInput.trim() === "" || stockInputValid) {
      clearLive("listed-stock-input")
      return
    }
    notifyError("请输入大于或等于 0 的整数。", { id: "listed-stock-input" })
  }, [stockInput, stockInputValid])

  useEffect(() => {
    if (!open || !storeId || targets.length === 0) return
    let cancelled = false
    setWarehousesLoading(true)
    setWarehouses([])
    setWarehouseStocks([])
    setWarehouseId("")
    setStockInput("")
    setOperationId(crypto.randomUUID())
    void opsHttp
      .productsListWarehouses({
        store_id: storeId,
        skus: targets.map((target) => target.sku),
      })
      .then((next) => {
        if (cancelled) return
        setWarehouses(next.warehouses)
        setWarehouseStocks(next.stocks)
        const nextWarehouseId = String(next.warehouses[0]?.warehouse_id ?? "")
        setWarehouseId(nextWarehouseId)
        const currentStock = targets.length === 1
          ? currentStockPresent(next.stocks, targets[0]?.sku ?? 0, nextWarehouseId)
          : undefined
        setStockInput(targets.length === 1 ? String(currentStock ?? 0) : "")
        if (next.warehouses.length === 0) {
          notifyInfo(
            targets.length > 1
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
  }, [open, storeId, targets])

  async function submit() {
    if (!storeId || !operationId || !stockInputValid || !warehouseId) return
    let request
    try {
      request = buildStockMutation(targets, Number(warehouseId), Number(stockInput))
    } catch (reason) {
      notifyCommandError(reason, "操作参数无效，请检查填写内容后重试。")
      return
    }
    setMutating(true)
    try {
      const response = await opsHttp.productsMutate({
        operation_id: operationId,
        store_id: storeId,
        request,
      })
      const failed = response.items.filter((item) => !item.succeeded)
      if (failed.length > 0) {
        const details = failed
          .slice(0, 2)
          .map((item) => `${item.identity}：${item.message || "Ozon 未提供失败原因"}`)
          .join("；")
        notifyInfo(
          `Ozon 已处理；成功 ${response.items.length - failed.length}，失败 ${failed.length}。${details}`,
        )
      } else {
        notifySuccess(`已将 ${response.items.length} 件商品库存设为 ${stockInput}`)
      }
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "Ozon 库存写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setMutating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !mutating && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>修改库存</DialogTitle>
          <DialogDescription>
            将对 {storeLabel} 中的 {targets.length} 件已上架商品设置为同一可售库存。
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
                if (targets.length === 1) {
                  const currentStock = currentStockPresent(
                    warehouseStocks,
                    targets[0]?.sku ?? 0,
                    value,
                  )
                  setStockInput(String(currentStock ?? 0))
                }
              }}
            >
              <SelectTrigger aria-label="目标仓库">
                <SelectValue>
                  {() =>
                    warehousesLoading
                      ? "正在读取仓库…"
                      : warehouses.find((item) => String(item.warehouse_id) === warehouseId)
                          ?.name
                        ?? (warehouses.length === 0 ? "没有可编辑仓库" : "选择仓库")
                  }
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
          {!warehousesLoading && warehouses.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              当前店铺没有可由 Seller API 修改的 FBS / rFBS 仓库；Ozon FBO 库存由平台管理。
            </p>
          ) : selectedWarehouse && !selectedWarehouse.is_active ? (
            <p className="text-xs text-st-attest-ink">
              该仓库当前为「{warehouseStatusLabel(selectedWarehouse.status)}」，写入仍会提交，但商品不会在此仓库开卖。
            </p>
          ) : targets.length === 1 ? (
            <p className="text-xs text-muted-foreground">
              已读取该商品在所选仓库的当前库存；提交后会设置为上方绝对数量。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              批量操作会把 {targets.length} 件商品在所选仓库统一设置为同一绝对数量。
            </p>
          )}
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

/**
 * Rows that can be written in one dialog pass: when the candidate set spans
 * several Stores, keep the largest same-Store group instead of refusing.
 * A mixed selection is the normal state after「全部发送」splits across two
 * Stores, so the count on the ribbon would otherwise be a trap.
 */
export function listedStockSingleStoreTargets(
  targets: readonly ListedStockTarget[],
): ListedStockTarget[] {
  if (listedStockStoreId(targets)) return [...targets]
  const byStore = new Map<string, ListedStockTarget[]>()
  for (const target of targets) {
    const group = byStore.get(target.storeId)
    if (group) group.push(target)
    else byStore.set(target.storeId, [target])
  }
  let best: ListedStockTarget[] = []
  for (const group of byStore.values()) {
    if (group.length > best.length) best = group
  }
  return best
}

export function openListedStockOrExplain(
  targets: ListedStockTarget[],
  selected: boolean,
  onOpen: (targets: ListedStockTarget[]) => void,
) {
  if (targets.length === 0) {
    notifyError(
      selected
        ? "尚未找到已选行的 Ozon SKU，请先到店铺商品同步后重试"
        : "尚未找到带 SKU 的商品，请先到店铺商品同步后重试",
    )
    return
  }
  const single = listedStockSingleStoreTargets(targets)
  if (single.length === 0) {
    notifyError("已上架商品属于多家店铺，请先选择同一店铺的行")
    return
  }
  onOpen(single)
}
