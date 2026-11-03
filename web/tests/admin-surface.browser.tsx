import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { AuthenticatedApp } from "@/app/authenticated-app"
import type { AccountOverview } from "@/bindings/commands"
import { AppShell } from "@/app/app-shell"
import { SettingsNavigation } from "@/app/settings-navigation"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import { adminHttp } from "@/bindings/http-admin"
import type { NotificationsController } from "@/features/notifications/notifications"
import { defaultAdminScreen } from "@/lib/admin-surface"
import { SCREEN_LABELS, type AppScreen } from "@/lib/app-screens"
import { settingsRowsFor, type SettingsSection } from "@/lib/settings-sections"
import "../src/index.css"

/** The staff screen's own label, read from the authority rather than spelled. */
const adminScreenSelector = `[aria-label="${SCREEN_LABELS[defaultAdminScreen()]}"]`

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!

/**
 * The shell reads its own standing, and a check that mounts the real entry
 * point also grows the notification bell's roster read; those two prefixes are
 * the page's expected traffic. Anything else leaving the page is a bug.
 */
const EXPECTED_TRAFFIC = ["/api/view/account-overview", "/api/notifications"]
const unexpectedRequests: string[] = []
window.fetch = async (input) => {
  const url = String(input)
  if (!EXPECTED_TRAFFIC.some((prefix) => url.startsWith(prefix))) {
    unexpectedRequests.push(url)
  }
  throw new Error(`Unexpected network request: ${url}`)
}

/** The bell is not what this page checks, so it gets a silent controller. */
const noNotifications: NotificationsController = {
  notifications: [],
  unread: 0,
  total: 0,
  hasMore: false,
  loaded: true,
  loadFailed: false,
  refreshing: false,
  loadingMore: false,
  markingAllRead: false,
  writing: false,
  overviewSyncFailed: false,
  refresh: async () => {},
  loadMore: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
  acceptInvitation: async () => false,
  declineInvitation: async () => false,
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => {
  await frame()
  await frame()
}

/** What the page actually paints — a failure must say so, not just "missing". */
function seenLabels(): string {
  return [...document.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") ?? "")
    .join(" | ")
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

/**
 * Lazy panes, effects and portals each land a frame or two after the render
 * that asked for them, so every check waits for its own evidence instead of
 * assuming a fixed number of frames has passed.
 */
async function waitFor<T extends Element>(
  selector: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const found = document.querySelector<T>(selector)
    if (found) return found
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}; saw ${seenLabels()}`)
    }
    await frame()
  }
}

async function waitForText(
  selector: string,
  text: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const content = document.querySelector(selector)?.textContent ?? ""
    if (content.includes(text)) return content
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for "${text}" in ${selector}; saw "${content.slice(0, 200)}"`)
    }
    await frame()
  }
}

async function waitForDialogToClose() {
  const deadline = performance.now() + 5000
  while (document.querySelector('[role="dialog"]')) {
    if (performance.now() > deadline) throw new Error("dialog did not close")
    await frame()
  }
}

async function waitUntil(condition: () => boolean, message: string) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(message)
    await frame()
  }
}

const overview = (role: string): AccountOverview =>
  ({
    session: {
      authenticated: true, email: "admin@example.invalid", name: "管理", role,
    },
    active_workspace: {
      id: 1,
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "示例工作空间",
      plan: "pro",
      role: "owner",
      is_owned: true,
    },
    workspaces: [],
    account_mode: "owner",
    owned_count: 1,
    owned_limit: 3,
  }) as AccountOverview

async function mounted(action: (root: Root) => Promise<void>) {
  const root = createRoot(fixture)
  try {
    await action(root)
  } finally {
    flushSync(() => root.unmount())
    await settle()
  }
}

type Harness = {
  requested: Array<SettingsSection | null>
  navigation: AppScreen[]
  render: (input: {
    role: string
    adminSurface?: boolean
    settingsRequest?: SettingsSection | null
  }) => void
}

