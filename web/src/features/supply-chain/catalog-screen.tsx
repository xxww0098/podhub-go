/**
 * 平台货源 — 卖家/工作区画廊屏（docs/supplier-dbs.md §6/§7）：
 * GET /api/supplier-dbs/catalog 的只读卡墙 + 上架导航/独立物流注入。管理端的
 * 「列表管理」是独立主菜单屏（`supplier-dbs`，SupplierDbsScreen），
 * 不在本屏内。
 *
 * Not 发货 (`ops-shipping`), not 供货 (`ops-supply`).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { Boxes, ListChecks, PackageOpen, Store, Unplug } from "lucide-react"

import type { CategoryTreeNodeView, OzonStoreView } from "@/bindings/commands"
import {
  supplyChainHttp,
  type SellerPlatformProduct,
  type SellerShippingReadiness,
} from "@/bindings/http-supply-chain"
import {
  supplierDbsCatalogHttp,
  type SellerSupplierDbCatalogData,
  type SellerSupplierDbRowData,
} from "@/bindings/http-supplier-dbs-catalog"
import { loadCategoryTree as loadSharedCategoryTree } from "@/features/category-schema/category-tree-load"
import { useTrailSegment } from "@/app/app-shell"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { CatalogSkeleton } from "./catalog-skeleton"
import {
  readCategoryTreeCache,
  writeCategoryTreeCache,
} from "@/features/category-schema/category-tree-cache"
import {
  cloudConfiguredStores,
  loadStoreRoster,
  peekStoreRoster,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import { addressOf, currentHref, subscribeAddress } from "@/lib/address"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyLive } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { readCatalogPick } from "@/features/workflow/workflow-navigation"

import {
  readGalleryFiltersFromUrl,
  writeGalleryProductToUrl,
  writeGalleryFiltersToUrl,
  type CatalogListingIdentity,
  type GalleryFilters,
} from "./gallery/gallery-model"
import { SupplierDbsGallery } from "./gallery/supplier-dbs-gallery"
import { ShippingInjectPanel } from "./shipping-inject-panel"
import { presentSellerInject } from "./shipping-inject-copy"

export const INJECT_POLL_MS = 4_000

const CATALOG_READ_LIVE = "catalog-read"

export type CatalogHttp = {
  listSupplierDbCatalog: () => Promise<SellerSupplierDbCatalogData>
  /** Per-SKU product detail used only by the independent logistics action. */
  getPlatformProduct: (productId: string) => Promise<SellerPlatformProduct>
  getShippingReadiness: (
    storeUuid: string,
    skuId: string,
  ) => Promise<SellerShippingReadiness>
  ensureShipping: (
    storeUuid: string,
    skuId: string,
  ) => Promise<SellerShippingReadiness>
  /** 类目 facet labels resolve through the Seller category tree. */
  loadCategoryTree: () => Promise<CategoryTreeNodeView[]>
}

let catalogListFlight: {
  load: CatalogHttp["listSupplierDbCatalog"]
  promise: Promise<SellerSupplierDbCatalogData>
} | null = null

/** StrictMode remounts the effect; both readers share the GET already in flight. */
export function loadCatalogOnce(
  load: CatalogHttp["listSupplierDbCatalog"],
): Promise<SellerSupplierDbCatalogData> {
  if (catalogListFlight?.load === load) return catalogListFlight.promise
  const promise = load().finally(() => {
    if (catalogListFlight?.promise === promise) catalogListFlight = null
  })
  catalogListFlight = { load, promise }
  return promise
}

const defaultCatalogHttp: CatalogHttp = {
  listSupplierDbCatalog: supplierDbsCatalogHttp.listSupplierDbCatalog,
  getPlatformProduct: supplierDbsCatalogHttp.getPlatformProduct,
  getShippingReadiness: supplyChainHttp.getShippingReadiness,
  ensureShipping: supplyChainHttp.ensureShipping,
  loadCategoryTree: () => loadSharedCategoryTree(),
}

export type CatalogScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
  /** 单件与上架清单批量导入共用同一交接：最小商品身份数组。 */
  onOpenListing: (products: CatalogListingIdentity[]) => void
  /**
   * 选品模式的回程：回「批量上架」列表。壳层跳转时顺手收掉 `?pick=1`，
   * 所以这里只说「回哪儿」（见 `workflow-navigation.ts`）。
   */
  onExitPick?: () => void
  http?: CatalogHttp
  stores?: OzonStoreView[]
  /** 测试缝：不传时读地址（`?pick=1`）——选品模式只有一个事实源。 */
  picking?: boolean
}

