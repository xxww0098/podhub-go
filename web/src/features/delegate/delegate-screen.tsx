/**
 * 委托订单屏：店选择器 + 三个视图——
 *
 * - 发货单（主视图）：未履约 posting 行级委托态 + 委托/补齐流；
 * - 委托单：单级状态列表 + 详情（撤单/收口）；
 * - 绑定：商品级预绑厂家与原图素材管理。
 *
 * 店面沿用 ops-shipping 的 roster 纪律（成员只见指派店——服务端
 * `visible_store_ids` 已过滤，这里只排除不可用的云店）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Package } from "lucide-react"

import type { DelegateSource } from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import { DelegatePostingsView } from "./delegate-postings-view"
import { DelegateOrdersView } from "./delegate-orders-view"
import { DelegateBindingsView } from "./delegate-bindings-view"
import { StoreGate } from "@/features/stores/store-gate"
import {
  activeCloudStoreUid,
  loadStoreRoster,
  peekStoreRoster,
  rosterHasUnavailableStores,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import { PageToolbar } from "@/components/page-toolbar"
import { Section } from "@/components/section"
import { useScreenActive } from "@/components/screen-pane"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { notifyCommandError } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"

type DelegateTab = "postings" | "orders" | "bindings"

const TABS: { value: DelegateTab; label: string }[] = [
  { value: "postings", label: "发货单" },
  { value: "orders", label: "委托单" },
  { value: "bindings", label: "绑定" },
]

export type DelegateOrdersScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

export function DelegateOrdersScreen({
  workspaceId,
  onOpenStores,
}: DelegateOrdersScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [stores, setStores] = useState<{ storeUid: string; name: string }[]>([])
  const [storesLoading, setStoresLoading] = useState(true)
  const [storesError, setStoresError] = useState("")
  const [storesReason, setStoresReason] = useState<unknown>()
  const [hasUnavailableStores, setHasUnavailableStores] = useState(false)
  const [rosterRetry, setRosterRetry] = useState(0)
  const [storeUid, setStoreUid] = useState("")
  const [tab, setTab] = useState<DelegateTab>("postings")
  const [sources, setSources] = useState<DelegateSource[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const storesRef = useRef(stores)
  storesRef.current = stores
  const storeUidRef = useRef(storeUid)
  storeUidRef.current = storeUid

  const bumpRefresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setStoresLoading(storesRef.current.length === 0)
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
        if (!peekStoreRoster(workspaceId) && storesRef.current.length === 0) {
          setStoreUid("")
        }
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, rosterRetry, workspaceId])

  useEffect(() => {
    if (!roster) return
    const configured = roster.overview.stores.flatMap((store) => {
      const uid = activeCloudStoreUid(store)
      return uid ? [{ storeUid: uid, name: store.label }] : []
    })
    setHasUnavailableStores(rosterHasUnavailableStores(roster.overview))
    setStores(configured)
    // 保持已选店；不在名册（换 Workspace / 店被停用）时落第一个可用店。
    const nextStoreUid = configured.some((store) => store.storeUid === storeUidRef.current)
      ? storeUidRef.current
      : (configured[0]?.storeUid ?? "")
    if (nextStoreUid !== storeUidRef.current) {
      setStoreUid(nextStoreUid)
    }
  }, [roster])

  // 可绑厂家是屏级候选：绑定编辑与补齐流共用。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    delegateHttp
      .sources()
      .then((list) => {
        if (!cancelled) setSources(list)
      })
      .catch((reason) => {
        if (!cancelled) notifyCommandError(reason, "无法读取可绑厂家")
      })
    return () => {
      cancelled = true
    }
  }, [active])

  const storeName = stores.find((store) => store.storeUid === storeUid)?.name ?? ""

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden scroll-pt-14">
      <Section
        className="min-h-0 flex-1 overflow-hidden"
        title="委托订单"
        action={
          stores.length > 0 ? (
            <PageToolbar
              primary={
                <Select
                  value={storeUid}
                  onValueChange={(next) => {
                    if (!next || next === storeUid) return
                    setStoreUid(next)
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-52" aria-label="当前店铺">
                    <SelectValue>
                      {storeName ? storeName : "选择已接入店铺"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {stores.map((store) => (
                      <SelectItem key={store.storeUid} value={store.storeUid}>
                        {store.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
              secondary={
                <Tabs
                  value={tab}
                  onValueChange={(next) => {
                    const parsed = TABS.find((item) => item.value === next)
                    if (!parsed || parsed.value === tab) return
                    setTab(parsed.value)
                  }}
                >
                  <TabsList aria-label="委托订单视图">
                    <TabsIndicator />
                    {TABS.map((item) => (
                      <TabsTrigger key={item.value} value={item.value}>
                        {item.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              }
            />
          ) : null
        }
      >
        <StoreGate
          loading={storesLoading}
          error={storesError}
          reason={storesReason}
          storeCount={stores.length}
          hasUnavailableStores={hasUnavailableStores}
          onRetry={() => setRosterRetry((value) => value + 1)}
          onOpenStores={onOpenStores}
          icon={<Package />}
        >
          {tab === "postings" ? (
            <DelegatePostingsView
              storeId={storeUid}
              sources={sources}
              refreshKey={refreshKey}
              onOrderCreated={bumpRefresh}
            />
          ) : null}
          {tab === "orders" ? (
            <DelegateOrdersView storeId={storeUid} refreshKey={refreshKey} />
          ) : null}
          {tab === "bindings" ? (
            <DelegateBindingsView
              storeId={storeUid}
              sources={sources}
              onChanged={bumpRefresh}
            />
          ) : null}
        </StoreGate>
      </Section>
    </div>
  )
}
