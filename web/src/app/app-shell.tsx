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
import { NavModeSwitcher } from "@/components/nav-mode-switcher"
import { useScreenActive } from "@/components/screen-pane"
import {
  SettingsDialog,
  SettingsOpenProvider,
} from "@/app/settings-dialog"
import { GlobalSearch } from "@/app/global-search"
import {
  adminSettingsRowsFor,
  type SettingsSection,
} from "@/lib/settings-sections"
import { HeaderWalletBalance } from "@/components/workspace-quota-facts"
import { WorkspaceMenu } from "@/components/workspace-switcher"
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
  NAVIGATION,
  modeOfScreen,
  navItemsFor,
  navModesFor,
  staffNavModes,
  type NavAudience,
  type NavMode,
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
   * The `/admin` surface: staff-only nav, a settings rail, and a sheet whose
   * open/section state belongs to the caller (the URL) instead of this shell.
   */
  adminSurface?: boolean
  /** The section the admin URL asks the sheet to open; null keeps it closed. */
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
  // Platform management is a super_admin surface; the main-menu 平台 mode is
  // staff-wide. One predicate decides both, so an `admin` rank can run
  // 货源管理 without ever seeing a platform-management pane.
  const adminSettings = adminSettingsRowsFor(overview?.session.role)
  const audience: NavAudience = {
    isAgent, isStaff, isSuperAdmin: isPlatformSuperAdminRole(overview?.session.role),
  }
  // `/admin` paints the staff modes and nothing else — one boundary, one
  // audience. The workbench keeps the full switcher.
  const visibleModes = adminSurface
    ? staffNavModes().filter((mode) => navModesFor(audience).includes(mode))
    : navModesFor(audience)
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
  const [heldMode, setHeldMode] = useState<NavMode>("workbench")
  const [lastByMode, setLastByMode] = useState<Partial<Record<NavMode, AppScreen>>>({})
  const screenMode = modeOfScreen(screen)
  const mode = screenMode && visibleModes.includes(screenMode) ? screenMode : heldMode
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("account")
  // On `/admin` the sheet is URL state: the caller owns `?settings=`, so the
  // address always names the pane that is open and a reload re-opens it. The
  // workbench keeps the ephemeral sheet it has always had.
  const openSettings = useCallback(
    (section: SettingsSection = "account") => {
      setSettingsSection(section)
      if (adminSurface) {
        onSettingsRequestChange?.(section)
        return
      }
      setSettingsOpen(true)
    },
    [adminSurface, onSettingsRequestChange],
  )
  const changeSettingsOpen = useCallback(
    (open: boolean) => {
      if (adminSurface) {
        if (!open) onSettingsRequestChange?.(null)
        return
      }
      setSettingsOpen(open)
    },
    [adminSurface, onSettingsRequestChange],
  )

  useEffect(() => {
    if (!adminSurface) return
    if (settingsRequest) {
      setSettingsSection(settingsRequest)
      setSettingsOpen(true)
      return
    }
    setSettingsOpen(false)
  }, [adminSurface, settingsRequest])
  const openPlans = useCallback(() => openSettings("plans"), [openSettings])
  const openUsage = useCallback(() => onScreenChange("usage"), [onScreenChange])
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
    onScreenChange("listing")
  }, [onScreenChange])
  const openStores = useCallback(() => onScreenChange("stores"), [onScreenChange])

  useEffect(() => {
    const next = modeOfScreen(screen)
    if (!next) return
    if (NAVIGATION[next].staffOnly && !isStaff) return
    setHeldMode(next)
    setLastByMode((prev) => (prev[next] === screen ? prev : { ...prev, [next]: screen }))
  }, [screen, isStaff])

  const openMode = useCallback(
    (next: NavMode) => {
      setHeldMode(next)
      onScreenChange(lastByMode[next] ?? NAVIGATION[next].items[0].id)
    },
    [lastByMode, onScreenChange],
  )

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
            <div className="flex h-7 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <img
                src="/app-icon.svg"
                alt=""
                aria-hidden
                className="size-7 shrink-0 rounded-md group-data-[collapsible=icon]:size-9"
              />
              <span className="relative min-w-0 group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-md font-medium tracking-[-0.01em]">
                  PodHub
                </span>
                <span
                  aria-hidden
                  data-version-chip
                  className="pointer-events-none absolute bottom-0 left-full ml-1 select-none whitespace-nowrap text-meta font-medium leading-none text-muted-foreground"
                >
                  {productVersionLabel()}
                </span>
              </span>
            </div>
            {/* The identity block owns the rail's top edge; the hairline steps
                the header's px-3.5 back out so the rule spans the rail edge to
                edge, restating the width on the data variant that outbids the
                primitive's own w-full. Dropped in the icon fold. */}
            <SidebarSeparator className="-mx-3.5 my-1 data-[orientation=horizontal]:w-[calc(100%_+_1.75rem)] group-data-[collapsible=icon]:hidden" />
            <GlobalSearch
              audience={audience}
              adminSurface={adminSurface}
              adminSections={adminSettings}
              workspaceId={overview?.active_workspace?.id}
              onScreenChange={onScreenChange}
              onOpenSettings={openSettings}
            />
            {visibleModes.length > 1 ? (
              <NavModeSwitcher
                mode={mode}
                modes={visibleModes}
                onModeChange={openMode}
              />
            ) : null}
          </SidebarHeader>

          <SidebarContent>
            <NavGroup
              /* A surface with no mode to paint (the admin boundary reached by
                 a session that is not staff) paints no destinations at all. */
              items={visibleModes.includes(mode) ? navItemsFor(mode, audience) : []}
              screen={screen}
              onScreenChange={onScreenChange}
            />
          </SidebarContent>

          <SidebarFooter>
            <WorkspaceMenu
              overview={overview}
              standing={standing}
              onOpenSpace={onScreenChange}
              spaceScreen={isWorkspaceSpaceScreen(screen) ? screen : undefined}
              onSwitchWorkspace={onSwitchWorkspace}
              onSwitchAccount={onSwitchAccount}
              onLogoutAccount={onLogoutAccount}
              onAddAccount={onAddAccount}
              onWorkspaceCreated={onWorkspaceCreated}
              onOpenPlans={openPlans}
              onOverviewChange={onOverviewChange}
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
              moduleLabel={SCREEN_LABELS[screen] ?? screen}
              trail={trail}
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
            <div className="page-canvas mx-auto flex flex-1 flex-col gap-4">
              {children}
            </div>
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
              onNavigate={onScreenChange}
            />
          </Suspense>
        ) : null}
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={changeSettingsOpen}
          overview={overview}
          onOverviewChange={onOverviewChange}
          onSignedOut={onSignedOut}
          onNavigate={onScreenChange}
          onOpenNotifications={openNotifications}
          section={settingsSection}
          onSectionChange={openSettings}
          adminSurface={adminSurface}
        />
      </SidebarProvider>
      </SettingsOpenProvider>
      </TrailContext.Provider>
    </TooltipProvider>
  )
}

