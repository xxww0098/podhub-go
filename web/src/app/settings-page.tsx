import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { ShieldAlert } from "lucide-react"

import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { Button } from "@/components/ui/button"
import {
  AccountProfileSection,
  DeviceStoragePanel,
} from "@/features/account/account-screen"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import {
  resolveSettingsPane,
  settingsRowsFor,
  type SettingsSection,
} from "@/lib/settings-sections"
import {
  loadAccountOverview,
  peekAccountOverview,
  useAccountOverview,
} from "@/features/account/account-overview-cache"
import { ChangelogPane } from "@/components/changelog-notes"
import { AppearanceRows, PaneLoading, SettingGroup } from "./settings-controls"
import { WorkspaceStoragePanel } from "@/features/workspace-storage/workspace-storage-panel"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"

/**
 * Lets any screen open the shell's settings page without a prop chain —
 * Store roster's "fix your credentials" path calls this the same way the
 * footer gear does. Outside the shell the context is a no-op.
 */
const SettingsOpenContext = createContext<(section?: SettingsSection) => void>(
  () => {},
)

export function useOpenSettings() {
  return useContext(SettingsOpenContext)
}

export const SettingsOpenProvider = SettingsOpenContext.Provider

const PlansScreen = lazy(async () => ({
  default: (await import("@/features/plans/plans-screen")).PlansScreen,
}))
const WorkspaceScreen = lazy(async () => ({
  default: (await import("@/features/workspace/workspace-screen")).WorkspaceScreen,
}))
const UsersScreen = lazy(async () => ({
  default: (await import("@/features/users/users-screen")).UsersScreen,
}))
const SupplierAccountsScreen = lazy(async () => ({
  default: (await import("@/features/supplier/admin-supplier-accounts-screen"))
    .SupplierAccountsScreen,
}))
const PlatformAiAccountsScreen = lazy(async () => ({
  default: (await import("@/features/platform/ai-accounts-screen")).PlatformAiAccountsScreen,
}))
const PlatformSellerRelayScreen = lazy(async () => ({
  default: (await import("@/features/platform/seller-relay"))
    .PlatformSellerRelayScreen,
}))
const PlatformPaymentScreen = lazy(async () => ({
  default: (await import("@/features/platform/payment-config"))
    .PlatformPaymentScreen,
}))
const PlatformBannedTagsScreen = lazy(async () => ({
  default: (await import("@/features/platform/banned-tags-screen"))
    .PlatformBannedTagsScreen,
}))
const PlatformCategoryFetchScreen = lazy(async () => ({
  default: (await import("@/features/platform/category-fetch")).PlatformCategoryFetchScreen,
}))
const RedeemCodesScreen = lazy(async () => ({
  default: (await import("@/features/redeem-codes/redeem-codes-screen"))
    .RedeemCodesScreen,
}))
const AgentsScreen = lazy(async () => ({
  default: (await import("@/features/agents/agents-screen")).AgentsScreen,
}))
const AdminLogsScreen = lazy(async () => ({
  default: (await import("@/features/platform/logs")).AdminLogsScreen,
}))
const OrdersScreen = lazy(async () => ({
  default: (await import("@/features/orders/orders-screen")).OrdersScreen,
}))
const McpGrantPanel = lazy(async () => ({
  default: (await import("@/features/automation/mcp-grant-panel")).McpGrantPanel,
}))

/**
 * Settings content occupies the shell's main area; its navigation lives in
 * the shell sidebar. Small editing actions keep their own dialogs.
 */