export type { CatalogListingIdentity }
export { catalogListingIdentity } from "./gallery/gallery-model"

/**
 * 选品模式条：从「批量上架」进来的人在这里看到自己在干什么、以及怎么回去。
 * 屏级提示而不是错误面——不抢 role="alert"，也不挡工具行。
 */
function CatalogPickingBar({ onExit }: { onExit?: () => void }) {
  return (
    <div
      data-catalog-picking=""
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand/25 bg-brand-soft px-3 py-2"
    >
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
        <ListChecks className="size-3.5" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-compact text-brand-ink">
        选品模式：把商品加进「上架清单」，再一次批量导入。
      </p>
      {onExit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="cursor-pointer"
          onClick={onExit}
        >
          返回批量上架
        </Button>
      ) : null}
    </div>
  )
}

function preferredStoreId(
  stores: OzonStoreView[],
  activeId?: string | null,
): string {
  if (activeId && stores.some((store) => store.id === activeId)) return activeId
  return stores[0]?.id ?? ""
}

/** 屏级空态/失败态的同一副骨架：图标 + 标题 + 说明；动作与 data 域由调用方给。 */
function CatalogStatusEmpty({
  icon,
  title,
  body,
  kind,
  children,
}: {
  icon: ReactNode
  title: string
  body: string
  kind?: string
  children?: ReactNode
}) {
  return (
    <Empty role="status" className="min-h-64" data-gallery-empty={kind}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  )
}

