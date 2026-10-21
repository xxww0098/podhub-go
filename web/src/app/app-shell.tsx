import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import type { AccountOverview, WorkspaceStandingView } from "@/bindings/commands"
import { ChangelogButton } from "@/components/changelog-dialog"
import { productVersionLabel } from "@/lib/product-version"
import { NotificationBell } from "@/features/notifications/notification-bell"
import {
  ACCOUNT_OVERVIEW_POLL_MS,
  loadAccountOverview,
  peekAccountOverview,
  useAccountOverview,
} from "@/features/account/account-overview-cache"
import type { NotificationsController } from "@/features/notifications/notifications"
import { useVisiblePolling } from "@/lib/visible-polling"
import {
  peekListingWorkbench,
} from "@/features/workflow/workbench/listing-workbench-store"
import { withWorkflowCardId } from "@/features/workflow/workflow-navigation"
import { replaceAddress } from "@/lib/address"
import { Breadcrumb } from "@/components/breadcrumb"
import { useScreenActive } from "@/components/screen-pane"
import { cn } from "@/lib/utils"
import {
  SettingsPage,
  SettingsOpenProvider,
} from "@/app/settings-page"
import { SettingsNavigation } from "@/app/settings-navigation"
import { resolveSettingsPane, settingsRowsFor, type SettingsSection } from "@/lib/settings-sections"
import { HeaderWalletBalance } from "@/components/workspace-quota-facts"
import { AccountMenu, WorkspaceMenu } from "@/components/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  TooltipProvider,
} from "@/components/ui/tooltip"
import {
  sidebarGroupsFor,
  type NavAudience,
} from "@/lib/app-navigation"
import { isPlatformStaffRole, isPlatformSuperAdminRole } from "@/lib/platform-role"
import {
  isWorkspaceSpaceScreen,
  SCREEN_LABELS,
  type AppScreen,
} from "@/lib/app-screens"
import {
  loadNotificationsDialog,
} from "@/app/screen-loaders"
import { NavGroup, ShellHeaderActivity, SidebarUtilityBar, StoreQuickButton } from "@/app/app-shell-chrome"

export type { AppScreen } from "@/lib/app-screens"
export { SCREEN_LABELS } from "@/lib/app-screens"

/* The notification centre is a floating window over the shell, not a screen:
   lazy like the screens so the entry chunk never pays for it. */
const NotificationsDialog = lazy(async () => ({
  default: (await loadNotificationsDialog()).NotificationsDialog,
}))

/**
 * A screen that drills into a record publishes the record's name here, so the
 * breadcrumb keeps naming where the operator actually is and the module segment
 * stays a working way back out. Without it a category form is a dead end whose
 * only exit is re-clicking the nav item you are already on.
 */
export type TrailEntry = {
  label: string
  onExit: () => void
}

/** Tests subscribe here to watch a screen publish/clear its trail segment. */
export const TrailContext = createContext<(entry?: TrailEntry) => void>(
  () => {},
)

export function useTrailSegment(label: string | undefined, onExit: () => void) {
  const publish = useContext(TrailContext)
  const active = useScreenActive()
  useEffect(() => {
    if (!active) return
    publish(label ? { label, onExit } : undefined)
    return () => publish(undefined)
  }, [publish, label, onExit, active])
}

type AppShellProps = {
  screen: AppScreen
  onScreenChange: (screen: AppScreen) => void
  /**
   * The `/admin` surface: staff-only nav and a settings page whose
   * open/section state belongs to the caller (the URL) instead of this shell.
   */
  adminSurface?: boolean
  /** The section the admin URL asks to open; null shows the business page. */
  settingsRequest?: SettingsSection | null
  /** Admin surface only: open (`section`) or close (`null`) by URL. */
  onSettingsRequestChange?: (section: SettingsSection | null) => void
  overview?: AccountOverview
  onSwitchWorkspace?: (workspaceId: number) => void
  onSwitchAccount?: (uuid: string) => void
  onLogoutAccount?: (uuid: string) => void
  onAddAccount?: () => void
  onOverviewChange?: (overview: AccountOverview) => void
  onSignedOut: () => void
  /** Tests inject a controller; production reads the window's one poll. */
  notifications?: NotificationsController
  /** Fires after a Workspace is created from the switcher, so the shell refreshes. */
  onWorkspaceCreated?: (standing: WorkspaceStandingView) => void
  children: ReactNode
}

