import { Download, RefreshCw, Search, Tags } from "lucide-react"
import { PageToolbar } from "@/components/page-toolbar"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { freshnessLabel } from "./freshness"
import type { StoreProductOverviewRow, StoreProductStatusFilter } from "./products-api"
import { StoreSyncActions } from "./store-sync-actions"

export const ALL_STORES = "all"
const STATUS_LABELS: Record<string, string> = {
  all: "全部状态",
  on_sale: "在售",
  processing: "处理中",
  hidden: "隐藏",
  moderation_failed: "审核失败",
  archived: "已归档",
  delisted: "已下架",
  zero_stock: "零库存",
}

type ProductsToolbarProps = {
  storeId: string | null
  stores: StoreProductOverviewRow[]
  selected: StoreProductOverviewRow | null
  syncDisabled: boolean
  scheduling: ReadonlySet<string>
  syncableStores: StoreProductOverviewRow[]
  onValueChange: (next: string | null) => void
  syncStores: (targets: StoreProductOverviewRow[]) => Promise<void>
  reloadOverview: () => Promise<void>
  reloadList: () => Promise<void>
  search: string
  onSearch: (value: string) => void
  status: StoreProductStatusFilter | undefined
  onStatus: (status: StoreProductStatusFilter | undefined) => void
  selectedCount: number
  onPromotions: () => void
  onExport: () => void
  onExportFiltered?: () => void
  exporting?: boolean
}

export function ProductsToolbar({
  storeId,
  stores,
  selected,
  syncDisabled,
  scheduling,
  syncableStores,
  onValueChange,
  syncStores,
  reloadOverview,
  reloadList,
  search,
  onSearch,
  status,
  onStatus,
  selectedCount,
  onPromotions,
  onExport,
  onExportFiltered,
  exporting = false,
}: ProductsToolbarProps) {
  const syncingAny = scheduling.size > 0

  return (
    <PageToolbar
      primary={
        <>
          {storeId === null ? (
            <Button type="button" size="sm" variant="outline" disabled>
              正在读取店铺…
            </Button>
          ) : (
            <Select
              value={storeId}
              onValueChange={onValueChange}
            >
              <SelectTrigger
                size="sm"
                className="min-w-56"
                aria-label="当前店铺"
                disabled={stores.length === 0}
              >
                <SelectValue>
                  {(value) =>
                    value === ALL_STORES
                      ? `全部店铺（${stores.length}）`
                      : (stores.find((store) => store.store_id === value)?.name ?? "选择店铺")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STORES}>全部店铺（{stores.length}）</SelectItem>
                {stores.map((store) => (
                  <SelectItem key={store.store_id} value={store.store_id}>
                    {store.name}
                    <span className="text-muted-foreground">{freshnessLabel(store.freshness)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <InputGroup className="min-w-48 flex-1 sm:max-w-sm">
            <InputGroupAddon align="inline-start"><Search aria-hidden /></InputGroupAddon>
            <InputGroupInput value={search} onChange={(event) => onSearch(event.target.value)}
              placeholder="搜索商品名、货号或 SKU" aria-label="搜索商品" />
          </InputGroup>
          <Select value={status ?? ALL_STORES} onValueChange={(next) => onStatus(!next || next === ALL_STORES ? undefined : next as StoreProductStatusFilter)}>
            <SelectTrigger size="sm" aria-label="商品状态筛选" className="min-w-36"><SelectValue>{(value) => STATUS_LABELS[String(value)] ?? "全部状态"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STORES}>全部状态</SelectItem>
              <SelectItem value="on_sale">在售</SelectItem>
              <SelectItem value="processing">处理中</SelectItem>
              <SelectItem value="hidden">隐藏</SelectItem>
              <SelectItem value="moderation_failed">审核失败</SelectItem>
              <SelectItem value="archived">已归档</SelectItem>
              <SelectItem value="delisted">已下架</SelectItem>
              <SelectItem value="zero_stock">零库存</SelectItem>
            </SelectContent>
          </Select>
          {selected ? (
            <StoreSyncActions
              store={selected}
              syncDisabled={syncDisabled}
              scheduling={scheduling.has(selected.store_id)}
              onSchedule={() => void syncStores([selected])}
            />
          ) : storeId === ALL_STORES && stores.length > 0 ? (
            <Button
              type="button"
              size="sm"
              disabled={syncingAny || syncableStores.length === 0}
              onClick={() => void syncStores(syncableStores)}
            >
              {syncingAny ? "提交中…" : `全部更新（${syncableStores.length}）`}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={storeId === null || stores.length === 0} onClick={onPromotions}><Tags aria-hidden />促销活动</Button>
          <Button type="button" size="sm" variant="outline" disabled={exporting || storeId === null || stores.length === 0 || (selectedCount === 0 && !onExportFiltered)} onClick={selectedCount ? onExport : onExportFiltered}
            title={selectedCount ? "导出已选商品" : "导出当前筛选的全部商品"}>
            <Download aria-hidden />{exporting ? "导出中…" : selectedCount ? `导出已选 CSV（${selectedCount}）` : "导出筛选 CSV"}
          </Button>
          {selectedCount > 0 && onExportFiltered ? <Button type="button" size="sm" variant="ghost" disabled={exporting} onClick={onExportFiltered}>导出筛选 CSV</Button> : null}
        </>
      }
      secondary={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="重新读取商品表"
                onClick={() => {
                  void reloadOverview()
                  void reloadList()
                }}
              />
            }
          >
            <RefreshCw aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="bottom">重新读取商品表（不请求 Ozon）</TooltipContent>
        </Tooltip>
      }
    />
  )
}
