import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  AppShell,
  type AppScreen,
} from "@/app/app-shell"
import { AdminSurfaceDenied } from "@/app/admin-surface-gate"
import {
  isAdminScreen,
  withScreen,
  withSettings,
  withoutForeignSearch,
  withoutSettings,
} from "@/lib/admin-surface"
import {
  defaultScreenFor,
  isAddressableScreen,
  type Surface,
} from "@/lib/app-navigation"
import { resolveRoute, routeAudienceFor } from "@/lib/app-route"
import { replaceAddress } from "@/lib/address"
import { useAddress } from "@/hooks/use-address"
import { withoutCatalogPick } from "@/features/workflow/workflow-navigation"
import type { SettingsSection } from "@/lib/settings-sections"
import { NoWorkspaceGate } from "@/features/workspace/no-workspace-gate"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { loadAccountOverview, peekAccountOverview, useAccountOverview } from "@/features/account/account-overview-cache"
import { invalidateStoreRoster } from "@/features/stores/store-roster-cache"
import { invalidateWallet } from "@/features/usage/wallet-cache"
import { invalidateUsageStats } from "@/features/usage/usage-cache"
import { invalidateUsageSummary } from "@/features/usage/usage-summary-cache"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { ScreenCatalog } from "@/app/screen-catalog"
import { SupplierApp } from "@/features/supplier/supplier-app"
import { runViewTransition } from "@/lib/view-transition"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { EmailVerifyNotice } from "@/features/account/email-verify-notice"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { inviteCodeFromSearch } from "@/features/account/login-screen"
import { mountAutomationRuntime } from "@/features/automation/runtime"
import { isObservationScreen } from "@/lib/app-screens"
import { mountWorkbenchRuntime } from "@/app/automation-surface"

/**
 * `/login?invite=CODE` opened by an already signed-in visitor is a late claim
 * (`docs/agent-rebate.md`): bind once, before the first
 * paid order. The code leaves the URL whether or not the claim lands, so a
 * reload never re-prompts; the server owns "already bound" / "already paid"
 * and this page only reports the refusal.
 */
