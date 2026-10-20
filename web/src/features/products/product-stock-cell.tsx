/** 库存列：格子里是镜像合计，编辑在这一列的浮层里，不放进展开详情。 */
import { useEffect, useState, type ReactNode } from "react"
import { Pencil } from "lucide-react"

import { opsHttp } from "@/bindings/http-ops"
import type { ProductMutationRequest, ProductWarehouseView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { TableCell } from "@/components/ui/table"
import {
  buildStockMutation,
  currentStockPresent,
  warehouseStatusLabel,
} from "@/features/products/product-list-model"
import { notifyCommandError } from "@/lib/notify"
import { ProductStockReading } from "./product-read-cells"

import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { actionBlockReason, parseStockInput } from "./products-mutation"

export function ProductStockCell({
  row,
  onApplied,
}: {
  row: StoreProductRow
  onApplied: (row: StoreProductRow) => void
}) {
  const [open, setOpen] = useState(false)
  const blocked = actionBlockReason("stock", row)
  if (blocked) {
    return (
      <TableCell className="whitespace-nowrap text-right font-mono tabular-nums" title={blocked}>
        <ProductStockReading row={row} />
      </TableCell>
    )
  }
  return (
    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`修改 ${row.offer_id} 的库存`}
              className="group/edit ml-auto flex cursor-pointer items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          }
        >
          <Pencil
            className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100"
            aria-hidden
          />
          <ProductStockReading row={row} />
        </PopoverTrigger>
        <PopoverContent align="end">
          {open ? <StockEditor row={row} onApplied={onApplied} /> : null}
        </PopoverContent>
      </Popover>
    </TableCell>
  )
}

function StockEditor({
  row,
  onApplied,
}: {
  row: StoreProductRow
  onApplied: (row: StoreProductRow) => void
}) {
  const [warehouses, setWarehouses] = useState<ProductWarehouseView[]>([])
  const [stocks, setStocks] = useState<{ sku: number; warehouse_id: number; present: number }[]>([])
  const [warehouseId, setWarehouseId] = useState("")
  const [stockInput, setStockInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const operationIdsFor = useOperationIds(`${row.product_id}:stock`)
  const stock = parseStockInput(stockInput)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void opsHttp
      .productsListWarehouses({ store_id: row.store_id, skus: [row.sku ?? 0] })
      .then((next) => {
        if (cancelled) return
        setWarehouses(next.warehouses)
        setStocks(next.stocks)
        const id = String(next.warehouses[0]?.warehouse_id ?? "")
        setWarehouseId(id)
        setStockInput(String(currentStockPresent(next.stocks, row.sku ?? 0, id) ?? 0))
      })
      .catch((reason) => {
        if (!cancelled) notifyCommandError(reason, "无法读取 Ozon 仓库，请稍后重试。")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [row])

  async function submit() {
    if (stock === null || !warehouseId) return
    let request: ProductMutationRequest
    try {
      request = buildStockMutation(
        [{ productId: row.product_id, offerId: row.offer_id, sku: row.sku ?? 0 }],
        Number(warehouseId),
        stock,
      )
    } catch (reason) {
      notifyCommandError(reason, "操作参数无效，请检查填写内容后重试。")
      return
    }
    setBusy(true)
    try {
      const { items, failure } = await dispatchChunks(row.store_id, [request], operationIdsFor([request]))
      if (items.length > 0) {
        reportOutcome(items, (count) => `已将 ${count} 件商品库存设为 ${stock}`)
        onApplied(row)
      }
      if (failure !== undefined) notifyCommandError(failure, "库存写入未完成，请核对后再重试。")
    } catch (reason) {
      notifyCommandError(reason, "Ozon 库存写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setBusy(false)
    }
  }

  let body: ReactNode
  if (loading) {
    body = (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" aria-label="正在读取仓库" />
        正在读取可编辑仓库…
      </div>
    )
  } else if (warehouses.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        没有可由 Seller API 修改的 FBS / rFBS 仓库。FBO 库存由 Ozon 管理。
      </p>
    )
  } else {
    body = (
      <div className="grid gap-2">
        <div className="w-full">
          <Select
            value={warehouseId}
            onValueChange={(value) => {
              if (!value) return
              setWarehouseId(value)
              setStockInput(String(currentStockPresent(stocks, row.sku ?? 0, value) ?? 0))
            }}
          >
            <SelectTrigger aria-label={`${row.offer_id} 的仓库`}>
              <SelectValue>
                {() =>
                  warehouses.find((item) => String(item.warehouse_id) === warehouseId)?.name ?? "选择仓库"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.warehouse_id} value={String(warehouse.warehouse_id)}>
                  {warehouse.name}
                  {warehouse.is_active ? "" : ` · ${warehouseStatusLabel(warehouse.status)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-24">
            <Input
              type="text"
              inputMode="numeric"
              aria-label={`${row.offer_id} 的目标库存`}
              aria-invalid={stockInput.trim() !== "" && stock === null ? true : undefined}
              value={stockInput}
              onChange={(event) => setStockInput(event.target.value)}
            />
          </div>
          <Button type="button" size="sm" disabled={busy || stock === null} onClick={() => void submit()}>
            {busy ? "正在提交…" : "保存库存"}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">库存</h3>
        <p className="text-xs text-muted-foreground">只改所选 FBS / rFBS 仓库，不含 FBO。</p>
      </div>
      {body}
    </div>
  )
}
