import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { AuthenticatedApp } from "@/app/authenticated-app"
import type { AccountOverview } from "@/bindings/commands"
import { AppShell } from "@/app/app-shell"
import { adminHttp } from "@/bindings/http-admin"
import type { NotificationsController } from "@/features/notifications/notifications"
import { defaultAdminScreen } from "@/lib/admin-surface"
import { SCREEN_LABELS } from "@/lib/app-screens"
import type { SettingsSection } from "@/lib/settings-sections"
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

const overview = (role: string): AccountOverview =>
  ({
    session: { authenticated: true, email: "admin@example.invalid", name: "管理", role },
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
  render: (input: {
    role: string
    adminSurface?: boolean
    settingsRequest?: SettingsSection | null
  }) => void
}

function harness(root: Root): Harness {
  const requested: Array<SettingsSection | null> = []
  const render = (input: {
    role: string
    adminSurface?: boolean
    settingsRequest?: SettingsSection | null
  }) => {
    flushSync(() => {
      root.render(
        <AppShell
          screen={input.adminSurface ? "supplier-dbs" : "console"}
          onScreenChange={() => {}}
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
  return { requested, render }
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
            onAddAccount={() => {}}
          />,
        )
      })
      await examine()
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })
}

/** The rail row opens the pane by naming it; the caller owns `?settings=`. */
async function railRowRequestsThePane() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin", adminSurface: true })
    const gear = await waitFor<HTMLButtonElement>('[aria-label="设置"]')
    gear.click()
    check(h.requested.includes("account"), "the gear requests account settings")
    h.requested.length = 0
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "appearance" })
    const row = await waitFor<HTMLButtonElement>('[aria-label="对象存储"]')
    row.click()
    const deadline = performance.now() + 3000
    while (h.requested.length === 0 && performance.now() < deadline) await frame()
    check(
      h.requested.length === 1 && h.requested[0] === "media",
      `expected one request for media, got ${JSON.stringify(h.requested)}`,
    )
  })
}

/** A `?settings=` the surface accepted really opens the page. */
async function settingsRequestOpensThePage() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin", adminSurface: true, settingsRequest: "appearance" })
    await waitFor('[data-settings-page]')
    await waitForText('[data-settings-page]', "界面主题")
    check(!document.querySelector('[data-slot="dialog-content"]'), "settings must be an inline page")
    check(!document.querySelector('[aria-label="主导航"]'), "settings replace business navigation")
    const back = await waitFor<HTMLButtonElement>('[aria-label="返回业务页面"]')
    back.click()
    check(h.requested.at(-1) === null, "return clears the URL-owned settings request")
  })
}

async function returnPreservesBusinessPage() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    const original = await waitFor<HTMLInputElement>('[aria-label="业务草稿"]')
    original.value = "保留尚未保存的输入"
    const gear = await waitFor<HTMLButtonElement>('[aria-label="设置"]')
    gear.click()
    await waitFor('[data-settings-page]')
    check(!document.querySelector('[aria-label="主导航"]'), "settings replace the main menu")
    check(Boolean(original.closest('[hidden][inert]')), "business content is hidden and inert")
    const appearance = await waitFor<HTMLButtonElement>('[aria-label="设置分区"] [aria-label="外观"]')
    appearance.click()
    await waitForText('[data-settings-page]', "界面主题")
    const back = await waitFor<HTMLButtonElement>('[aria-label="返回业务页面"]')
    back.click()
    await waitFor('[aria-label="主导航"]')
    check(!document.querySelector('[data-settings-page]'), "return leaves settings")
    check(original === document.querySelector('[aria-label="业务草稿"]'), "return must not remount the business page")
    check(original.value === "保留尚未保存的输入", "return preserves unsaved form values")
    check(!original.closest('[hidden]'), "return makes the original page visible")
  })
}

async function directoryFailureIsNotAnEmptyDirectory() {
  const original = adminHttp.adminListUsers
  try {
    adminHttp.adminListUsers = async () => { throw Object.assign(new Error("请先绑定验证器"), { code: "cloud_forbidden" }) }
    await mounted(async (root) => {
      const h = harness(root)
      h.render({ role: "super_admin", adminSurface: true, settingsRequest: "users" })
      const text = await waitForText('[data-settings-page]', "无法加载平台账户")
      check(text.includes("请先绑定验证器"), "the server refusal must stay actionable")
      check(!text.includes("暂无平台账户"), "a failed read must not look like an empty directory")
      const create = await waitFor<HTMLButtonElement>('[data-settings-page] button:disabled')
      check(create.textContent?.includes("创建账户"), "creation stays disabled until the directory loads")
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

/** A pane this rank may not open refuses instead of painting 账号. */
async function refusedPaneNeverMounts() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "admin", adminSurface: true, settingsRequest: "media" })
    await waitFor('[data-settings-page]')
    const text = await waitForText('[data-settings-page]', "没有权限打开该设置")
    check(!text.includes("用于登录此控制台并接收提醒"), "账号 must not replace the refused pane")
    check(!text.includes("对象存储"), "a refused pane must not leak its section name")
  })
}

/** The workbench never grows the admin rail. */
async function workbenchHasNoRail() {
  await mounted(async (root) => {
    const h = harness(root)
    h.render({ role: "super_admin" })
    await waitFor('[aria-label="主导航"]')
    check(
      !document.querySelector('[aria-label="对象存储"]'),
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
    await waitForText('[data-settings-page]', "界面主题")
  })
}

async function settingsParamRefusesASuperAdminPane() {
  await atPath("/admin?settings=media", "admin", async () => {
    await waitFor('[data-settings-page]')
    const text = await waitForText('[data-settings-page]', "没有权限打开该设置")
    check(!text.includes("对象存储"), "a refused pane must not leak its section name")
  })
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  delete results.dataset.result
  unexpectedRequests.length = 0
  const checks: Array<[string, () => Promise<void>]> = [
    ["rail row requests the pane", railRowRequestsThePane],
    ["settingsRequest opens the page", settingsRequestOpensThePage],
    ["return preserves the original business page", returnPreservesBusinessPage],
    ["failed directory reads stay distinct from an empty directory", directoryFailureIsNotAnEmptyDirectory],
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
  for (const [name, test] of checks) {
    try {
      await test()
      lines.push(`PASS ${name}`)
    } catch (error) {
      lines.push(`FAIL ${name}: ${String(error)}`)
    }
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