function harness(root: Root): Harness {
  const requested: Array<SettingsSection | null> = []
  const navigation: AppScreen[] = []
  const render = (input: {
    role: string
    adminSurface?: boolean
    settingsRequest?: SettingsSection | null
  }) => {
    flushSync(() => {
      root.render(
        <AppShell
          screen={input.adminSurface ? "supplier-dbs" : "home"}
          onScreenChange={(screen) => navigation.push(screen)}
          adminSurface={input.adminSurface ?? false}
          settingsRequest={input.settingsRequest ?? null}
          onSettingsRequestChange={(section) => {
            requested.push(section)
          }}
          overview={overview(input.role)}
          onSignedOut={() => {}}
          notifications={noNotifications}
        >
          <label>业务草稿<input aria-label="业务草稿" defaultValue="未保存内容" /></label>
        </AppShell>,
      )
    })
  }
  return { requested, navigation, render }
}

async function shellSearchSupportsKeyboardNavigation() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    const trigger = await waitFor<HTMLButtonElement>('[aria-label="搜索页面"]')
    trigger.click()
    const input = await waitFor<HTMLInputElement>('[role="combobox"][aria-label="搜索页面名称"]')
    const selected = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent?.trim()
    check(selected()?.includes(SCREEN_LABELS.home), "the first destination is selected")
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await settle()
    check(selected()?.includes(SCREEN_LABELS.catalog), "ArrowDown selects the next destination")
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()
    check(h.navigation.at(-1) === "catalog", "Enter opens the selected destination")
    await waitForDialogToClose()

    trigger.click()
    const reopened = await waitFor<HTMLInputElement>('[role="combobox"][aria-label="搜索页面名称"]')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    check(setValue, "the input has a native value setter")
    setValue.call(reopened, "ozon")
    reopened.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    check(document.querySelectorAll('[role="listbox"] [role="option"]').length === 1, "search ignores case")
    const close = await waitFor<HTMLButtonElement>('[data-slot="dialog-content"] [aria-label="关闭"]')
    close.click()
    await waitForDialogToClose()
    trigger.click()
    const fresh = await waitFor<HTMLInputElement>('[role="combobox"][aria-label="搜索页面名称"]')
    check(fresh.value === "", "closing the switcher clears its search")
  })
}

async function settingsTransitionsKeepNavigationIntact() {
  const original = Object.getOwnPropertyDescriptor(document, "startViewTransition")
  let transitions = 0
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => void) => { transitions += 1; update(); return {} },
  })
  try {
    await mounted(async (root) => {
      const h = harness(root)
      h.render({ role: "super_admin" })
      check(!document.querySelector('[data-sidebar="footer"] [aria-label="设置"]'), "the footer has no separate settings button")
      await chooseAccountDestination("设置")
      await waitFor("[data-settings-page]")
      const appearance = await waitFor<HTMLButtonElement>('[aria-label="外观"]')
      appearance.click()
      const activeAppearance = await waitFor<HTMLButtonElement>('[aria-label="外观"][aria-current="page"]')
      activeAppearance.click()
      await settle()
      check(Number(transitions) === 2, "selecting the current setting does not replay the transition")
      const currentScreen = await waitFor<HTMLButtonElement>(`[data-sidebar="content"] [aria-label="${SCREEN_LABELS.home}"]`)
      currentScreen.click()
      await settle()
      check(!document.querySelector("[data-settings-page]"), "returning to the current screen closes settings")
      check(h.navigation.at(-1) === "home", "the destination remains intact")
      check(transitions === 3, "opening, switching and closing settings each transition once")
    })
  } finally {
    if (original) Object.defineProperty(document, "startViewTransition", original)
    else Reflect.deleteProperty(document, "startViewTransition")
  }
}

/**
 * Mount the real entry point at a real address. `replaceState` is how the page
 * borrows `/admin`: the path is the boundary under test, so it cannot be faked
 * with a prop.
 */
