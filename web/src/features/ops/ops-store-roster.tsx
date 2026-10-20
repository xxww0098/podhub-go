/**
 * ops 屏共用的「店铺名册」装载件：returns / shipping / supply / voice 四屏
 * 各自维护业务列表，但店铺引导（拉名册、loading/error/reason、重试、失效
 * 序号）完全同构，统一抽到这里。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { OzonStoreView } from "@/bindings/commands"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  activeCloudStoreUid,
  loadStoreRoster,
  peekStoreRoster,
} from "@/features/stores/store-roster-cache"
import { errorMessage } from "@/lib/error-message"

/** ops 屏统一的店铺条目：cloud store uid + 操作员可见的展示名。 */
export type OpsStore = {
  storeUid: string
  name: string
  clientId: string
}

function toOpsStore(store: OzonStoreView, storeUid: string): OpsStore {
  return {
    storeUid,
    name: store.label,
    clientId: store.client_id,
  }
}

/** 名册 → 本屏可用店列表：只留已接 cloud store uid 的店。 */
export function opsStoresFromRoster(stores: OzonStoreView[]): OpsStore[] {
  return stores.flatMap((store) => {
    const storeUid = activeCloudStoreUid(store)
    return storeUid ? [toOpsStore(store, storeUid)] : []
  })
}

/** 已选店仍在名册就保持，否则跟随 active 店，再退到第一家。 */
export function preferredStoreUid(
  stores: readonly { storeUid: string }[],
  activeId: string | null | undefined,
): string {
  if (activeId && stores.some((store) => store.storeUid === activeId)) {
    return activeId
  }
  return stores[0]?.storeUid ?? ""
}

/**
 * 店铺名册装载：`storesLoading/storesError/storesReason/retryStores` 是
 * StoreGate 的直接口粮。`onInvalidate` 在 effect 进入与清理时各触发一次，
 * 供各屏作废自己的请求序号；`onRosterMiss` 只在名册读取失败且缓存为空时
 * 触发（回调里自行判断本地是否有店可退）；`onCleanup` 仅清理时触发
 * （收 toast 等）。回调走 ref，不进依赖数组，重渲染不重跑装载。
 */
export function useOpsStoreRoster(options: {
  workspaceId?: number
  active: boolean
  hasStores?: () => boolean
  onInvalidate?: () => void
  onRosterMiss?: () => void
  onCleanup?: () => void
}) {
  const { workspaceId, active } = options
  const [storesLoading, setStoresLoading] = useState(true)
  const [storesError, setStoresError] = useState("")
  const [storesReason, setStoresReason] = useState<unknown>()
  const [rosterRetry, setRosterRetry] = useState(0)

  const hasStoresRef = useRef(options.hasStores)
  const invalidateRef = useRef(options.onInvalidate)
  const missRef = useRef(options.onRosterMiss)
  const cleanupRef = useRef(options.onCleanup)
  hasStoresRef.current = options.hasStores
  invalidateRef.current = options.onInvalidate
  missRef.current = options.onRosterMiss
  cleanupRef.current = options.onCleanup

  useEffect(() => {
    if (!active) return
    let cancelled = false
    invalidateRef.current?.()
    setStoresLoading(!hasStoresRef.current?.())
    setStoresError("")
    setStoresReason(undefined)
    void loadStoreRoster({ workspaceId })
      .then(() => {
        if (!cancelled) setStoresError("")
      })
      .catch((reason) => {
        if (cancelled) return
        setStoresError(errorMessage(reason, "无法读取店铺配置。"))
        setStoresReason(() => reason)
        if (!peekStoreRoster(workspaceId)) missRef.current?.()
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false)
      })
    return () => {
      cancelled = true
      setStoresLoading(false)
      invalidateRef.current?.()
      cleanupRef.current?.()
    }
  }, [active, rosterRetry, workspaceId])

  const retryStores = useCallback(() => setRosterRetry((value) => value + 1), [])

  return { storesLoading, storesError, storesReason, retryStores }
}

/** ops 屏统一的当前店铺下拉（aria-label 固定为「当前店铺」）。 */
export function OpsStoreSelect({
  value,
  stores,
  onChange,
  triggerClassName = "min-w-56",
}: {
  value: string
  stores: OpsStore[]
  onChange: (next: string) => void
  triggerClassName?: string
}) {
  const selected = stores.find((store) => store.storeUid === value)
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger size="sm" className={triggerClassName} aria-label="当前店铺">
        <SelectValue>
          {() =>
            selected ? `${selected.name} · ${selected.clientId}` : "选择已接入店铺"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {stores.map((store) => (
          <SelectItem key={store.storeUid} value={store.storeUid}>
            {store.name} · {store.clientId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
