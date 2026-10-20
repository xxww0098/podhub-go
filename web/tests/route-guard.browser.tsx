import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { AuthenticatedApp } from "@/app/authenticated-app"
import type { AccountOverview } from "@/bindings/commands"
import { SCREEN_LABELS } from "@/lib/app-screens"
import { installAddressSync } from "@/lib/address"
import "../src/index.css"

/**
 * The route guards, mounted at real addresses.
 *
 * Every check drives the real entry point through `replaceState`, so what is
 * asserted is the address, the painted pane and the traffic the pane caused —
 * not a prop. The patch of ground here is the one the unit tests cannot cover:
 * React effects, lazy panes and the address store working together.
 */
/** A full document navigation would re-run this module and bump the count. */
;(window as unknown as { __routeGuardLoads?: number }).__routeGuardLoads =
  ((window as unknown as { __routeGuardLoads?: number }).__routeGuardLoads ?? 0) + 1

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!

/** Nothing in this harness needs Cloud: every request is recorded and refused. */
const requested: string[] = []
window.fetch = async (input) => {
  requested.push(String(input))
  throw new Error("route-guard harness has no Cloud")
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => {
  await frame()
  await frame()
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function waitFor<T extends Element>(selector: string, timeoutMs = 6000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const found = document.querySelector<T>(selector)
    if (found) return found
    if (performance.now() > deadline) {
      throw new Error("timed out waiting for " + selector + "; saw " + document.body.textContent?.slice(0, 200))
    }
    await frame()
  }
}

async function waitForGone(selector: string, timeoutMs = 6000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (document.querySelector(selector)) {
    if (performance.now() > deadline) throw new Error("timed out waiting for " + selector + " to go away")
    await frame()
  }
}

async function waitForScreen(screen: keyof typeof SCREEN_LABELS, timeoutMs = 6000): Promise<void> {
  await waitFor("[aria-label=\"" + SCREEN_LABELS[screen] + "\"]", timeoutMs)
}

async function waitForSearch(expected: string, timeoutMs = 6000): Promise<string> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const search = window.location.search
    if (new URLSearchParams(search).get("screen") === expected) return search
    if (performance.now() > deadline) {
      throw new Error("the address still says " + search + ", expected screen=" + expected)
    }
    await frame()
  }
}

