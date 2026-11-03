import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { ArrowLeft } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { AccountOverview, WorkspaceStandingView } from "@/bindings/commands"
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
import { ADMIN_SURFACE_PATH, withSettings } from "@/lib/admin-surface"
import { runViewTransition } from "@/lib/view-transition"
import { Breadcrumb } from "@/components/breadcrumb"
import { useScreenActive } from "@/components/screen-pane"
import { cn } from "@/lib/utils"
import {
  SettingsPage,
  SettingsOpenProvider,
} from "@/app/settings-page"
import { SettingsLayout } from "@/app/settings-navigation"
import { ADMIN_SETTINGS_ROWS, isSettingsSection, resolveSettingsPane, settingsRowsFor, type SettingsSection } from "@/lib/settings-sections"
import { HeaderWalletBalance } from "@/components/workspace-quota-facts"
import { AccountMenu, WorkspaceMenu } from "@/components/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import {
  TooltipProvider,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
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
import { NavGroup, ShellHeaderActivity, SidebarCollapseButton } from "@/app/app-shell-chrome"
import { ShellPanels } from "@/app/app-shell-panels"
import { ShellSearch } from "@/app/app-shell-search"

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
  const isAgent = overview?.is_agent === true
  const isStaff = isPlatformStaffRole(overview?.session.role)
  const audience: NavAudience = {
    isAgent, isStaff, isSuperAdmin: isPlatformSuperAdminRole(overview?.session.role), isCatalogManager: overview?.is_catalog_manager === true,
  }
  const navigation = sidebarGroupsFor(audience)
  const navigationGroup = navigation.find((group) => group.items.some((item) => item.id === screen))?.label
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
  const [localSettingsSection, setLocalSettingsSection] = useState<SettingsSection | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("settings")
    return requested && isSettingsSection(requested) ? requested : null
  })
  const settingsSection = adminSurface ? settingsRequest : localSettingsSection
  const settingsOpen = settingsSection !== null
  const currentSettings = useRef(settingsSection)
  useLayoutEffect(() => { currentSettings.current = settingsSection }, [settingsSection])
  const settingsRows = settingsRowsFor(overview?.session.role)
  const settingsResolution = resolveSettingsPane({ requested: settingsSection ?? "account", available: settingsRows, adminSurface })
  const settingsPane = settingsResolution.kind === "pane" ? settingsResolution.section : ""
  const settingsBreadcrumb = settingsPane === "account"
    ? "设置"
    : settingsRows.find((row) => row.id === settingsPane)?.label ?? "没有权限打开该设置"
  const settingsBreadcrumbGroup = settingsPane === "account" ? undefined : "设置"
  // Admin settings stay URL-owned; business panes stay mounted underneath so
  // returning restores the original page, form state and scroll position.
  const setSettingsSection = useCallback(
    (section: SettingsSection | null) => {
      if (!adminSurface && section && ADMIN_SETTINGS_ROWS.some((row) => row.id === section)) {
        replaceAddress({ pathname: ADMIN_SURFACE_PATH, search: withSettings("", section) })
        return
      }
      if (adminSurface) {
        onSettingsRequestChange?.(section)
        return
      }
      setLocalSettingsSection(section)
    },
    [adminSurface, onSettingsRequestChange],
  )
  const openSettings = useCallback((section: SettingsSection = "account") => {
    if (section !== currentSettings.current) runViewTransition(() => setSettingsSection(section))
  }, [setSettingsSection])
  const closeSettings = useCallback(() => {
    if (settingsOpen) runViewTransition(() => setSettingsSection(null))
  }, [setSettingsSection, settingsOpen])

  const navigateFromShell = useCallback((next: AppScreen) => {
    if (settingsOpen && next === screen) {
      runViewTransition(() => {
        setSettingsSection(null)
        onScreenChange(next)
      })
      return
    }
    if (settingsOpen) setSettingsSection(null)
    onScreenChange(next)
  }, [onScreenChange, screen, setSettingsSection, settingsOpen])
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
      <SidebarProvider defaultOpen={false} className="workspace-shell flex h-svh flex-col overflow-hidden">
        <ShellPanels sidebar={
        <Sidebar collapsible="icon" className="shell-sidebar">
          <SidebarHeader className="relative">
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
            <ShellSearch groups={navigation} currentScreen={settingsOpen ? null : screen} onNavigate={navigateFromShell} />
          </SidebarHeader>

          <SidebarContent>
            <nav aria-label="主导航">
              {navigation.map((group) => (
                <NavGroup
                  key={group.label}
                  label={group.label}
                  items={group.items}
                  screen={settingsOpen ? null : screen}
                  onScreenChange={navigateFromShell}
                />
              ))}
            </nav>
          </SidebarContent>

          <SidebarFooter>
            <AccountMenu
              overview={overview}
              onSignedOut={onSignedOut}
              onOpenSettings={openSettings}
            />
            <span data-version-chip className="sr-only">PodHub {productVersionLabel()}</span>
          </SidebarFooter>
        </Sidebar>
        }>
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="shell-header flex shrink-0 items-center gap-2 border-b border-border px-3">
            <SidebarCollapseButton />
            {settingsOpen ? (
              <Button type="button" variant="ghost" size="icon-sm" aria-label="返回业务页面" onClick={closeSettings}>
                <ArrowLeft aria-hidden />
              </Button>
            ) : null}
            <Breadcrumb
              alwaysVisible
              groupLabel={settingsOpen ? settingsBreadcrumbGroup : navigationGroup}
              moduleLabel={settingsOpen ? settingsBreadcrumb : SCREEN_LABELS[screen] ?? screen}
              trail={settingsOpen ? undefined : trail}
            />
            <div className="flex-1" aria-hidden />
            <ShellHeaderActivity screen={screen} onOpenListing={openListing} />
            <ShellDate />
            {overview?.active_workspace ? (
              <HeaderWalletBalance
                workspaceId={overview.active_workspace.id}
                onOpenUsage={openUsage}
              />
            ) : null}
            <Button type="button" variant="ghost" size="icon-sm" aria-label="店铺管理" onClick={() => navigateFromShell("stores")}>
              <StoreIcon aria-hidden className="size-[18px]" />
            </Button>
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
            <div className={cn("page-canvas flex flex-1 flex-col gap-2", screen === "home" && "home-canvas", settingsOpen && "hidden")} hidden={settingsOpen} inert={settingsOpen} aria-hidden={settingsOpen}>
              {children}
            </div>
            {settingsSection !== null ? (
              <SettingsLayout rows={settingsRows} pane={settingsPane} onSelect={openSettings} overview={overview}>
              <SettingsPage
                onBack={closeSettings}
                overview={overview}
                onOverviewChange={onOverviewChange}
                onSignedOut={onSignedOut}
                section={settingsSection}
                adminSurface={adminSurface}
              />
              </SettingsLayout>
            ) : null}
          </div>
        </SidebarInset>
        </ShellPanels>
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

function ShellDate() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(new Date()), 1000 - Date.now() % 1000)
    return () => window.clearTimeout(timer)
  }, [now])
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  const date = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
  const time = `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
  return (
    <time className="shell-date" dateTime={`${date}T${time}`}>
      {date} {time}
    </time>
  )
}