async function atPath(pathname: string, role: string, examine: () => Promise<void>) {
  await mounted(async (root) => {
    window.history.replaceState(null, "", pathname)
    try {
      flushSync(() => {
        root.render(
          <AuthenticatedApp
            overview={overview(role)}
            onOverviewChange={() => {}}
            onSignedOut={() => {}}
          />,
        )
      })
      await examine()
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })
}

/**
 * 设置 is a row in the footer card's menu: open the account trigger
 * first, then choose the destination by its text.
 */
async function chooseAccountDestination(name: string) {
  const trigger = await waitFor<HTMLButtonElement>('[data-sidebar="footer"] [aria-haspopup="menu"]')
  trigger.click()
  const menu = await waitFor('[data-slot="dropdown-menu-content"]')
  check(!menu.textContent?.includes("创建工作空间"), "the account menu does not offer workspace creation")
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    const row = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => (item.textContent ?? "").trim() === name,
    )
    if (row) {
      row.click()
      return
    }
    await frame()
  }
  throw new Error(`the account menu never offered ${name}; saw ${menu.textContent}`)
}

/** The rail row opens the pane by naming it; the caller owns `?settings=`. */
async function railRowRequestsThePane() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin", adminSurface: true })
    await chooseAccountDestination("设置")
    await waitUntil(() => h.requested.includes("account"), "the account menu never requested account settings")
    check(h.requested.includes("account"), "the account menu requests account settings")
    h.requested.length = 0
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "appearance" })
    const row = await waitFor<HTMLButtonElement>('[aria-label="支付"]')
    check(!row.closest("[hidden]"), "the platform group is visible before selecting payment")
    row.click()
    const deadline = performance.now() + 3000
    while (h.requested.length === 0 && performance.now() < deadline) await frame()
    check(
      h.requested.length === 1 && h.requested[0] === "payment",
      `expected one request for payment, got ${JSON.stringify(h.requested)}`,
    )
  })
}

/** A `?settings=` the surface accepted really opens the page. */
async function settingsRequestOpensThePage() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "appearance" })
    await waitFor('[data-settings-page]')
    await waitForText('[data-settings-page]', "本机主题")
    if (!matchMedia("(max-width: 767px)").matches) {
      const navigation = await waitFor<HTMLElement>(".settings-navigation")
      await settle()
      check(Math.abs(navigation.getBoundingClientRect().width - 208) < 2, "settings navigation uses the narrower width")
    }
    check(!document.querySelector('[data-slot="dialog-content"]'), "settings must be an inline page")
    check(Boolean(document.querySelector('[aria-label="主导航"]')), "settings keep business navigation available")
    check(!document.querySelector('[aria-label="主导航"] [aria-current="page"]'), "the previous business page is not current")
    const back = await waitFor<HTMLButtonElement>('[aria-label="返回业务页面"]')
    back.click()
    await waitUntil(() => h.requested.at(-1) === null, "return never cleared the settings request")
    check(h.requested.at(-1) === null, "return clears the URL-owned settings request")
  })
}

async function returnPreservesBusinessPage() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    const original = await waitFor<HTMLInputElement>('[aria-label="业务草稿"]')
    original.value = "保留尚未保存的输入"
    await chooseAccountDestination("设置")
    await waitFor('[data-settings-page]')
    check(Boolean(document.querySelector('[aria-label="主导航"]')), "settings keep the main menu")
    check(!document.querySelector('[aria-label="主导航"] [aria-current="page"]'), "the hidden business page is not current")
    check(Boolean(original.closest('[hidden][inert]')), "business content is hidden and inert")
    const appearance = await waitFor<HTMLButtonElement>('[aria-label="设置分区"] [aria-label="外观"]')
    appearance.click()
    await waitForText('[data-settings-page]', "本机主题")
    const back = await waitFor<HTMLButtonElement>('[aria-label="返回业务页面"]')
    back.click()
    await waitUntil(() => !document.querySelector('[data-settings-page]'), "return never left settings")
    check(!document.querySelector('[data-settings-page]'), "return leaves settings")
    check(original === document.querySelector('[aria-label="业务草稿"]'), "return must not remount the business page")
    check(original.value === "保留尚未保存的输入", "return preserves unsaved form values")
    check(!original.closest('[hidden]'), "return makes the original page visible")
  })
}

