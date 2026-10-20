import { RefreshCw } from "lucide-react"
import { PageToolbar } from "@/components/page-toolbar"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { freshnessLabel } from "./freshness"
import type { StoreProductOverviewRow } from "./products-api"
import { StoreSyncActions } from "./store-sync-actions"

export const ALL_STORES = "all"

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
