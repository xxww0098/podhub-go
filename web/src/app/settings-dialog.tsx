import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { Bell, KeyRound, ShieldAlert } from "lucide-react"

import type { AccountOverview } from "@/bindings/commands"
import type { AppScreen } from "@/lib/app-screens"
import { accountHttp } from "@/bindings/http-account"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
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
  useAccountOverview,
} from "@/features/account/account-overview-cache"
import { AppearanceRows, PaneLoading, SettingRow } from "./settings-controls"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { SettingsNavigation } from "./settings-navigation"

/**
 * Lets any screen open the shell's settings dialog without a prop chain —
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
const PlatformOcrScreen = lazy(async () => ({
  default: (await import("@/features/platform/ocr-screen")).PlatformOcrScreen,
}))
const PlatformAiAccountsScreen = lazy(async () => ({
  default: (await import("@/features/platform/ai-accounts-screen")).PlatformAiAccountsScreen,
}))
const PlatformMediaScreen = lazy(async () => ({
  default: (await import("@/features/platform/media-screen")).PlatformMediaScreen,
}))
const PlatformSellerRelayScreen = lazy(async () => ({
  default: (await import("@/features/platform/seller-relay"))
    .PlatformSellerRelayScreen,
}))
const PlatformPaymentScreen = lazy(async () => ({
  default: (await import("@/features/platform/payment-config"))
    .PlatformPaymentScreen,
}))
const PlatformPromptsScreen = lazy(async () => ({
  default: (await import("@/features/platform/prompts"))
    .PlatformPromptsScreen,
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
 * Settings as a floating window — Notion's two-pane settings sheet: a grouped
 * rail on the left, one pane at a time on the right. The 设置 entries in the
 * workspace menu and the footer gear both land here; nothing here is a screen.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  overview: overviewProp,
  onOverviewChange,
  onSignedOut,
  onNavigate,
  onOpenNotifications,
  section,
  onSectionChange,
  adminSurface = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
  onSignedOut?: () => void
  onNavigate?: (screen: AppScreen) => void
  /** The centre floats over the shell; absent, fall back to its screen. */
  onOpenNotifications?: () => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  /** The `/admin` surface: a URL may name a pane this session may not open. */
  adminSurface?: boolean
}) {
  const liveOverview = useAccountOverview()
  const overview = liveOverview ?? overviewProp
  const available = settingsRowsFor(overview?.session.role)
  const [query, setQuery] = useState("")
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshOverview = useCallback(async () => {
    const next = await loadAccountOverview({ force: true })
    if (!next) return
    if (!next.session.authenticated) {
      onOpenChange(false)
      onSignedOut?.()
      return
    }
    onOverviewChange?.(next)
  }, [onOpenChange, onSignedOut, onOverviewChange])

  // Refresh standing when the sheet opens; a dead session signs out instead
  // of painting stale identity.
  useEffect(() => {
    if (open) void refreshOverview().catch(() => {})
  }, [open, refreshOverview])

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
  const description = refused ? "这个设置分区只对超级管理员开放。" : active.description

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent layout="settings">
          <DialogTitle className="sr-only">设置</DialogTitle>
          <div className="flex h-full min-h-0 flex-col md:flex-row">
            <SettingsNavigation rows={available} pane={pane} query={query} onQuery={setQuery} onSelect={onSectionChange} overview={overview} />

            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain",
                fullPane && "flex flex-col overflow-hidden",
              )}
            >
              <div
                className={cn(
                  "flex flex-col gap-1.5 px-5 pt-5 pb-5 md:px-8 md:pt-7 md:pr-14 md:pb-6",
                  !active.wide && "mx-auto w-full max-w-3xl",
                  fullPane && "shrink-0",
                )}
              >
                <p className="text-meta text-muted-foreground">{refused ? "设置" : active.group}</p>
                <h2 className="text-xl font-semibold tracking-tight">
                  {refused ? "没有权限打开该设置" : active.title}
                </h2>
                {description && (
                  <p className="text-compact text-muted-foreground">{description}</p>
                )}
              </div>
              <div
                className={cn(
                  "px-5 pb-6 md:px-8 md:pb-8",
                  !active.wide && "mx-auto w-full max-w-3xl",
                  fullPane && "flex min-h-0 flex-1 flex-col overflow-hidden",
                )}
              >
                {refused ? (
                  /* Refusal is a state, not a failed operation: an icon and the
                     way out, while the copy stays in the header. No
                     `role="alert"` and no raw error text enter this pane. */
                  <Empty role="status" className="min-h-48">
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
                        onClick={() => onOpenChange(false)}
                      >
                        关闭
                      </Button>
                    </EmptyContent>
                  </Empty>
                ) : null}
                {pane === "account" ? (
                  <div className="flex flex-col gap-4">
                    <AccountProfileSection
                      overview={overview}
                      onOverviewChange={onOverviewChange}
                    />
                    <SettingRow
                      title="登录密码"
                      description="修改后其他设备上的登录会失效"
                      control={
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPasswordOpen(true)}
                        >
                          <KeyRound data-icon="inline-start" />
                          修改密码
                        </Button>
                      }
                    />
                  </div>
                ) : null}
                {pane === "notifications" ? (
                  <SettingRow
                    title="通知中心"
                    description="查看和处理未读提醒"
                    control={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onOpenChange(false)
                          if (onOpenNotifications) {
                            onOpenNotifications()
                          } else {
                            onNavigate?.("notifications")
                          }
                        }}
                      >
                        <Bell data-icon="inline-start" />
                        打开通知中心
                      </Button>
                    }
                  />
                ) : null}
                {pane === "appearance" ? <AppearanceRows /> : null}
                {pane === "storage" ? <DeviceStoragePanel /> : null}
                {pane === "mcp" && open ? (
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
                  <Suspense fallback={<PaneLoading label="厂家账号" />}>
                    <SupplierAccountsScreen overview={overview} embedded />
                  </Suspense>
                ) : null}
                {pane === "ocr" ? (
                  <Suspense fallback={<PaneLoading label="OCR" />}>
                    <PlatformOcrScreen onOpenAccounts={() => onSectionChange("ai-accounts")} />
                  </Suspense>
                ) : null}
                {pane === "ai-accounts" ? (
                  <Suspense fallback={<PaneLoading label="AI 账号池" />}>
                    <PlatformAiAccountsScreen onOpenModels={() => onSectionChange("ocr")} />
                  </Suspense>
                ) : null}
                {pane === "media" ? (
                  <Suspense fallback={<PaneLoading label="对象存储" />}>
                    <PlatformMediaScreen />
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
                {pane === "prompts" ? (
                  <Suspense fallback={<PaneLoading label="提示词" />}>
                    <PlatformPromptsScreen />
                  </Suspense>
                ) : null}
                {pane === "banned-tags" ? (
                  <Suspense fallback={<PaneLoading label="受限标签" />}>
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
          </div>
        </DialogContent>
      </Dialog>

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