function InviteClaimPrompt() {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCode(inviteCodeFromSearch(window.location.search))
  }, [])

  if (!code) return null

  function dismiss() {
    const next = new URL(window.location.href)
    next.searchParams.delete("invite")
    replaceAddress(next.href)
    setCode("")
  }

  async function confirm() {
    setBusy(true)
    try {
      const claimed = await accountHttp.agentClaimCode(code)
      notifySuccess(`已绑定邀请码，邀请人：${claimed.agent_name}`)
      dismiss()
    } catch (reason) {
      notifyCommandError(reason, "绑定邀请码失败，请检查邀请码后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent>
        <DialogTitle>绑定邀请码</DialogTitle>
        <DialogDescription>
          邀请码 <span className="font-mono">{code}</span>{" "}
          会把你记在这次邀请名下；绑定后不可更改，邀请人在你名下 Workspace
          首笔合格订单结算时获得返点。
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={dismiss}>
            暂不绑定
          </Button>
          <Button disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            确认绑定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AuthenticatedApp({
  overview: overviewProp,
  onOverviewChange,
  onSignedOut,
  onAddAccount,
}: {
  overview: AccountOverview
  onOverviewChange: (next: AccountOverview) => void
  onSignedOut: () => void
  onAddAccount: () => void
}) {
  // The address picks the surface, the screen and the admin sheet: what is
  // painted and what the address claims are two readings of one resolver run,
  // so they can never drift apart.
  // Polls publish to the account cache without changing App props. The route
  // must read that same live rank as AppShell or a downgraded pane stays mounted.
  const overview = useAccountOverview() ?? overviewProp
  const address = useAddress()
  const audience = useMemo(
    () =>
      routeAudienceFor({
        authenticated: true,
        role: overview.session.role,
        accountMode: overview.account_mode,
        isAgent: overview.is_agent,
      }),
    [overview.session.role, overview.account_mode, overview.is_agent],
  )
  const route = resolveRoute(address, audience)
  const adminSurface = route.kind === "admin" || route.kind === "admin-denied"
  const surface: Surface = adminSurface ? "admin" : "workbench"
  const routeScreen: AppScreen | null =
    route.kind === "admin" || route.kind === "workbench" ? route.screen : null
  // The admin sheet is URL state: `/admin?settings=media` opens, reloads and
  // stays shareable, while the workbench sheet keeps its ephemeral behaviour.
  const routeSettings: SettingsSection | null =
    route.kind === "admin" ? route.settings : null
  const screen: AppScreen = routeScreen ?? defaultScreenFor("workbench", audience)

  // Panes stay mounted once visited, but only screens this audience may
  // address are ever worth keeping: a role change must not leave a pane
  // mounted that no address could reach any more.
  const [visited, setVisited] = useState<Set<AppScreen>>(() => new Set([screen]))
  const liveVisited = [...visited].filter((id) =>
    isAddressableScreen(id, surface, audience),
  )

  useEffect(() => {
    setVisited((prev) => (prev.has(screen) ? prev : new Set(prev).add(screen)))
  }, [screen])

  // The automation execution endpoint lives at the shell, not a page: a
  // claimed command must survive navigation, and a Workspace switch stops it
  // outright — the new scope re-registers under its own runtimes so stale
  // claims can never be executed against the wrong Workspace.
  const automationWorkspaceId = overview.active_workspace?.id
  useEffect(() => {
    // Platform reads must not register/heartbeat/claim/settle delegated writes.
    return mountWorkbenchRuntime(route.kind, automationWorkspaceId, mountAutomationRuntime)
  }, [automationWorkspaceId, route.kind])

  // A deep link that names something this surface does not address is rewritten
  // once, to what is actually painted: an address must not keep claiming a
  // screen the surface never had, nor one this audience may not reach. Leftover
  // module params (`product=` from 平台货源, gallery filters, `pick=`) are
  // stripped the same way, so 批量上架's homepage stays `?screen=listing`.
  // The rewritten value is addressable, so this cannot loop, and `/` with no
  // `screen` stays clean.
  useEffect(() => {
    if (route.kind !== "admin" && route.kind !== "workbench") return
    // An external jump (back/forward) may have moved the address since this
    // route was resolved. That render owns its own rewrite; this one must not
    // clobber an address it never read.
    if (
      window.location.pathname + window.location.search !==
      address.pathname + address.search
    ) {
      return
    }
    const params = new URLSearchParams(window.location.search)
    const requested = params.get("screen")
    let next =
      requested !== null && requested !== route.screen
        ? withScreen(window.location.search, route.screen)
        : withoutForeignSearch(window.location.search, route.screen)
    // An unknown `settings` id opens nothing, so the address stops naming it.
    if (route.kind === "admin" && params.has("settings") && route.settings === null) {
      next = withoutSettings(next)
    }
    if (next !== window.location.search) replaceAddress({ search: next })
  }, [address.search, route.kind, routeScreen, routeSettings])

  // A refused response can follow a committed Cookie/Workspace change. Only
  // a fresh overview may restore that authority and its diagnostic context.
  const recoverAccountContext = useCallback(async () => {
    try {
      await loadAccountOverview({ force: true })
      const current = peekAccountOverview()
      if (current) onOverviewChange(current)
    } catch { /* Keep diagnostics paused until a later session probe succeeds. */ }
  }, [onOverviewChange])

  const switchWorkspace = useCallback(async (workspaceId: number) => {
    try {
      const next = await accountHttp.accountSwitchWorkspace(workspaceId)
      invalidateStoreRoster()
      invalidateWallet()
      invalidateUsageStats()
      invalidateUsageSummary()
      onOverviewChange(next)
    } catch (reason) {
      await recoverAccountContext()
      notifyCommandError(reason, "无法切换 Workspace，请稍后重试。")
    }
  }, [onOverviewChange, recoverAccountContext])

  // Account switching swaps `sid` — the whole authenticated identity. A
  // reload is the honest repaint: no account-scoped store, keep-alive pane or
  // in-flight cache can leak across the boundary.
  const switchAccount = useCallback(async (uuid: string) => {
    try {
      await accountHttp.accountSwitchAccount(uuid)
    } catch (reason) {
      await recoverAccountContext()
      notifyCommandError(reason, "无法切换账号，请稍后重试。")
      return
    }
    invalidateAllSessionCaches()
    window.location.reload()
  }, [recoverAccountContext])

  const removeAccount = useCallback(async (uuid: string) => {
    const wasActive = overview.accounts?.some(
      (account) => account.uuid === uuid && account.active,
    )
    try {
      await accountHttp.accountLogoutAccount(uuid)
    } catch (reason) {
      await recoverAccountContext()
      notifyCommandError(reason, "无法退出该账号，请稍后重试。")
      return
    }
    if (wasActive) {
      invalidateAllSessionCaches()
      window.location.reload()
      return
    }
    onSignedOut()
  }, [overview, onSignedOut, recoverAccountContext])

  const refreshOverview = useCallback(async () => {
    try {
      await loadAccountOverview({ force: true })
      // Another refresh may have superseded this request.
      const current = peekAccountOverview()
      if (current) onOverviewChange(current)
    } catch (reason) {
      notifyCommandError(reason, "工作空间状态刷新失败，请重试。")
    }
  }, [onOverviewChange])

  const goTo = useCallback(
    (next: AppScreen) => {
      // 选品意图（`?pick=1`）是一次「为列表选品」的会话意图：离开商库即失效，
      // 免得下次从侧边栏进商库还停在「从商库添加」的选品模式。屏级参数归属由
      // `withScreen` 的键表负责，这里只盯这个意图自己的生命周期。
      const nextSearch = (search: string) =>
        next === "catalog" ? search : withoutCatalogPick(search)
      if (!adminSurface && isObservationScreen(next)) {
        if (!isAddressableScreen(next, "admin", audience)) return
        window.location.assign(`/admin${withScreen(window.location.search, next)}`)
        return
      }
      // `/admin` addresses admin destinations only. A click that asks for a
      // workbench screen (wallet chip, 店铺 entry, notification bell) is a
      // surface crossing: navigate to that surface's own address instead of
      // repainting `/admin` as a screen it does not own.
      if (adminSurface && !isAdminScreen(next)) {
        // Crossing surfaces keeps this window's own parameters (an invite code,
        // a supplier-db open id) and drops only the admin sheet's state.
        window.location.assign(
          `/${nextSearch(withScreen(withoutSettings(window.location.search), next))}`,
        )
        return
      }
      // A destination this audience cannot address is not a navigation: the nav
      // never paints one, and the resolver would fall back to the same screen.
      if (!isAddressableScreen(next, surface, audience)) return
      const search = nextSearch(withScreen(window.location.search, next))
      if (screen === next) {
        replaceAddress({ search })
        return
      }
      runViewTransition(() => replaceAddress({ search }))
    },
    [adminSurface, surface, audience, screen],
  )

  /** Open, switch or close the admin sheet by rewriting `?settings=`. */
  const changeAdminSettings = useCallback((section: SettingsSection | null) => {
    replaceAddress({
      search: section
        ? withSettings(window.location.search, section)
        : withoutSettings(window.location.search),
    })
  }, [])

  const onInvitationAccepted = useCallback(async () => {
    onOverviewChange(await accountHttp.accountListWorkspaces())
  }, [onOverviewChange])

  // The surface gate answers before any workspace standing: the URL is the
  // boundary, and a non-staff caller is told so instead of being painted a
  // shell they may not use.
  if (route.kind === "admin-denied") {
    return <AdminSurfaceDenied onLeave={() => window.location.assign("/")} />
  }

  // Workspace standing gates the workbench only; `/admin` is staff business.
  // A workspaceless account may still be a factory member (ADR-0100): the
  // supplier face probes the membership first and only falls back to the
  // no-Workspace gate when the account is not one.
  if (route.kind === "workspace-required") {
    return (
      <NotificationsProvider onAccepted={onInvitationAccepted}>
        <EmailVerifyNotice overview={overview} />
        <SupplierApp
          overview={overview}
          onSignedOut={onSignedOut}
          fallback={
            <NoWorkspaceGate
              overview={overview}
              onCreated={() => {
                void refreshOverview()
              }}
              onSwitchAccount={switchAccount}
              onLogoutAccount={removeAccount}
              onAddAccount={onAddAccount}
              onSignedOut={onSignedOut}
            />
          }
        />
        <InviteClaimPrompt />
      </NotificationsProvider>
    )
  }

  return (
    <NotificationsProvider onAccepted={onInvitationAccepted}>
      <EmailVerifyNotice overview={overview} />
      <AppShell
        screen={screen}
        onScreenChange={goTo}
        adminSurface={adminSurface}
        settingsRequest={routeSettings}
        onSettingsRequestChange={changeAdminSettings}
        overview={overview}
        onSwitchWorkspace={switchWorkspace}
        onSwitchAccount={switchAccount}
        onLogoutAccount={removeAccount}
        onAddAccount={onAddAccount}
        onOverviewChange={onOverviewChange}
        onSignedOut={onSignedOut}
        onWorkspaceCreated={refreshOverview}
      >
        <ScreenCatalog
          screen={screen}
          visited={liveVisited}
          overview={overview}
          onOverviewChange={onOverviewChange}
          onSignedOut={onSignedOut}
          onNavigate={goTo}
          onRefreshOverview={refreshOverview}
        />
      </AppShell>
      <InviteClaimPrompt />
    </NotificationsProvider>
  )
}
