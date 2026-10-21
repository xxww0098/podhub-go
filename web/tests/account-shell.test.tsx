import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppShell } from "../src/app/app-shell"
import { SCREEN_LABELS } from "../src/lib/app-screens"
import { NAVIGATION } from "../src/lib/app-navigation"
import { adminSettingsRowsFor } from "../src/lib/settings-sections"
import { overview, ownerWorkspace, noNotifications } from "./account-fixtures"

test("AppShell exposes the whole 平台管理 surface only to staff, panes only to super_admin", () => {
  const adminHtml = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={{
        ...overview,
        session: { ...overview.session, role: "admin" },
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )
  const superHtml = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={{
        ...overview,
        session: { ...overview.session, role: "super_admin" },
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )
  const userHtml = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  // The staff mode (admin + super_admin) holds the 平台货源 rail; the settings
  // panes behind it stay super_admin-only and never enter the shell. The mode's
  // name belongs to the navigation authority, so it is read here, never spelled.
  const staffMode = NAVIGATION.admin.label
  assert.match(adminHtml, new RegExp(`aria-label="${staffMode}"`))
  assert.doesNotMatch(adminHtml, /aria-label="平台分区"/)
  assert.doesNotMatch(adminHtml, />集成</)
  assert.doesNotMatch(adminHtml, />兑换</)
  assert.match(adminHtml, /aria-label="导航模式"/)
  assert.match(adminHtml, /aria-label="工作台"/)
  assert.match(adminHtml, /aria-label="履约"/)
  assert.ok(
    adminHtml.indexOf('aria-label="工作台"') < adminHtml.indexOf('aria-label="履约"'),
    "nav modes are 工作台, 履约, then the staff mode",
  )
  assert.match(adminHtml, /aria-label="数据大屏"/)
  assert.doesNotMatch(superHtml, /aria-label="平台分区"/)
  assert.doesNotMatch(superHtml, />对象存储</)
  assert.doesNotMatch(userHtml, /aria-label="平台分区"/)
  assert.doesNotMatch(userHtml, />集成</)
  assert.doesNotMatch(userHtml, new RegExp(`aria-label="${staffMode}"`))

  const menuSource = readFileSync(
    new URL("../src/components/workspace-switcher.tsx", import.meta.url),
    "utf8",
  )
  /* Platform administration is a settings section now; the user menu carries
     no shortcut for it. */
  assert.doesNotMatch(menuSource, /onOpenPlatform/)
  assert.doesNotMatch(menuSource, />\s*super_admin\s*</)
  const shellSource = readFileSync(
    new URL("../src/app/app-shell.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(shellSource, /openSettings\("users"\)/)
  const settingsSource = readFileSync(
    new URL("../src/app/settings-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(settingsSource, /settingsRowsFor\(overview\?\.session\.role\)/)
  /* 代理 is a 平台管理 section only; 功能 no longer lists a pane that is empty
     for every non-Agent. The table lives in the React-free vocabulary module. */
  const sectionsSource = readFileSync(
    new URL("../src/lib/settings-sections.ts", import.meta.url),
    "utf8",
  )
  assert.match(sectionsSource, /id: "agents"/)
  assert.doesNotMatch(sectionsSource, /"agent"/)
})

test("AppShell titles the workspace menu with the active Workspace, not PlatformRole", () => {
  const superHtml = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={{
        ...overview,
        session: {
          ...overview.session,
          name: "李华",
          email: "li@pod.com",
          role: "super_admin",
        },
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )
  assert.match(superHtml, /aria-label="账户与 Workspace 示例工作空间，专业版，超级管理员"/)
  assert.doesNotMatch(superHtml, /aria-label="账户 超级管理员"/)
  assert.doesNotMatch(superHtml, /aria-label="账户 平台管理员"/)

  const adminHtml = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={{
        ...overview,
        session: {
          ...overview.session,
          name: "周敏",
          email: "zhou@pod.com",
          role: "admin",
        },
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )
  assert.match(adminHtml, /aria-label="账户与 Workspace 示例工作空间，专业版，平台管理员"/)
  assert.doesNotMatch(adminHtml, /aria-label="账户 平台管理员"/)
  // The trigger is the unified account+Workspace cell: it names the Workspace,
  // its plan, and the account's own platform rank — never the menu glyph.
  const menuLabel =
    adminHtml.match(/aria-label="账户与 Workspace[^"]*"/)?.[0] ?? ""
  assert.match(menuLabel, /示例工作空间/)
  assert.match(menuLabel, /平台管理员/)

  const menuSource = readFileSync(
    new URL("../src/components/workspace-switcher.tsx", import.meta.url),
    "utf8",
  )
  assert.match(menuSource, /账户与 Workspace/)
  assert.doesNotMatch(
    menuSource,
    /platformStaffRoleLabel\(session\?\.role\) \?\?/,
  )
  /* The merged menu names the Workspace, never the staff rank. */
  assert.doesNotMatch(menuSource, /staffLabel/)
})

test("AppShell keeps Workspace quota facts out of the sidebar footer", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={{
        ...overview,
        entitlement: overview.entitlement
          ? {
              ...overview.entitlement,
              limits: { ...overview.entitlement.limits, seats: 20, seats_used: 0 },
            }
          : undefined,
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  assert.doesNotMatch(html, /0\/20/)
  assert.doesNotMatch(html, /aria-label="工作空间用量"/)
  assert.match(html, /aria-label="外观：跟随系统，切换到浅色"/)
  // Collapse stays at the bottom of the footer cluster when the rail stacks.
  assert.match(html, /aria-label="折叠侧栏"/)
  assert.match(html, /group-data-\[collapsible=icon\]:order-last/)
})

test("AppShell reopens folded when folding was the last choice", () => {
  const items = new Map<string, string>([["podhub.sidebar-open", "false"]])
  const previousWindow = (globalThis as { window?: unknown }).window
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
      },
      // The theme cycle resolves "system" during render.
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
  })

  try {
    const html = renderToStaticMarkup(
      <AppShell
        screen="console"
        overview={overview}
        onScreenChange={() => {}}
        onSignedOut={() => {}}
        notifications={noNotifications}
      >
        <div />
      </AppShell>,
    )

    assert.match(html, /data-state="collapsed"/)
    assert.match(html, /aria-label="展开侧栏"/)
    assert.doesNotMatch(html, /aria-label="折叠侧栏"/)
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window")
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test("AppShell scrolls the canvas below the breadcrumb bar", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="console"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  assert.match(html, /h-svh overflow-hidden/)
  assert.match(html, /flex min-h-0 flex-1 flex-col overflow-hidden/)
  assert.match(html, /page-canvas /)
  assert.match(html, /flex h-11 shrink-0 items-center/)
  assert.match(html, /href="#main"/)
  assert.match(html, /id="main"/)
  assert.match(html, /跳到主内容/)
  assert.doesNotMatch(html, /sticky top-0 z-10 flex h-14/)
})

test("AppShell does not own the notification poll or 上架 progress state", () => {
  const source = readFileSync(
    new URL("../src/app/app-shell.tsx", import.meta.url),
    "utf8",
  )
  const app = readFileSync(
    new URL("../src/app/authenticated-app.tsx", import.meta.url),
    "utf8",
  )
  const chrome = readFileSync(new URL("../src/app/app-shell-chrome.tsx", import.meta.url), "utf8")
  assert.match(source, /ShellHeaderActivity/)
  assert.match(chrome, /function ShellHeaderActivity/)
  assert.match(chrome, /useWorkflowProgress\(\)/)
  assert.doesNotMatch(chrome, /useNotifications[(]/)
  assert.doesNotMatch(source, /useNotifications\(/)
  assert.doesNotMatch(app, /useNotifications\(/)
  assert.match(app, /NotificationsProvider/)
  assert.match(
    app,
    /const onInvitationAccepted = useCallback\(async \(\) => \{\s+onOverviewChange\(await accountHttp\.accountListWorkspaces\(\)\)/,
    "invitation acceptance must use Cloud's strict Workspace refresh",
  )
  assert.match(
    app,
    /await loadAccountOverview\(\{ force: true \}\)/,
    "ordinary overview refreshes force the cache then apply the latest peek",
  )
  assert.match(app, /peekAccountOverview\(\)/)
})

test("AppShell keeps Workspace destinations in the Workspace menu, not the account menu", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="stores"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  // 用量 is not a rail button; the header wallet badge opens it.
  assert.doesNotMatch(html, /<button[^>]*aria-label="用量"/)

  // Main menu has 数据大屏, 批量上架, 平台货源, 店铺商品 under 工作台. 消息 lives under 运维.
  assert.match(html, /aria-label="数据大屏"/)
  assert.match(html, /aria-label="批量上架"/)
  assert.match(html, /aria-label="平台货源"/)
  assert.doesNotMatch(html, /aria-label="本地图库"/)
  assert.match(html, /aria-label="店铺商品"/)
  assert.doesNotMatch(html, /aria-label="客服消息"/)

  // Workspace destinations and diagnostics stay out of the rail; settings is the footer gear.
  assert.doesNotMatch(html, /aria-label="加购"/)
  assert.doesNotMatch(html, /aria-label="工作空间"/)
  assert.doesNotMatch(html, /<button[^>]*data-sidebar="menu-button"[^>]*aria-label="店铺"/)
  // The Store roster's global entry is the header's one-tap quick button next
  // to the wallet; it is not a rail item.
  assert.match(html, /aria-label="店铺"/)
  assert.match(html, /aria-label="设置"/)
  assert.match(html, /lucide-settings/)
  assert.doesNotMatch(html, /aria-label="诊断"/)

  // Header has the notification bell
  assert.match(html, /aria-label="通知（共 0 条）"/)

  // Workspace menu trigger exists at footer
  assert.match(html, /aria-label="账户与 Workspace 示例工作空间，专业版，用户"/)

  // Breadcrumb names the current module properly as 店铺
  assert.match(html, />店铺</)

  const menuSource = readFileSync(
    new URL("../src/components/workspace-switcher.tsx", import.meta.url),
    "utf8",
  )
  /* The merged menu carries 店铺; 用量 lives on the header wallet badge, and
     平台 administration lives in the settings sheet. Password, avatar and
     device preferences live in the settings dialog. */
  assert.match(menuSource, /SCREEN_LABELS\.stores/)
  assert.doesNotMatch(menuSource, /onOpenSpace\("usage"\)/)
  assert.doesNotMatch(menuSource, /onOpenPlatform/)
  assert.doesNotMatch(menuSource, />\s*设置\s*</)
  assert.doesNotMatch(menuSource, />\s*更换头像\s*</)
  assert.doesNotMatch(menuSource, />\s*修改密码\s*</)
  assert.match(menuSource, /DropdownMenuSeparator/)
  assert.doesNotMatch(menuSource, /const WELL|bg-muted shadow-\[inset/)
  assert.doesNotMatch(menuSource, /accountChangePassword/)
  assert.doesNotMatch(menuSource, /accountSetAvatar/)
  assert.doesNotMatch(menuSource, /preloadScreen\("diagnostics"\)|onOpenDiagnostics/)

  const settingsSource = readFileSync(
    new URL("../src/app/settings-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(settingsSource, />\s*修改密码\s*</)
  assert.match(settingsSource, /accountChangePassword/)
  assert.match(settingsSource, /AccountProfileSection/)
  assert.match(settingsSource, /DeviceStoragePanel/)
  assert.ok(
    html.indexOf('aria-label="外观：') < html.indexOf('aria-label="设置"'),
    "设置齿轮应位于外观按钮右侧",
  )
  assert.equal(SCREEN_LABELS["message-center"], "客服消息")
  assert.equal("diagnostics" in SCREEN_LABELS, false)
})

test("AppShell ops mode lists fulfilment items and hides the workspace trio", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="ops-shipping"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  assert.match(html, /aria-label="订单发货"/)
  assert.match(html, /aria-label="售后退货"/)
  assert.match(html, /aria-label="入仓供货"/)
  assert.match(html, /aria-label="客服消息"/)
  assert.match(html, /aria-label="评价口碑"/)
  assert.ok(html.indexOf('aria-label="入仓供货"') < html.indexOf('aria-label="客服消息"'))
  assert.ok(html.indexOf('aria-label="客服消息"') < html.indexOf('aria-label="评价口碑"'))
  assert.doesNotMatch(html, /aria-label="数据大屏"/)
  assert.doesNotMatch(html, /aria-label="批量上架"/)
  assert.doesNotMatch(html, /aria-label="店铺商品"/)
})
