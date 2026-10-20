import { lazy, Suspense, useRef, type ReactNode } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { ScreenPane } from "@/components/screen-pane"
import { Spinner } from "@/components/ui/spinner"
import { isObservationScreen, type AppScreen } from "@/lib/app-screens"
import { isPlatformSuperAdminRole } from "@/lib/platform-role"
import { isAdminPath } from "@/lib/admin-surface"
import { useAddress } from "@/hooks/use-address"
import { ObservationScopeProvider, useObservationScope } from "@/features/platform-observation/observation-scope-provider"
import { useOpenSettings } from "@/app/settings-dialog"
import { SCREEN_LOADERS } from "@/app/screen-loaders"
import { listingHttp } from "@/bindings/http-listing"
import { listingCardSavePsd, listingCardSaveStore } from "@/features/workflow/card/card-writes"
import { invalidateListingCardList } from "@/features/workflow/listing-card-list-cache"
import { notifyCommandError, notifyInfo, notifySuccess } from "@/lib/notify"
import { replaceAddress } from "@/lib/address"
import { listabilitySkippedNotice } from "@/features/supply-chain/listability-copy"
import {
  listabilityOf,
  type CatalogListingIdentity,
} from "@/features/supply-chain/gallery/gallery-model"
import {
  queueEntryById,
  removeQueued,
  type ListingQueueEntry,
} from "@/features/supply-chain/gallery/listing-queue"
import { writeWorkflowCardId, withCatalogPick } from "@/features/workflow/workflow-navigation"

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
const SupplierDbsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS["supplier-dbs"]()).SupplierDbsScreen,
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
const ProductsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.products()).ProductsScreen,
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

/**
 * 商库 → 上架方案的导入：逐件创建卡片，并把清单里为这件商品攒下的店铺/PSD
 * 绑定落到新卡上。
 *
 * 单件失败只提示一次、不打断其余商品；绑定的两笔写是「尽力而为」——卡已经
 * 建好，绑定失败不该把整件商品判成没导入。返回成功创建的 cardId，调用方据此
 * 决定要不要导航。
 */
export async function importCatalogProducts(
  products: readonly CatalogListingIdentity[],
  options: {
    /** 页面/工作区还在原地吗？换屏后迟到的响应不许再写。 */
    isActive: () => boolean
    /** 创建成功后的本地清理（把这一件弹出清单）。 */
    onCreated?: (productId: string) => void
    /** 绑定查询缝（测试注入）；缺省读模块清单。 */
    entryById?: (productId: string) => ListingQueueEntry | undefined
  },
): Promise<string[]> {
  const entryById = options.entryById ?? queueEntryById
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
    // 绑定先查下来再清理：onCreated 会把这一件弹出清单（removeQueued），
    // 弹完就查不到刚攒下的店铺/PSD 了。
    const entry = entryById(product.productId)
    options.onCreated?.(product.productId)
    await applyQueuedCardBindings(cardId, entry)
  }
  if (created.length > 0) invalidateListingCardList()
  return created
}

/**
 * 刚建好的卡按清单条目落绑定：先店铺、后 PSD。两笔都是读改写同一份 payload
 * （各自取卡片 revision 做 CAS），所以必须串行——并行会让后一笔踩前一笔的版本。
 */
async function applyQueuedCardBindings(
  cardId: string,
  entry: ListingQueueEntry | undefined,
): Promise<void> {
  if (!entry) return
  if (entry.storeId) {
    try {
      await listingCardSaveStore(cardId, entry.storeId)
    } catch (reason) {
      notifyCommandError(reason, "已加入上架列表，但目标店铺没有绑上，请在上架列表重新绑定。")
    }
  }
  if (entry.psd) {
    try {
      await listingCardSavePsd(cardId, entry.psd.sha256, entry.psd.fileName)
    } catch (reason) {
      notifyCommandError(reason, "已加入上架列表，但 PSD 模板没有绑上，请在上架列表重新绑定。")
    }
  }
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
    case "console":
      content = (
        <ConsoleScreen
          key={workspaceKey}
          workspaceId={overview.active_workspace?.id}
          onNavigate={onNavigate}
        />
      )
      break

    case "admin-console":
      content = <AdminConsoleScreen key={scopeKey} onOpenProducts={() => onNavigate("admin-products")} />
      break
    case "admin-products":
      content = <AdminProductsScreen key={scopeKey} />
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
          onOpenListing={(products) => {
            if (catalogImporting.current || !products.length) return
            catalogImporting.current = true
            const importContext = catalogContext.current
            const stillHere = () =>
              catalogContext.current === importContext && catalogContext.current.active
            void (async () => {
              try {
                const created = await importCatalogProducts(products, {
                  isActive: stillHere,
                  onCreated: removeQueued,
                })
                if (!stillHere()) return
                // 新引用默认不绑店铺；清单里绑过的店铺/PSD 已在上一步落到卡上。
                // 重复加入由服务端复用，不复制商品配置。
                if (created.length) {
                  replaceAddress(writeWorkflowCardId(window.location.href))
                  onNavigate("listing")
                  notifySuccess(`已加入上架列表，已有商品自动复用（${created.length} 件）`)
                }
              } finally {
                catalogImporting.current = false
              }
            })()
          }}
        />
      )
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
    case "products":
      content = (
        <ProductsScreen
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