export function SettingsPage({
  onBack,
  overview: overviewProp,
  onOverviewChange,
  onSignedOut,
  section,
  adminSurface = false,
}: {
  onBack: () => void
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
  onSignedOut?: () => void
  /** The centre floats over the shell; absent, fall back to its screen. */
  section: SettingsSection
  /** The `/admin` surface: a URL may name a pane this session may not open. */
  adminSurface?: boolean
}) {
  const liveOverview = useAccountOverview()
  const overview = liveOverview ?? overviewProp
  const available = settingsRowsFor(overview?.session.role)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshOverview = useCallback(async (force = true) => {
    const next = await loadAccountOverview({ force })
    if (!next) return
    if (!next.session.authenticated) {
      onBack()
      onSignedOut?.()
      return
    }
    const current = peekAccountOverview()
    if (current) onOverviewChange?.(current)
  }, [onBack, onSignedOut, onOverviewChange])

  // Refresh standing when settings mounts; a dead session signs out instead
  // of painting stale identity.
  useEffect(() => {
    void refreshOverview(false).catch(() => {})
  }, [refreshOverview])

  // A refused pane keeps the rail but highlights nothing and matches no pane
  // branch: the sections a URL may name but this session may not open are
  // exactly the ones that must not mount.
  const resolution = resolveSettingsPane({
    requested: section,
    available,
    adminSurface,
  })
  const refused = resolution.kind === "refused"
  const pane: SettingsSection | "" = refused ? "" : resolution.section
  const active = available.find((item) => item.id === pane) ?? available[0]
  const fullPane = pane === "users" || pane === "supplier-accounts"
  // Detail panes are a form, not a ledger: they hold one reading column with
  // side margins. Rosters and admin tables (`wide`) keep the full canvas.
  const measure = active.wide ? undefined : "mx-auto w-full max-w-4xl"

  return (
    <>
      <div
        data-settings-page
        aria-label="设置内容"
        key={pane}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain outline-none",
          fullPane && "overflow-hidden",
        )}
      >
        {refused ? <p role="status" className={cn("px-3 pt-3 text-sm", measure)}>没有权限打开该设置</p> : <h2 className="sr-only">{active.title}</h2>}
        <div
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col",
            fullPane ? "overflow-hidden" : active.wide ? "p-3" : "p-3 sm:p-4",
            measure,
          )}
        >
          {refused ? (
            /* Refusal is a state, not a failed operation: an icon and the
               way out, while the copy stays in the header. No
               `role="alert"` and no raw error text enter this pane. */
            <Empty role="status" className="min-h-32">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldAlert />
                </EmptyMedia>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onBack}
                >
                  返回上一页
                </Button>
              </EmptyContent>
            </Empty>
          ) : null}
          {pane === "account" ? (
            <div className="flex flex-col gap-3">
              <AccountProfileSection
                overview={overview}
                onOverviewChange={onOverviewChange}
              />
              <SettingGroup>
                <div className="flex flex-wrap items-center gap-x-7 gap-y-3 p-4 sm:p-6">
                  <div className="min-w-0 flex-1 basis-40 sm:basis-56">
                    <h3 className="text-[1.25rem] font-semibold">登录密码</h3>
                    <p className="mt-1 text-[0.9375rem] text-muted-foreground">修改后其他设备上的登录会失效</p>
                  </div>
                  <Button variant="outline" className="h-11 px-5 text-base" disabled={busy} onClick={() => setPasswordOpen(true)}>
                    修改密码
                  </Button>
                </div>
              </SettingGroup>
            </div>
          ) : null}
          {pane === "appearance" ? <AppearanceRows /> : null}
          {pane === "storage" ? <DeviceStoragePanel /> : null}
          {pane === "workspace-storage" ? <WorkspaceStoragePanel key={overview?.active_workspace?.id} /> : null}
          {pane === "changelog" ? <ChangelogPane /> : null}
          {pane === "mcp" ? (
            <Suspense fallback={<PaneLoading label="MCP 授权" />}>
              <McpGrantPanel key={`${overview?.session.email}:${overview?.session.role}:${overview?.active_workspace?.id}:${overview?.active_workspace?.role}`} overview={overview} />
            </Suspense>
          ) : null}
          {pane === "workspace" ? (
            <Suspense fallback={<PaneLoading label="团队协作区" />}>
              <WorkspaceScreen
                overview={overview}
                onOverviewChange={onOverviewChange}
              />
            </Suspense>
          ) : null}
          {pane === "plans" ? (
            <Suspense fallback={<PaneLoading label="升级方案" />}>
              <PlansScreen
                overview={overview}
                onOverviewChange={onOverviewChange}
              />
            </Suspense>
          ) : null}
          {pane === "users" ? (
            <Suspense fallback={<PaneLoading label="用户" />}>
              <UsersScreen
                actorRole={overview?.session.role}
                onSessionMayChange={refreshOverview}
              />
            </Suspense>
          ) : null}
          {pane === "supplier-accounts" && overview ? (
            <Suspense fallback={<PaneLoading label="工厂管理" />}>
              <SupplierAccountsScreen key={`${overview.session.uuid ?? overview.session.email}:${overview.session.role}:${overview.active_workspace?.id ?? ""}`} overview={overview} embedded />
            </Suspense>
          ) : null}
          {pane === "ai-accounts" ? (
            <Suspense fallback={<PaneLoading label="AI 账号" />}>
              <PlatformAiAccountsScreen />
            </Suspense>
          ) : null}
          {pane === "payment" ? (
            <Suspense fallback={<PaneLoading label="支付" />}>
              <PlatformPaymentScreen />
            </Suspense>
          ) : null}
          {pane === "proxy" ? (
            <Suspense fallback={<PaneLoading label="网络代理" />}>
              <PlatformSellerRelayScreen />
            </Suspense>
          ) : null}
          {pane === "categories" ? (
            <Suspense fallback={<PaneLoading label="类目抓取" />}>
              <PlatformCategoryFetchScreen />
            </Suspense>
          ) : null}
          {pane === "banned-tags" ? (
            <Suspense fallback={<PaneLoading label="全局受限标签" />}>
              <PlatformBannedTagsScreen />
            </Suspense>
          ) : null}
          {pane === "redeem-codes" ? (
            <Suspense fallback={<PaneLoading label="兑换" />}>
              <RedeemCodesScreen />
            </Suspense>
          ) : null}
          {pane === "agents" ? (
            <Suspense fallback={<PaneLoading label="代理" />}>
              <AgentsScreen />
            </Suspense>
          ) : null}
          {pane === "admin-logs" ? (
            <Suspense fallback={<PaneLoading label="日志" />}>
              <AdminLogsScreen />
            </Suspense>
          ) : null}
          {pane === "plan-orders" ? (
            <Suspense fallback={<PaneLoading label="订单" />}>
              <OrdersScreen onSessionMayChange={refreshOverview} />
            </Suspense>
          ) : null}
        </div>
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        busy={busy}
        onOpenChange={setPasswordOpen}
        onSubmit={async (currentPassword, newPassword) => {
          setBusy(true)
          try {
            await accountHttp.accountChangePassword({
              current_password: currentPassword,
              new_password: newPassword,
            })
            setPasswordOpen(false)
            notifySuccess("密码已更新", {
              description: "其他设备上的登录已失效。",
            })
          } catch (reason) {
            notifyCommandError(reason, "无法修改密码，请稍后重试。")
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}