const overview = (role: string, accountMode = "owner"): AccountOverview =>
  ({
    session: { authenticated: true, email: "guard@example.invalid", name: "守卫", role },
    active_workspace: {
      id: 1,
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "示例工作空间",
      plan: "pro",
      role: "owner",
      is_owned: true,
    },
    workspaces: [],
    account_mode: accountMode,
    owned_count: accountMode === "unaffiliated" ? 0 : 1,
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

async function atPath(
  pathname: string,
  examine: () => Promise<void>,
  options: { role?: string; accountMode?: string } = {},
) {
  await mounted(async (root) => {
    window.history.replaceState(null, "", pathname)
    try {
      flushSync(() => {
        root.render(
          <AuthenticatedApp
            overview={overview(options.role ?? "super_admin", options.accountMode)}
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

/** A plain account cannot reach the staff module by URL, and does not read it. */
async function plainAccountCannotAddressTheStaffScreen() {
  await atPath("/?screen=supplier-dbs", async () => {
    await waitForSearch("console")
    await waitForScreen("console")
    check(!document.querySelector("[data-supplier-dbs]"), "the staff module must not mount")
    check(
      !requested.some((url) => url.includes("supplier-dbs")),
      "the staff API must not be read: " + requested.join(", "),
    )
  }, { role: "user" })
}

/** 列表管理 has exactly one address, and it is on the admin surface. */
async function staffOnlyScreenHasNoWorkbenchAddress() {
  await atPath("/?screen=supplier-dbs", async () => {
    await waitForSearch("console")
    await waitForScreen("console")
    check(!document.querySelector("[data-supplier-dbs]"), "the staff module must not mount")
  }, { role: "super_admin" })
}

/** The URL is the boundary: no Workspace standing may take the surface away. */
async function workspaceStandingDoesNotHijackTheAdminSurface() {
  await atPath("/admin", async () => {
    await waitForScreen("supplier-dbs")
    check(
      !document.querySelector("[data-admin-surface=\"forbidden\"]"),
      "platform staff are not refused /admin",
    )
  }, { role: "admin", accountMode: "unaffiliated" })
}

/** An address the shell did not author still repaints: the URL is the router. */
async function addressChangeRepaintsTheSurface() {
  const stop = installAddressSync()
  try {
    await atPath("/admin?screen=supplier-dbs&settings=appearance", async () => {
      await waitFor("[data-slot=\"dialog-content\"]")
      window.history.replaceState(null, "", "/admin?screen=supplier-dbs")
      window.dispatchEvent(new PopStateEvent("popstate"))
      await waitForGone("[data-slot=\"dialog-content\"]")
      check(
        document.querySelector("[data-slot=\"dialog-content\"]") === null,
        "dropping ?settings= closes the sheet",
      )
    })
  } finally {
    stop()
  }
}

/** A nav click rewrites the address in place; the shell follows the address. */
async function navClickNavigatesInPlace() {
  await atPath("/?screen=console", async () => {
    await waitForScreen("console")
    // The breadcrumb also marks its last segment current, so the question
    // "which destination is current" is asked of the rail, not the document.
    const railCurrent = () =>
      document.querySelector(
        '[data-slot="sidebar-content"] [aria-current="page"]',
      )?.getAttribute("aria-label")
    check(
      railCurrent() === SCREEN_LABELS.console,
      "console starts current, saw " + railCurrent(),
    )
    const row = document.querySelector<HTMLButtonElement>(
      '[aria-label="' + SCREEN_LABELS.products + '"]',
    )
    check(row, "the 店铺商品 nav row must be painted")
    row.click()
    await waitForSearch("products")
    const deadline = performance.now() + 6000
    while (railCurrent() !== SCREEN_LABELS.products && performance.now() < deadline) {
      await frame()
    }
    check(
      railCurrent() === SCREEN_LABELS.products,
      "the click moves the current row, saw " + railCurrent(),
    )
    check(
      document.querySelectorAll('[data-slot="sidebar-content"] [aria-current="page"]')
        .length === 1,
      "exactly one destination is current",
    )
    check(
      (window as unknown as { __routeGuardLoads?: number }).__routeGuardLoads === 1,
      "an in-shell jump must not reload the document",
    )
  })
}

/** 批量上架 homepage must not keep catalog leftovers in the address. */
async function listingHomepageDropsCatalogLeftovers() {
  const stop = installAddressSync()
  try {
    await atPath("/?screen=listing&product=scp_1&q=hat", async () => {
      await waitForSearch("listing")
      const deadline = performance.now() + 6000
      while (
        new URLSearchParams(window.location.search).has("product") &&
        performance.now() < deadline
      ) {
        await frame()
      }
      const params = new URLSearchParams(window.location.search)
      check(
        params.get("screen") === "listing" && !params.has("product") && !params.has("q"),
        "listing homepage leaked catalog params, saw " + window.location.search,
      )
    })
  } finally {
    stop()
  }
}

/** 平台货源 detail is in-module: leaving and returning must land on the gallery. */
async function catalogProductDoesNotSurviveNav() {
  await atPath("/?screen=catalog&product=scp_1", async () => {
    await waitForSearch("catalog")
    check(
      new URLSearchParams(window.location.search).get("product") === "scp_1",
      "a catalog deep link keeps product=, saw " + window.location.search,
    )
    const consoleRow = document.querySelector<HTMLButtonElement>(
      '[aria-label="' + SCREEN_LABELS.console + '"]',
    )
    check(consoleRow, "the 数据大屏 nav row must be painted")
    consoleRow.click()
    await waitForSearch("console")
    check(
      !new URLSearchParams(window.location.search).has("product"),
      "leaving catalog leaked product=, saw " + window.location.search,
    )
    const catalogRow = document.querySelector<HTMLButtonElement>(
      '[aria-label="' + SCREEN_LABELS.catalog + '"]',
    )
    check(catalogRow, "the 平台货源 nav row must be painted")
    catalogRow.click()
    await waitForSearch("catalog")
    check(
      !new URLSearchParams(window.location.search).has("product"),
      "returning to catalog restored product=, saw " + window.location.search,
    )
  })
}

/** StrictMode double-invokes every effect: an address rewrite must settle. */
async function strictModeSettlesTheAddress() {
  const root = createRoot(fixture)
  try {
    window.history.replaceState(null, "", "/?screen=supplier-dbs")
    flushSync(() => {
      root.render(
        <StrictMode>
          <AuthenticatedApp
            overview={overview("user")}
            onOverviewChange={() => {}}
            onSignedOut={() => {}}
            onAddAccount={() => {}}
          />
        </StrictMode>,
      )
    })
    await waitForSearch("console")
    await waitForScreen("console")
    await settle()
    await settle()
    check(
      window.location.search === "?screen=console",
      "the address settles on what is painted, saw " + window.location.search,
    )
    check(
      !requested.some((url) => url.includes("supplier-dbs")),
      "the staff API must not be read: " + requested.join(", "),
    )
  } finally {
    flushSync(() => root.unmount())
    window.history.replaceState(null, "", "/")
    await settle()
  }
}

/** 平台管理员 runs 货源管理 on /admin and never sees the super-only rail. */
async function platformAdminUsesTheMainMenuSurface() {
  await atPath("/admin", async () => {
    await waitForScreen("supplier-dbs")
    check(
      !document.querySelector('[data-admin-surface="forbidden"]'),
      "平台管理员 is not refused /admin",
    )
    check(
      document.querySelector('[aria-label="对象存储"]') === null,
      "the platform-management rail stays off a 平台管理员 shell",
    )
  }, { role: "admin" })
}

/** 设置里的平台管理 is a super_admin surface; the sheet must not offer it. */
async function settingsSheetOffersPlatformManagementByRank() {
  for (const [role, expected] of [["admin", false], ["super_admin", true]] as const) {
    await atPath("/?screen=console", async () => {
      const gear = await waitFor<HTMLButtonElement>('[aria-label="设置"]')
      gear.click()
      const sheet = await waitFor('[data-slot="dialog-content"]')
      // The rail's own two facts: the group heading and its rows. A substring
      // search would collide with the 平台管理员 role label.
      const railGroups = () =>
        [...sheet.querySelectorAll('nav[aria-label="设置分区"] > div > p')].map((node) =>
          (node.textContent ?? "").trim(),
        )
      const railRows = () =>
        [...sheet.querySelectorAll('nav[aria-label="设置分区"] button')].map((node) =>
          (node.textContent ?? "").trim(),
        )
      const offers = () => railGroups().includes("平台管理")
      const deadline = performance.now() + 6000
      while (offers() !== expected && performance.now() < deadline) await frame()
      check(
        offers() === expected,
        role + " groups: " + railGroups().join(" / ") + " (平台管理 " + (expected ? "missing" : "leaked") + ")",
      )
      check(
        railRows().includes("对象存储") === expected,
        role + " platform panes: " + railRows().join(" / "),
      )
    }, { role })
  }
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  delete results.dataset.result
  requested.length = 0
  const checks: Array<[string, () => Promise<void>]> = [
    ["a plain account cannot address the staff screen", plainAccountCannotAddressTheStaffScreen],
    ["staff reach 列表管理 only through /admin", staffOnlyScreenHasNoWorkbenchAddress],
    ["Workspace standing does not hijack /admin", workspaceStandingDoesNotHijackTheAdminSurface],
    ["an address change repaints the surface", addressChangeRepaintsTheSurface],
    ["a nav click navigates in place", navClickNavigatesInPlace],
    ["catalog product does not survive a sidebar jump", catalogProductDoesNotSurviveNav],
    ["listing homepage drops catalog leftovers", listingHomepageDropsCatalogLeftovers],
    ["StrictMode settles the address", strictModeSettlesTheAddress],
    ["平台管理员 uses the main-menu platform surface", platformAdminUsesTheMainMenuSurface],
    ["设置里的平台管理 follows the rank", settingsSheetOffersPlatformManagementByRank],
  ]
  const lines: string[] = []
  for (const [name, test] of checks) {
    try {
      await test()
      lines.push("PASS " + name)
    } catch (error) {
      lines.push("FAIL " + name + ": " + String(error))
    }
    await settle()
  }
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  run.disabled = false
}

if (new URLSearchParams(window.location.search).get("autorun") === "1") {
  run.click()
}