export function AppShell({
  screen,
  onScreenChange,
  adminSurface = false,
  settingsRequest = null,
  onSettingsRequestChange,
  overview: overviewProp,
  onSwitchWorkspace,
  onSwitchAccount,
  onLogoutAccount,
  onAddAccount,
  onOverviewChange,
  onSignedOut,
  notifications,
  onWorkspaceCreated,
  children,
}: AppShellProps) {
  const overview = useAccountOverview() ?? overviewProp
  useVisiblePolling({
    enabled: Boolean(overview?.session.authenticated),
    intervalMs: ACCOUNT_OVERVIEW_POLL_MS,
    restartKey: overview?.active_workspace?.id ?? "session",
    onPoll: (trigger) => {
      if (trigger === "mount" && peekAccountOverview()) return
      void loadAccountOverview().catch(() => {})
    },
  })
  const entitlement = overview?.entitlement
  const isAgent = overview?.is_agent === true
  const isStaff = isPlatformStaffRole(overview?.session.role)
  const audience: NavAudience = {
    isAgent, isStaff, isSuperAdmin: isPlatformSuperAdminRole(overview?.session.role),
  }
  const navigation = sidebarGroupsFor(adminSurface ? "admin" : "workbench", audience)
  // Cloud owns Account Mode; the shell only projects what it was told. Never
  // re-derive it from the Workspace list — an empty list is not proof of standing.
  const standing: WorkspaceStandingView | undefined = overview?.account_mode
    ? {
        workspaces: overview.workspaces,
        active_workspace: overview.active_workspace,
        account_mode: overview.account_mode,
        owned_count: overview.owned_count,
        owned_limit: overview.owned_limit,
      }
    : undefined
  const [trail, setTrail] = useState<TrailEntry>()
  const publishTrail = useCallback((entry?: TrailEntry) => setTrail(entry), [])
  const [localSettingsSection, setLocalSettingsSection] = useState<SettingsSection | null>(null)
  const settingsSection = adminSurface ? settingsRequest : localSettingsSection
  const settingsOpen = settingsSection !== null
  const settingsRows = settingsRowsFor(overview?.session.role)
  const settingsResolution = resolveSettingsPane({ requested: settingsSection ?? "account", available: settingsRows, adminSurface })
  const settingsPane = settingsResolution.kind === "pane" ? settingsResolution.section : ""
  const settingsLabel = settingsRows.find((row) => row.id === settingsPane)?.label ?? "没有权限打开该设置"
  // Admin settings stay URL-owned; business panes stay mounted underneath so
  // returning restores the original page, form state and scroll position.
  const openSettings = useCallback(
    (section: SettingsSection = "account") => {
      if (adminSurface) {
        onSettingsRequestChange?.(section)
        return
      }
      setLocalSettingsSection(section)
    },
    [adminSurface, onSettingsRequestChange],
  )
  const closeSettings = useCallback(
    () => {
      if (adminSurface) {
        onSettingsRequestChange?.(null)
        return
      }
      setLocalSettingsSection(null)
    },
    [adminSurface, onSettingsRequestChange],
  )

  const navigateFromShell = useCallback((next: AppScreen) => {
    closeSettings()
    onScreenChange(next)
  }, [closeSettings, onScreenChange])
  const openPlans = useCallback(() => openSettings("plans"), [openSettings])
  const openUsage = useCallback(() => navigateFromShell("usage"), [navigateFromShell])
  // The bell and the settings pane both land here: the centre floats, so
  // opening it never repaints (or, on /admin, reloads across) the surface.
  const [inboxMounted, setInboxMounted] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [inboxFocus, setInboxFocus] = useState<string>()
  const openNotifications = useCallback((notificationUuid?: string) => {
    setInboxFocus(notificationUuid)
    setInboxMounted(true)
    setInboxOpen(true)
  }, [])
  // 进度条回上架要落在正在跑的那张卡：与「从商库添加」同一交接——cardId 先写进
  // 当前地址，壳层换屏时才把它带进批量上架；没有打开的方案就落在主列表。
  const openListing = useCallback(() => {
    const cardId = peekListingWorkbench().cardId
    if (cardId) {
      replaceAddress({ search: withWorkflowCardId(window.location.search, cardId) })
    }
    navigateFromShell("listing")
  }, [navigateFromShell])
  const openStores = useCallback(() => navigateFromShell("stores"), [navigateFromShell])

  return (
    <TooltipProvider>
      <TrailContext.Provider value={publishTrail}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-overlay focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        跳到主内容
      </a>
      <SettingsOpenProvider value={openSettings}>
      <SidebarProvider className="h-svh overflow-hidden bg-sidebar">
        <Sidebar collapsible="icon">
          <SidebarHeader className="relative">
            <div className="flex h-10 items-center justify-center gap-2 px-0 group-data-[collapsible=icon]:px-0">
              <img
                src="/app-icon.svg"
                alt=""
                aria-hidden
                className="size-10 shrink-0 rounded-md group-data-[collapsible=icon]:size-9"
              />
              <span className="flex min-w-0 items-baseline gap-1 group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-2xl font-semibold tracking-[-0.01em]">
                  PodHub
                </span>
                <span
                  aria-hidden
                  data-version-chip
                  className="pointer-events-none shrink-0 select-none whitespace-nowrap text-meta font-medium leading-none text-muted-foreground"
                >
                  {productVersionLabel()}
                </span>
              </span>
            </div>
            <SidebarSeparator className="mx-0 my-1 group-data-[collapsible=icon]:hidden" />
            <WorkspaceMenu
              overview={overview}
              standing={standing}
              onOpenSpace={navigateFromShell}
              spaceScreen={isWorkspaceSpaceScreen(screen) ? screen : undefined}
              onSwitchWorkspace={onSwitchWorkspace}
              onWorkspaceCreated={onWorkspaceCreated}
              onOpenPlans={openPlans}
              onOverviewChange={onOverviewChange}
            />
          </SidebarHeader>

          <SidebarContent>
            {settingsOpen ? (
              <SettingsNavigation rows={settingsRows} pane={settingsPane} onSelect={openSettings} onBack={closeSettings} overview={overview} />
            ) : (
            <nav aria-label="主导航">
              {navigation.map((group) => (
                <NavGroup
                  key={group.label}
                  label={group.label}
                  items={group.items}
                  screen={screen}
                  onScreenChange={navigateFromShell}
                />
              ))}
            </nav>
            )}
          </SidebarContent>

          <SidebarFooter>
            <SidebarSeparator className="mx-0 group-data-[collapsible=icon]:hidden" />
            <AccountMenu
              overview={overview}
              standing={standing}
              onSwitchAccount={onSwitchAccount}
              onLogoutAccount={onLogoutAccount}
              onAddAccount={onAddAccount}
              onWorkspaceCreated={onWorkspaceCreated}
              onSignedOut={onSignedOut}
            />
            <SidebarUtilityBar onOpenSettings={openSettings} />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="mx-2.5 mt-2.5 flex h-11 shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3">
            <SidebarTrigger className="md:hidden" />
            <Breadcrumb
              moduleLabel={settingsOpen ? "设置" : SCREEN_LABELS[screen] ?? screen}
              trail={settingsOpen ? { label: settingsLabel, onExit: () => openSettings() } : trail}
            />
            <div className="flex-1" aria-hidden />
            <ShellHeaderActivity screen={screen} onOpenListing={openListing} />
            {entitlement ? (
              <HeaderWalletBalance
                workspaceId={overview?.active_workspace?.id}
                onOpenUsage={openUsage}
              />
            ) : null}
            <StoreQuickButton onOpen={openStores} />
            <ChangelogButton />
            <NotificationBell
              notifications={notifications}
              onOpenNotifications={openNotifications}
            />
          </header>
          <div
            id="main"
            className="module-canvas flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {/*
              Keep-alive panes stay mounted; the canvas dissolves between
              them. Remounting or replaying arrival motion on every nav jump
              is the jitter operators feel as "the app reloading". Content
              measure stays fixed — swapping max-width on nav is CLS.
            */}
            <div className={cn("page-canvas mx-auto flex flex-1 flex-col gap-4", settingsOpen && "hidden")} hidden={settingsOpen} inert={settingsOpen} aria-hidden={settingsOpen}>
              {children}
            </div>
            {settingsSection !== null ? (
              <SettingsPage
                onBack={closeSettings}
                overview={overview}
                onOverviewChange={onOverviewChange}
                onSignedOut={onSignedOut}
                onNavigate={navigateFromShell}
                onOpenNotifications={openNotifications}
                section={settingsSection}
                onSectionChange={openSettings}
                adminSurface={adminSurface}
              />
            ) : null}
          </div>
        </SidebarInset>
        {/* Once mounted it stays mounted: close animates out and the next
            open is a local reveal, not another lazy fetch. */}
        {inboxMounted ? (
          <Suspense fallback={null}>
            <NotificationsDialog
              open={inboxOpen}
              onOpenChange={setInboxOpen}
              focusUuid={inboxFocus}
              notifications={notifications}
              onNavigate={navigateFromShell}
            />
          </Suspense>
        ) : null}
      </SidebarProvider>
      </SettingsOpenProvider>
      </TrailContext.Provider>
    </TooltipProvider>
  )
}