async function shellHeaderTracksTheCurrentPage() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin", adminSurface: true })
    const breadcrumb = await waitFor<HTMLElement>('[aria-label="面包屑"]')
    check(breadcrumb.textContent?.includes("平台"), "the header names the current group")
    check(breadcrumb.textContent?.includes(SCREEN_LABELS["supplier-dbs"]), "the header names the current screen")
    check(getComputedStyle(breadcrumb).position !== "absolute", "the current path is visible")
    check(Boolean(document.querySelector('nav[aria-label="主导航"] [aria-current="page"]')), "the business page is selected in its navigation")
    const clock = await waitFor<HTMLTimeElement>(".shell-date")
    const initialTime = clock.dateTime
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(initialTime), "the clock includes a numeric date and seconds")
    check(clock.textContent === initialTime.replace("T", " "), "the visible clock matches its machine-readable time")
    await waitUntil(() => clock.dateTime !== initialTime, "the clock did not update")
    const store = await waitFor<HTMLButtonElement>('[aria-label="店铺管理"]')
    store.click()
    check(h.navigation.at(-1) === "stores", "the store shortcut opens the real stores screen")
    const header = document.querySelector('[data-sidebar="header"]')
    check(!header?.textContent?.includes("PodHub") && !header?.querySelector('img[src="/app-icon.svg"]'), "the workspace selector does not repeat the brand")
    const account = await waitFor<HTMLButtonElement>('[data-sidebar="footer"] [aria-haspopup="menu"]')
    account.click()
    const menu = await waitFor('[data-slot="dropdown-menu-content"]')
    check(!menu.textContent?.includes("批注页面"), "the account menu no longer offers page annotations")
    account.click()
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "account" })
    check(breadcrumb.textContent?.includes("设置"), "settings replaces the business breadcrumb")
    check(!document.querySelector('nav[aria-label="主导航"] [aria-current="page"]'), "settings does not leave a business row selected")
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "plans" })
    check(breadcrumb.textContent?.includes("设置") && breadcrumb.textContent?.includes("升级方案"), "the breadcrumb names the selected settings section")
  })
}

async function iconRailKeepsNamedGroups() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    const sidebar = await waitFor<HTMLElement>('[data-slot="sidebar"]')
    const wasExpanded = sidebar.getAttribute("data-collapsible") !== "icon"
    const mobile = matchMedia("(max-width: 767px)").matches
    if (!mobile && wasExpanded) (await waitFor<HTMLButtonElement>('[aria-label="折叠侧栏"]')).click()
    await waitFor('[data-slot="sidebar"][data-collapsible="icon"]')
    const groups = [...document.querySelectorAll<HTMLElement>('nav[aria-label="主导航"] [role="group"]')]
    check(groups.length > 0, "the business navigation has groups")
    for (const group of groups) {
      check(Boolean(group.getAttribute("aria-label")), "each icon group keeps its accessible name")
      const label = group.querySelector<HTMLElement>('[data-sidebar="group-label"]')
      check(label && getComputedStyle(label).display === "none", "the icon rail hides visual group labels")
    }
    if (!mobile) {
      const expand = await waitFor<HTMLButtonElement>('[aria-label="展开侧栏"]')
      expand.click()
      await waitFor('[data-slot="sidebar"][data-state="expanded"]')
      await settle()
      check(Math.abs(sidebar.getBoundingClientRect().width - 208) < 2, "the expanded menu uses the narrower width")
      for (const group of groups) {
        const label = group.querySelector<HTMLElement>('[data-sidebar="group-label"]')
        check(label && getComputedStyle(label).display !== "none", "expanded navigation shows group labels")
      }
      if (!wasExpanded) (await waitFor<HTMLButtonElement>('[aria-label="折叠侧栏"]')).click()
    }
  })
}

