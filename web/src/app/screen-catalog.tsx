import { lazy, Suspense, useRef, type ReactNode } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { ScreenPane } from "@/components/screen-pane"
import { Spinner } from "@/components/ui/spinner"
import { isObservationScreen, type AppScreen } from "@/lib/app-screens"
import { isPlatformSuperAdminRole } from "@/lib/platform-role"
import { isAdminPath } from "@/lib/admin-surface"
import { useAddress } from "@/hooks/use-address"
import { ObservationScopeProvider, useObservationScope } from "@/features/platform-observation/observation-scope-provider"
import { useOpenSettings } from "@/app/settings-page"
import { SCREEN_LOADERS } from "@/app/screen-loaders"
import { listingHttp } from "@/bindings/http-listing"
import { invalidateListingCardList } from "@/features/workflow/listing-card-list-cache"
import { notifyCommandError, notifyInfo, notifySuccess } from "@/lib/notify"
import { replaceAddress } from "@/lib/address"
import { listabilitySkippedNotice } from "@/features/supply-chain/listability-copy"
import {
  listabilityOf,
  type CatalogListingIdentity,
} from "@/features/supply-chain/gallery/gallery-model"
import { removeQueued } from "@/features/supply-chain/gallery/listing-queue"
import { writeWorkflowCardId, withCatalogPick, withWorkflowCardId } from "@/features/workflow/workflow-navigation"

const HomeScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.home()).HomeScreen,
}))
const ConsoleScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.console()).ConsoleScreen,
}))
const AdminConsoleScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["admin-console"]()).AdminConsoleScreen,
}))
const AdminProductsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["admin-products"]()).AdminProductsScreen,
}))
const WorkflowScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.listing()).WorkflowScreen,
}))
const CatalogScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.catalog()).CatalogScreen,
}))
const ProductsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.products()).ProductsScreen,
}))
const TaskRecordsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["task-records"]()).TaskRecordsScreen,
}))
const SupplierDbsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["supplier-dbs"]()).SupplierDbsScreen,
}))
const CatalogManagerScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["supplier-catalog"]()).CatalogManagerScreen,
}))
const SupplierAccountsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["supplier-accounts"]()).SupplierAccountsScreen,
}))
const AdminDelegateOrdersScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["admin-delegate-orders"]())
    .AdminDelegateOrdersScreen,
}))
const MessageCenterScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["message-center"]()).MessageCenterScreen,
}))
const ShippingScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["ops-shipping"]()).ShippingScreen,
}))
const DelegateOrdersScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["delegate-orders"]()).DelegateOrdersScreen,
}))
const ReturnsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["ops-returns"]()).ReturnsScreen,
}))
const SupplyScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["ops-supply"]()).SupplyScreen,
}))
const VoiceScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["ops-voice"]()).VoiceScreen,
}))
const StoresScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.stores()).StoresScreen,
}))
const NotificationsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.notifications()).NotificationsScreen,
}))
const UsageScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.usage()).UsageScreen,
}))
const AgentCenterScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.agent()).AgentCenterScreen,
}))

/** 逐件创建或复用上架方案；失败商品留在清单，成功后才清理。 */
export async function importCatalogProducts(
  products: readonly CatalogListingIdentity[],
  options: {
    /** 页面/工作区还在原地吗？换屏后迟到的响应不许再写。 */
    isActive: () => boolean
    /** 创建成功后的本地清理（把这一件弹出清单）。 */
    onCreated?: (productId: string) => void
  },
): Promise<string[]> {
  // 兜底：身份上带着点击那刻的行事实——清单结算到逐件建卡之间行可能转为
  // 不可上架，入口按同一谓词再过滤一次；跳过的报数，服务端 409 仍是最终门。
  const listable = products.filter((product) => listabilityOf(product).listable)
  if (listable.length < products.length) {
    notifyInfo(listabilitySkippedNotice(products.length - listable.length))
  }
  const created: string[] = []
  for (const product of listable) {
    if (!options.isActive()) break
    let cardId: string
    try {
      cardId = (await listingHttp.listingCardCreateFromSupplier(product.productId)).id
    } catch (reason) {
      notifyCommandError(reason, `无法导入「${product.title}」，请稍后重试。`)
      continue
    }
    if (!options.isActive()) break
    created.push(cardId)
    options.onCreated?.(product.productId)
  }
  if (created.length > 0) invalidateListingCardList()
  return created
}

function ScreenFallback() {
  return (
    <div className="grid min-h-52 place-items-center">
      <Spinner aria-label="正在加载模块" />
    </div>
  )
}

function LazyPane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <ScreenPane active={active}>
      <Suspense fallback={<ScreenFallback />}>{children}</Suspense>
    </ScreenPane>
  )
}

type ScreenCatalogProps = {
  screen: AppScreen
  /** The live keep-alive panes, in visit order (the shell derives them). */
  visited: readonly AppScreen[]
  overview: AccountOverview
  onOverviewChange: (overview: AccountOverview) => void
  /** Kept for the shell's contract; no pane currently needs sign-out or a refresh. */
  onSignedOut: () => void
  onNavigate: (screen: AppScreen) => void
  onRefreshOverview: () => Promise<void>
}