export function CatalogScreen({
  workspaceId,
  onOpenStores,
  onOpenListing,
  onExitPick,
  http = defaultCatalogHttp,
  stores: storesProp,
  picking: pickingProp,
}: CatalogScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const configured = useMemo(() => {
    if (storesProp) return storesProp
    return roster ? cloudConfiguredStores(roster.overview) : []
  }, [storesProp, roster])
  const [storeId, setStoreId] = useState("")
  const [catalog, setCatalog] = useState<SellerSupplierDbCatalogData>()
  // Filter state is URL-shareable: ?db=&cat=&pmin=&pmax=&q=&tags= survives refresh
  // and a copied link. Sort/density are view preferences and stay local.
  const [filters, setFilters] = useState<GalleryFilters>(() =>
    readGalleryFiltersFromUrl(),
  )
  const [categoryTree, setCategoryTree] = useState<CategoryTreeNodeView[]>(
    () => readCategoryTreeCache() ?? [],
  )
  const [shippingProduct, setShippingProduct] = useState<SellerPlatformProduct>()
  // 卡墙点开的行详情页：记 productId 而不是行对象——刷新后跟着新载荷走，
  // 行没了（下架/删行）就自动收回画廊，详情页不悬在旧数据上。
  const href = useSyncExternalStore(subscribeAddress, currentHref, () => "/")
  const search = addressOf(href).search
  const selectedId = new URLSearchParams(search).get("product") ?? undefined
  // 「从商库添加」落在选品模式：屏上给一条模式条，画廊把清单浮窗开局就摊开。
  const picking = pickingProp ?? readCatalogPick(search)
  const setSelectedId = writeGalleryProductToUrl
  const selected = catalog?.rows.find((row) => row.productId === selectedId)
  // 物流响应只在该行详情还开着时落地——回画廊/换行后迟到的响应不得顶掉当前视图。
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [loadFailed, setLoadFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [readiness, setReadiness] = useState<Record<string, SellerShippingReadiness>>(
    {},
  )
  const [busySku, setBusySku] = useState<string>()

  useEffect(() => {
    if (storesProp) return
    if (peekStoreRoster(workspaceId)) return
    void loadStoreRoster({ workspaceId }).catch(() => {})
  }, [storesProp, workspaceId])

  useEffect(() => {
    setStoreId((current) => {
      if (current && configured.some((store) => store.id === current)) return current
      return preferredStoreId(configured, roster?.overview.active_id)
    })
  }, [configured, roster?.overview.active_id])

  // Filters ⇄ querystring: the shell owns ?screen=, the gallery owns its keys.
  useEffect(() => {
    writeGalleryFiltersToUrl(filters)
  }, [filters])

  // 详情页/物流页打开着的行在最新载荷里消失时，收回打开态。
  useEffect(() => {
    if (
      selectedId &&
      catalog &&
      !catalog.rows.some((row) => row.productId === selectedId)
    ) {
      setSelectedId(undefined)
    }
  }, [selectedId, catalog])

  useEffect(() => {
    setShippingProduct(undefined)
  }, [selectedId])

  const selectedStore = configured.find((store) => store.id === storeId)
  const back = useCallback(() => setShippingProduct(undefined), [])
  // 面包屑模块段 = 回模块根（画廊），所以两级 drill 一起收；物流页的页内返回钮
  // 才逐层弹回详情（详情页没有页内返回钮）。
  const exitDrill = useCallback(() => {
    setShippingProduct(undefined)
    setSelectedId(undefined)
  }, [])
  // 详情/物流页的回程交给壳层面包屑：只挂商品名，模块段点击回画廊。
  useTrailSegment(shippingProduct?.title ?? selected?.title, exitDrill)

  const loadCatalog = useCallback(async () => {
    setLoading(true)
    try {
      const next = await loadCatalogOnce(http.listSupplierDbCatalog)
      setCatalog(next)
      setLoadFailed(false)
      clearLive(CATALOG_READ_LIVE)
    } catch (reason) {
      setLoadFailed(true)
      notifyLive({
        id: CATALOG_READ_LIVE,
        type: "error",
        reason,
        title: "读不到平台货源",
        description: errorMessage(reason, "请稍后重试。"),
        action: { label: "重试", onClick: () => void loadCatalog() },
      })
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    if (!active) return
    void loadCatalog()
  }, [active, loadCatalog])

  // The tree only answers facet labels — best-effort, never a screen blocker.
  useEffect(() => {
    if (!active || categoryTree.length > 0) return
    let cancelled = false
    void http
      .loadCategoryTree()
      .then((tree) => {
        if (cancelled || tree.length === 0) return
        setCategoryTree(tree)
        writeCategoryTreeCache(tree)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [active, categoryTree.length, http])

  useEffect(() => () => clearLive(CATALOG_READ_LIVE), [])

  /** Logistics is a separate capability; the SKU detail arrives only on demand. */
  const openShipping = useCallback(
    async (row: SellerSupplierDbRowData) => {
      try {
        const product = await http.getPlatformProduct(row.productId)
        if (selectedIdRef.current !== row.productId) return
        setReadiness({})
        setShippingProduct(product)
      } catch (reason) {
        notifyCommandError(reason, "读不到货品详情，无法打开物流注入")
      }
    },
    [http],
  )

  const loadReadiness = useCallback(async () => {
    if (!storeId || !shippingProduct) return
    try {
      const entries = await Promise.all(
        shippingProduct.skus.map(async (sku) => {
          const row = await http.getShippingReadiness(storeId, sku.sku_id)
          return [sku.sku_id, row] as const
        }),
      )
      setReadiness(Object.fromEntries(entries))
    } catch (reason) {
      notifyCommandError(reason, "读不到店铺物流配置")
    }
  }, [http, shippingProduct, storeId])

  useEffect(() => {
    void loadReadiness()
  }, [loadReadiness])

  const waiting = useMemo(
    () =>
      Object.values(readiness).some(
        (row) => presentSellerInject(row).kind === "waiting",
      ),
    [readiness],
  )

  useVisiblePolling({
    enabled: Boolean(active && shippingProduct && storeId && waiting),
    intervalMs: INJECT_POLL_MS,
    restartKey: `${storeId}:${shippingProduct?.product_id ?? ""}`,
    onPoll: (trigger) => {
      if (trigger === "mount") return
      void loadReadiness()
    },
  })

  async function ensureSku(skuId: string) {
    if (!storeId) return
    setBusySku(skuId)
    try {
      const row = await http.ensureShipping(storeId, skuId)
      setReadiness((current) => ({ ...current, [skuId]: row }))
    } catch (reason) {
      notifyCommandError(reason, "无法写入店铺物流配置")
    } finally {
      setBusySku(undefined)
    }
  }

  const storePicker =
    configured.length > 0 ? (
      <Select
        value={storeId}
        onValueChange={(next) => {
          if (!next || next === storeId) return
          setStoreId(next)
        }}
      >
        <SelectTrigger size="sm" aria-label="目标店铺" className="w-56 cursor-pointer">
          <SelectValue placeholder="选择目标店铺">
            {(value) => configured.find((store) => store.id === value)?.label ?? "选择目标店铺"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {configured.map((store) => (
            <SelectItem key={store.id} value={store.id} className="cursor-pointer">
              {store.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="cursor-pointer"
        onClick={onOpenStores}
      >
        <Store />
        先配置店铺
      </Button>
    )

  return (
    <div
      data-catalog-screen=""
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden scroll-pt-14"
    >
      {/* 选品模式（`?pick=1`）：模式条常驻所有分支（加载/空态/详情/画廊），
          不挡住工具行。 */}
      {picking ? <CatalogPickingBar onExit={onExitPick} /> : null}
      {/* 卖家视图就是画廊本体（参考图 1）：工具行在画廊里，屏内不放返回键。 */}
      {loadFailed ? (
        <CatalogStatusEmpty
          kind="error"
          icon={<Unplug />}
          title="读不到平台货源"
          body="稍后重试。货盘只列出已上架的货品。"
        >
          <EmptyContent>
            <Button type="button" size="sm" className="cursor-pointer" onClick={() => void loadCatalog()}>
              重试
            </Button>
          </EmptyContent>
        </CatalogStatusEmpty>
      ) : loading && !catalog ? (
        <CatalogSkeleton />
      ) : shippingProduct ? (
        <ProductShopView
          product={shippingProduct}
          shopName={selectedStore?.label ?? ""}
          storeId={storeId}
          readiness={readiness}
          busySku={busySku}
          onEnsure={ensureSku}
          storePicker={storePicker}
          backLabel={selected ? "← 返回详情" : "← 返回货架"}
          onBack={back}
        />
      ) : catalog ? (
        <SupplierDbsGallery
          catalog={catalog}
          filters={filters}
          onFiltersChange={setFilters}
          categoryTree={categoryTree}
          detail={selected}
          onOpenDetail={(row) => setSelectedId(row.productId)}
          picking={picking}
          /* 清单行的店铺/PSD 绑定：店铺列表与「去店铺页添加」的出口都从屏上透传，
             画廊不自己读 roster、也不自己找路。 */
          stores={configured}
          onOpenStores={onOpenStores}
          onOpenListing={onOpenListing}
          onOpenShipping={(row) => void openShipping(row)}
          refreshing={loading}
          onRefresh={() => {
            void loadCatalog()
            void loadReadiness()
          }}
        />
      ) : (
        <CatalogStatusEmpty
          kind="empty"
          icon={<PackageOpen />}
          title="平台货源还没有上架货品"
          body="货品上架后会出现在这里。"
        />
      )}
    </div>
  )
}

/**
 * The product-first logistics view: a back link, the target-store picker (kept
 * out of the gallery toolbar), then per-SKU
 * 店铺注入 on the picked store.
 */
function ProductShopView({
  product,
  shopName,
  storeId,
  readiness,
  busySku,
  onEnsure,
  storePicker,
  backLabel,
  onBack,
}: {
  product: SellerPlatformProduct
  shopName: string
  storeId: string
  readiness: Record<string, SellerShippingReadiness>
  busySku?: string
  onEnsure: (skuId: string) => void
  storePicker: ReactNode
  /** 物流页由详情页进入时返回上一级（详情）；否则直接回画廊。 */
  backLabel: string
  onBack: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="cursor-pointer"
          onClick={onBack}
        >
          {backLabel}
        </Button>
        <span className="text-sm font-medium text-foreground">目标店铺</span>
        {storePicker}
      </div>
      {!storeId ? (
        <CatalogStatusEmpty
          icon={<Boxes />}
          title="选择目标店铺"
          body="物流配置写在你选中的店铺上。"
        />
      ) : (
        product.skus.map((sku) => {
          const row = readiness[sku.sku_id]
          return (
            <div key={sku.sku_id} className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">{sku.title}</p>
              {row ? (
                <ShippingInjectPanel
                  readiness={row}
                  shopName={shopName}
                  busy={busySku === sku.sku_id}
                  onEnsure={() => onEnsure(sku.sku_id)}
                />
              ) : (
                <div className="grid min-h-24 place-items-center">
                  <Spinner aria-label="正在读取物流配置" />
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