async function mobileStateFollowsMediaQuery() {
  const original = window.matchMedia
  let listener: ((event: MediaQueryListEvent) => void) | undefined
  window.matchMedia = (query) => query === "(max-width: 767px)" ? {
    matches: false,
    addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback },
    removeEventListener: () => {},
  } as unknown as MediaQueryList : original.call(window, query)
  function Probe() { return <output data-mobile-probe>{String(useIsMobile())}</output> }
  try {
    await mounted(async (root) => {
      flushSync(() => root.render(<Probe />))
      await settle()
      check(document.querySelector("[data-mobile-probe]")?.textContent === "false", "initial state uses the query match")
      listener?.({ matches: true } as MediaQueryListEvent)
      await settle()
      check(document.querySelector("[data-mobile-probe]")?.textContent === "true", "the media query event controls mobile state")
      listener?.({ matches: false } as MediaQueryListEvent)
      await settle()
      check(document.querySelector("[data-mobile-probe]")?.textContent === "false", "the mobile state returns to desktop")
    })
  } finally {
    window.matchMedia = original
  }
}

async function settingsGroupsStayExpanded() {
  await mounted(async (root) => {
    const rows = settingsRowsFor("super_admin")
    const render = (pane: SettingsSection) => {
      flushSync(() => root.render(
        <SidebarProvider>
          <SettingsNavigation rows={rows} pane={pane} onSelect={render} />
        </SidebarProvider>,
      ))
    }
    const group = (label: string) => document.querySelector<HTMLElement>(`[data-settings-group="${label}"]`)
    const current = () => document.querySelector<HTMLElement>('[aria-label="设置分区"] [aria-current="page"]')
    const visible = (element: HTMLElement | null) => Boolean(element && !element.closest("[hidden]"))

    for (const [pane, label] of [["account", "账号"], ["plans", "升级方案"], ["ai-accounts", "AI 账号"]] as const) {
      render(pane)
      for (const name of ["个人", "工作空间", "平台管理"]) {
        const heading = group(name)
        check(visible(heading) && heading?.tagName !== "BUTTON" && !heading?.hasAttribute("aria-expanded"), `${name} is a non-collapsible heading`)
      }
      for (const row of rows) {
        check(visible(document.querySelector<HTMLElement>(`[aria-label="设置分区"] [aria-label="${row.label}"]`)), `${row.label} remains visible`)
      }
      check(current()?.getAttribute("aria-label") === label, `${label} is the current item`)
    }
    document.querySelector<HTMLButtonElement>('[aria-label="设置分区"] [aria-label="账号"]')?.click()
    await settle()
    check(current()?.getAttribute("aria-label") === "账号", "selecting a different group keeps navigation working")
  })
}

async function directoryFailureIsNotAnEmptyDirectory() {
  const original = adminHttp.adminListUsers
  try {
    adminHttp.adminListUsers = async () => { throw Object.assign(new Error("需要超级管理员权限"), { code: "cloud_forbidden" }) }
    await mounted(async (root) => {
      const h = harness(root)
      h.render({ role: "super_admin", adminSurface: true, settingsRequest: "users" })
      const text = await waitForText('[data-settings-page]', "无法加载平台账户")
      check(text.includes("需要超级管理员权限"), "the server refusal must stay actionable")
      check(!text.includes("暂无平台账户"), "a failed read must not look like an empty directory")
      const create = await waitFor<HTMLButtonElement>('[data-settings-page] button:disabled')
      check(create.getAttribute("aria-label") === "创建账户", "creation stays disabled until the directory loads")
      check(!document.querySelector('[aria-label="设置分区"] input'), "settings search was removed")
      adminHttp.adminListUsers = async () => ({ user_count: 0, workspace_count: 0, workspaces: [], unaffiliated: [] })
      const retry = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-page] button')].find((button) => button.textContent === "重试")
      check(retry, "failed reads offer a retry")
      retry.click()
      await waitForText('[data-settings-page]', "暂无平台账户")
    })
  } finally {
    adminHttp.adminListUsers = original
  }
}