export function ScreenCatalog({
  screen,
  visited,
  overview,
  onOverviewChange,
  onNavigate,
}: ScreenCatalogProps) {
  const address = useAddress()
  const canObserve = isAdminPath(address.pathname) && isPlatformSuperAdminRole(overview.session.role)
  // Defense in depth: no caller-supplied visited set can mount a forbidden pane.
  const allowed = visited.filter((id) => !isObservationScreen(id) || canObserve)
  return (
    <ObservationScopeProvider enabled={canObserve && allowed.some(isObservationScreen)}>
      {allowed.map((id) => (
        <ScreenEntry
          key={id}
          id={id}
          active={screen === id}
          overview={overview}
          onOverviewChange={onOverviewChange}
          onNavigate={onNavigate}
        />
      ))}
    </ObservationScopeProvider>
  )
}

function ScreenEntry({
  id,
  active,
  overview,
  onOverviewChange,
  onNavigate,
}: Omit<ScreenCatalogProps, "screen" | "visited" | "onSignedOut" | "onRefreshOverview"> & { id: AppScreen; active: boolean }) {
  const openSettings = useOpenSettings()
  const catalogImporting = useRef(false)
  const workspaceKey = overview.active_workspace?.id ?? "session"
  const { scopeKey } = useObservationScope()
  const catalogContext = useRef({ workspaceKey, active })
  if (catalogContext.current.workspaceKey !== workspaceKey || catalogContext.current.active !== active) {
    catalogContext.current = { workspaceKey, active }
  }
  let content: ReactNode = null
  switch (id) {
    case "home":
      content = <HomeScreen key={workspaceKey} overview={overview} onNavigate={onNavigate} onOpenListingCard={(cardId) => {
        replaceAddress({ search: withWorkflowCardId(window.location.search, cardId) })
        onNavigate("listing")
      }} />
      break
    case "console":
      content = <ConsoleScreen key={workspaceKey} workspaceId={overview.active_workspace?.id} onNavigate={onNavigate} />
      break
    case "admin-console":
      content = <AdminConsoleScreen key={scopeKey} onOpenProducts={() => onNavigate("admin-products")} />
      break
    case "admin-products":
      content = <AdminProductsScreen key={scopeKey} />
      break
    case "products":
      content = <ProductsScreen key={workspaceKey} workspaceId={overview.active_workspace?.id} onOpenStores={() => onNavigate("stores")} />
      break
    case "task-records":
      content = <TaskRecordsScreen key={workspaceKey} workspaceId={overview.active_workspace?.id}
        onOpenListingCard={(cardId) => {
          replaceAddress({ search: withWorkflowCardId(window.location.search, cardId) })
          onNavigate("listing")
        }} onOpenProducts={() => onNavigate("products")} />
      break
    case "listing":
      content = (
        <WorkflowScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
          onOpenCatalog={() => {
            // 「从商库添加」不是平跳：先把选品意图落进地址，再让壳层把 screen
            // 换成商库。同一次点击里的两次 replaceAddress 合成一次渲染，也不
            // 新增浏览器历史条目（见 docs/supplier-dbs.md §7.1）。
            replaceAddress({ search: withCatalogPick(window.location.search) })
            onNavigate("catalog")
          }}
        />
      )
      break
    case "catalog":
      content = (
        <CatalogScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
          /* 选品模式的回程：回列表。壳层顺手收掉 `?pick=1`。 */
          onExitPick={() => onNavigate("listing")}
          onOpenListing={async (products) => {
            if (catalogImporting.current || !products.length) return
            catalogImporting.current = true
            const importContext = catalogContext.current
            const stillHere = () =>
              catalogContext.current === importContext && catalogContext.current.active
            try {
              const created = await importCatalogProducts(products, {
                isActive: stillHere,
                onCreated: removeQueued,
              })
              if (!stillHere()) return
              if (created.length) {
                replaceAddress(writeWorkflowCardId(window.location.href))
                onNavigate("listing")
                notifySuccess(`已加入上架列表，已有商品自动复用（${created.length} 件）`)
              }
            } finally {
              catalogImporting.current = false
            }
          }}
        />
      )
      break
    case "supplier-catalog":
      content = <CatalogManagerScreen key={overview.session.uuid ?? workspaceKey} />
      break
    case "supplier-dbs":
      content = <SupplierDbsScreen key={workspaceKey} />
      break
    case "supplier-accounts":
      content = <SupplierAccountsScreen key={workspaceKey} overview={overview} />
      break
    case "admin-delegate-orders":
      content = <AdminDelegateOrdersScreen key={workspaceKey} />
      break
    case "message-center":
      content = (
        <MessageCenterScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "ops-shipping":
      content = (
        <ShippingScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "delegate-orders":
      content = (
        <DelegateOrdersScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "ops-returns":
      content = (
        <ReturnsScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "ops-supply":
      content = (
        <SupplyScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "ops-voice":
      content = (
        <VoiceScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onOpenStores={() => onNavigate("stores")}
        />
      )
      break
    case "stores":
      content = (
        <StoresScreen
          key={workspaceKey}
          overview={overview}
          onOpenAccount={openSettings}
        />
      )
      break
    case "notifications":
      content = <NotificationsScreen onNavigate={onNavigate} />
      break
    case "agent":
      content = <AgentCenterScreen />
      break
    case "usage":
      content = (
        <UsageScreen
          activeWorkspace={overview.active_workspace}
          onOverviewChange={onOverviewChange}
        />
      )
      break
    default:
      throw new Error(`Unknown screen: ${id satisfies never}`)
  }
  return <LazyPane active={active}>{content}</LazyPane>
}
