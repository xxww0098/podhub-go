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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Package } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

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
  const [tab, setTab] = useState<DelegateTab>("orders")
  const tabListRef = useRef<HTMLDivElement>(null)
  const restoreTabFocus = useRef(false)
  const [sources, setSources] = useState<DelegateSource[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const storesRef = useRef(stores)
  storesRef.current = stores
  const storeUidRef = useRef(storeUid)
  storeUidRef.current = storeUid

  const bumpRefresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  useLayoutEffect(() => {
    if (!restoreTabFocus.current) return
    restoreTabFocus.current = false
    tabListRef.current?.querySelector<HTMLElement>('[role="tab"][data-active]')?.focus({ preventScroll: true })
  }, [tab])

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

  if (!workspaceId) {
    return (
      <div className="flex min-h-80 w-full flex-col items-center justify-center rounded-xl border border-border bg-card p-8 text-center sm:p-12">
        <Empty role="status" className="min-h-0 border-0 bg-transparent p-0">
          <EmptyHeader className="max-w-md">
            <EmptyMedia variant="icon">
              <Package className="size-6 text-primary" />
            </EmptyMedia>
            <EmptyTitle>尚未选择工作空间</EmptyTitle>
            <EmptyDescription>
              委托订单与采购发货基于工作空间管理。请先在左侧栏选择或创建工作空间以处理订单。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const scopeControls = (
    <Select
      value={storeUid}
      onValueChange={(next) => {
        if (!next || next === storeUid) return
        setStoreUid(next)
      }}
    >
      <SelectTrigger size="sm" className="w-36 sm:w-52" aria-label="当前店铺" title={storeName || undefined}>
        <StoreIcon aria-hidden className="size-4 text-muted-foreground" />
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
  )
  const viewTabs = (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        const parsed = TABS.find((item) => item.value === next)
        if (!parsed || parsed.value === tab) return
        restoreTabFocus.current = tabListRef.current?.contains(document.activeElement) ?? false
        setTab(parsed.value)
      }}
    >
      <div className="rounded-lg border border-border bg-card px-3">
        <TabsList ref={tabListRef} variant="line" aria-label="委托订单视图">
          <TabsIndicator variant="line" />
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value} variant="line">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  )

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden scroll-pt-14">
      <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <h1 className="sr-only">委托订单</h1>
        {storesLoading && stores.length > 0 ? (
          <><PageToolbar secondary={scopeControls} />{viewTabs}</>
        ) : null}
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
              scopeControls={scopeControls}
              viewTabs={viewTabs}
              storeId={storeUid}
              sources={sources}
              refreshKey={refreshKey}
              onOrderCreated={bumpRefresh}
            />
          ) : null}
          {tab === "orders" ? (
            <DelegateOrdersView key={storeUid} storeId={storeUid} refreshKey={refreshKey} scopeControls={scopeControls} viewTabs={viewTabs} />
          ) : null}
          {tab === "bindings" ? (
            <DelegateBindingsView
              scopeControls={scopeControls}
              viewTabs={viewTabs}
              storeId={storeUid}
              sources={sources}
              onChanged={bumpRefresh}
            />
          ) : null}
        </StoreGate>
      </section>
    </div>
  )
}