async function systemAccountRemainsViewableButReadOnly() {
  const original = adminHttp.adminListUsers
  try {
    adminHttp.adminListUsers = async () => ({
      user_count: 1,
      workspace_count: 0,
      workspaces: [],
      unaffiliated: [{
        account_kind: "platform", uuid: "system-account", name: "系统账户", email: "admin@example.invalid",
        role: "super_admin", role_label: "超级管理员", kind: "super_admin", is_admin: true,
        disabled: false, status: "active", editable: false, manageable: false, created_at: "",
      }],
    })
    await mounted(async (root) => {
      const h = harness(root)
      h.render({ role: "super_admin", adminSurface: true, settingsRequest: "users" })
      const view = await waitFor<HTMLButtonElement>('[aria-label="查看账号"]')
      check(!view.disabled, "a read-only system account can still be inspected")
      view.click()
      await waitForText('[aria-labelledby="user-editor-title"]', "系统只读")
      const toggle = await waitFor<HTMLElement>('[aria-label="账户启用状态"]')
      check(toggle.getAttribute("aria-disabled") === "true", "a system account cannot be enabled or disabled")
      check(![...document.querySelectorAll("button")].some((button) => button.textContent === "保存更改"), "a system account cannot be saved")
    })
  } finally {
    adminHttp.adminListUsers = original
  }
}

/** A pane this rank may not open refuses instead of painting 账号. */
async function refusedPaneNeverMounts() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "admin", adminSurface: true, settingsRequest: "payment" })
    await waitFor('[data-settings-page]')
    const text = await waitForText('[data-settings-page]', "没有权限打开该设置")
    check(!text.includes("用于登录此控制台并接收提醒"), "账号 must not replace the refused pane")
    check(!text.includes("支付"), "a refused pane must not leak its section name")
  })
}

/** The workbench never grows the admin rail. */
async function workbenchHasNoRail() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    await waitFor('[aria-label="主导航"]')
    check(
      !document.querySelector('[aria-label="支付"]'),
      "the workbench must not paint the admin rail",
    )
  })
}

async function adminPathMountsTheSurface() {
  await atPath("/admin?screen=supplier-dbs", "super_admin", async () => {
    await waitFor(adminScreenSelector)
    await waitFor('[aria-label="主导航"]')
    check(
      !document.querySelector('[aria-label="导航模式"]'),
      "one mode leaves nothing to switch between",
    )
    check(window.location.pathname === "/admin", "the surface keeps its address")
    check(
      window.location.search.includes("screen=supplier-dbs"),
      "the address still names the screen",
    )
  })
}

async function adminPathRefusesNonStaff() {
  await atPath("/admin", "user", async () => {
    await waitFor('[data-admin-surface="forbidden"]')
    check(
      !document.querySelector('[data-slot="sidebar-wrapper"]'),
      "the refusal paints no shell",
    )
  })
}

async function unknownAdminScreenFallsBack() {
  await atPath("/admin?screen=console", "super_admin", async () => {
    await waitFor(adminScreenSelector)
    check(
      !document.querySelector('[aria-label="导航模式"]'),
      "the fallback still paints one mode",
    )
    check(
      new URLSearchParams(window.location.search).get("screen") ===
        defaultAdminScreen(),
      `the address is rewritten to what is painted, saw ${window.location.search}`,
    )
  })
}

async function unknownSettingsParamIsDropped() {
  await atPath("/admin?settings=nope", "super_admin", async () => {
    await waitFor('[aria-label="主导航"]')
    check(
      !document.querySelector('[data-settings-page]'),
      "an unknown settings id opens nothing",
    )
    check(
      !window.location.search.includes("settings="),
      `the address stops naming a pane that never opened, saw ${window.location.search}`,
    )
  })
}

async function settingsParamOpensThePage() {
  await atPath("/admin?settings=appearance", "super_admin", async () => {
    await waitFor('[data-settings-page]')
    await waitForText('[data-settings-page]', "本机主题")
  })
}

async function settingsParamRefusesASuperAdminPane() {
  await atPath("/admin?settings=payment", "admin", async () => {
    await waitFor('[data-settings-page]')
    const text = await waitForText('[data-settings-page]', "没有权限打开该设置")
    check(!text.includes("支付"), "a refused pane must not leak its section name")
  })
}

async function longPopoverStaysUsable() {
  await mounted(async (root) => {
    flushSync(() => root.render(<Popover>
      <PopoverTrigger render={<button type="button">打开列表</button>} />
      <PopoverContent aria-label="长列表">
        {Array.from({ length: 50 }, (_, index) => <button key={index} type="button" className="block min-h-11 w-full text-left">选项 {index + 1}</button>)}
      </PopoverContent>
    </Popover>))
    const trigger = await waitFor<HTMLButtonElement>('[data-slot="popover-trigger"]')
    trigger.click()
    const popup = await waitFor<HTMLElement>('[aria-label="长列表"]')
    await settle()
    const rect = popup.getBoundingClientRect()
    check(rect.top >= -1 && rect.bottom <= window.innerHeight + 1, "the popover fits the viewport")
    check(popup.scrollHeight > popup.clientHeight, "long popover content scrolls")
    const last = popup.querySelector<HTMLButtonElement>("button:last-child")!
    last.focus()
    await settle()
    const lastRect = last.getBoundingClientRect()
    check(document.activeElement === last && lastRect.bottom <= popup.getBoundingClientRect().bottom + 1, "keyboard focus can reach the last action")
  })
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  delete results.dataset.result
  unexpectedRequests.length = 0
  const checks: Array<[string, () => Promise<void>]> = [
    ["page switcher supports keyboard and resets search", shellSearchSupportsKeyboardNavigation],
    ["settings transitions preserve navigation", settingsTransitionsKeepNavigationIntact],
    ["rail row requests the pane", railRowRequestsThePane],
    ["settingsRequest opens the page", settingsRequestOpensThePage],
    ["return preserves the original business page", returnPreservesBusinessPage],
    ["header follows the real page and store destination", shellHeaderTracksTheCurrentPage],
    ["icon navigation hides visual labels but keeps named groups", iconRailKeepsNamedGroups],
    ["mobile layout follows media query events", mobileStateFollowsMediaQuery],
    ["settings groups stay expanded", settingsGroupsStayExpanded],
    ["long popovers fit and scroll", longPopoverStaysUsable],
    ["failed directory reads stay distinct from an empty directory", directoryFailureIsNotAnEmptyDirectory],
    ["system account stays viewable but read-only", systemAccountRemainsViewableButReadOnly],
    ["a refused pane never mounts", refusedPaneNeverMounts],
    ["the workbench has no admin rail", workbenchHasNoRail],
    ["/admin mounts the surface", adminPathMountsTheSurface],
    ["/admin refuses a non-staff session", adminPathRefusesNonStaff],
    ["an unknown screen falls back", unknownAdminScreenFallsBack],
    ["an unknown settings id is dropped", unknownSettingsParamIsDropped],
    ["?settings= opens the requested page", settingsParamOpensThePage],
    ["a super_admin pane refuses for admin", settingsParamRefusesASuperAdminPane],
  ]
  const lines: string[] = []
  const filter = new URLSearchParams(window.location.search).get("check")
  for (const [name, test] of checks.filter(([name]) => !filter || name.includes(filter))) {
    try {
      await test()
      lines.push(`PASS ${name}`)
    } catch (error) {
      lines.push(`FAIL ${name}: ${String(error)}`)
    }
    results.textContent = lines.join("\n")
    await settle()
  }
  if (unexpectedRequests.length) {
    lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
  }
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL"))
    ? "failed"
    : "passed"
  run.disabled = false
}

/* `?autorun=1` lets a headless browser run the same checks unattended. */
if (new URLSearchParams(window.location.search).get("autorun") === "1") {
  run.click()
}
