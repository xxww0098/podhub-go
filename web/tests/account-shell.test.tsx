import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppShell } from "../src/app/app-shell"
import { SCREEN_LABELS } from "../src/lib/app-screens"
import { NAVIGATION } from "../src/lib/app-navigation"
import { adminSettingsRowsFor } from "../src/lib/settings-sections"
import { overview, ownerWorkspace, noNotifications } from "./account-fixtures"

test("工作台和账户设置不再提供邮箱验证入口", () => {
  const shell = readFileSync(new URL("../src/app/app-shell.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(shell, /banner\?: ReactNode/)
  assert.doesNotMatch(shell, /banner/)
  assert.match(shell, /className="workspace-shell flex h-svh flex-col overflow-hidden"/)

  const host = readFileSync(new URL("../src/app/authenticated-app.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(host, /banner=/)
  assert.doesNotMatch(host, /EmailVerify|verifyDialog/)
  const settings = readFileSync(new URL("../src/app/settings-page.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(settings, /needsEmailVerification|ResendVerificationButton|邮箱验证/)
})

test("AppShell opens a valid settings URL and ignores an unknown section", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const location = { search: "?settings=appearance" }
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, matchMedia } })
  try {
    const render = () => renderToStaticMarkup(
      <AppShell screen="home" overview={overview} onScreenChange={() => {}} onSignedOut={() => {}} notifications={noNotifications}>
        <div />
      </AppShell>,
    )
    assert.match(render(), /aria-label="外观"[^>]*aria-current="page"/)
    location.search = "?settings=unknown"
    assert.doesNotMatch(render(), /aria-label="返回业务页面"/)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("AppShell exposes the whole 平台管理 surface only to staff, panes only to super_admin", () => {
  const adminHtml = renderToStaticMarkup(
    <AppShell
      screen="home"
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
      screen="home"
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
      screen="home"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  // The staff mode (admin + super_admin) holds the 平台商品库管理 rail; the settings
  // panes behind it stay super_admin-only and never enter the shell. The mode's
  // name belongs to the navigation authority, so it is read here, never spelled.
  const staffMode = NAVIGATION.admin.label
  assert.match(adminHtml, new RegExp(`aria-label="${staffMode}"`))
  assert.doesNotMatch(adminHtml, /aria-label="平台分区"/)
  assert.doesNotMatch(adminHtml, />集成</)
  assert.doesNotMatch(adminHtml, />兑换</)
  assert.doesNotMatch(adminHtml, /aria-label="导航模式"/)
  assert.match(adminHtml, /aria-label="主导航"/)
  assert.match(adminHtml, /aria-label="商品经营"/)
  assert.match(adminHtml, /aria-label="订单履约"/)
  assert.ok(
    adminHtml.indexOf('aria-label="商品经营"') < adminHtml.indexOf('aria-label="订单履约"'),
    "business groups precede the staff-only group",
  )
  assert.match(adminHtml, /aria-label="经营数据"/)
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
    new URL("../src/app/settings-page.tsx", import.meta.url),
    "utf8",
  )
  assert.match(settingsSource, /settingsRowsFor\(overview\?\.session\.role, overview\?\.active_workspace\?\.role\)/)
  /* 代理 is a 平台管理 section only; 功能 no longer lists a pane that is empty
     for every non-Agent. The table lives in the React-free vocabulary module. */
  const sectionsSource = readFileSync(
    new URL("../src/lib/settings-sections.ts", import.meta.url),
    "utf8",
  )
  assert.match(sectionsSource, /id: "agents"/)
  assert.doesNotMatch(sectionsSource, /"agent"/)
})

test("AppShell separates the header Workspace from the footer account identity", () => {
  for (const [role, label] of [["admin", "平台管理员"], ["super_admin", "超级管理员"]]) {
    const html = renderToStaticMarkup(
      <AppShell screen="listing" overview={{ ...overview, session: { ...overview.session, name: "李华", email: "li@example.invalid", role } }} onScreenChange={() => {}} onSignedOut={() => {}} notifications={noNotifications}>
        <div />
      </AppShell>,
    )
    const header = html.slice(html.indexOf('data-sidebar="header"'), html.indexOf('data-sidebar="content"'))
    const footer = html.slice(html.indexOf('data-sidebar="footer"'), html.indexOf('data-version-chip'))
    assert.match(header, /aria-label="工作空间 示例工作空间，专业版"/)
    assert.match(header, />示例工作空间</)
    assert.match(header, /data-plan="pro"[^>]*>专业版</)
    assert.doesNotMatch(header, />工作区</)
    assert.doesNotMatch(header, /李华|li@example.invalid/)
    assert.doesNotMatch(header, /<input|role="combobox"/)
    assert.doesNotMatch(header, /PodHub|app-icon\.svg/)
    assert.match(header, /aria-label="搜索页面"/)
    const topbar = html.slice(html.indexOf('<header class="shell-header'), html.indexOf('id="main"'))
    assert.doesNotMatch(topbar, /aria-label="搜索页面"/)
    assert.doesNotMatch(topbar, /aria-label="外观：|aria-label="更新日志/)
    assert.match(topbar, /aria-label="展开侧栏"/)
    assert.match(topbar, /aria-label="店铺管理"/)
    assert.match(topbar, /<time class="shell-date" dateTime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}">\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}<\/time>/)
    assert.match(footer, new RegExp(`aria-label="账户 li@example.invalid，${label}"`))
    assert.match(footer, />李华</)
    assert.match(footer, new RegExp(`>${label}<`))
    assert.doesNotMatch(footer, /示例工作空间|data-plan=/)
    assert.doesNotMatch(footer, /aria-label="外观：/)
    // Settings is available from the account menu, not as a separate footer button.
    assert.match(footer, /shell-account-card/)
    assert.doesNotMatch(footer, /aria-label="设置"/)
    assert.doesNotMatch(footer, /aria-label="店铺管理"/)
    assert.match(html, /aria-current="page"/)
  }
})

test("AppShell account identity falls back to the name when email is empty", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="listing"
      overview={{ ...overview, session: { ...overview.session, name: "李华", email: " ", role: "admin" } }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )
  const footer = html.slice(html.indexOf('data-sidebar="footer"'), html.indexOf('data-version-chip'))
  assert.match(footer, /aria-label="账户 李华，平台管理员"/)
  assert.match(footer, />李华</)
  assert.match(footer, />平台管理员</)
})

test("AppShell keeps Workspace quota facts out of the sidebar footer", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="home"
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
  assert.doesNotMatch(html, /aria-label="外观：/)
  // The top control and keyboard-accessible divider both control the compact rail.
  assert.match(html, /aria-label="展开侧栏"/)
  assert.match(html, /aria-label="调整侧栏宽度"/)
})

test("AppShell remembers an explicitly collapsed sidebar", () => {
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
        screen="home"
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
      screen="home"
      overview={overview}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

  assert.match(html, /h-svh flex-col overflow-hidden/)
  assert.match(html, /flex min-h-0 flex-1 flex-col overflow-hidden/)
  assert.match(html, /page-canvas /)
  assert.match(html, /shell-header flex shrink-0 items-center/)
  assert.doesNotMatch(html, /aria-label="常用页面"/)
  assert.equal((html.match(/<header class="shell-header/g) ?? []).length, 1)
  assert.match(html, /aria-label="面包屑" class="flex min-w-0 items-center"/)
  assert.match(html, /data-state="collapsed"/)
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

  // All permitted business groups remain visible, including customer service.
  assert.match(html, /aria-label="经营数据"/)
  assert.match(html, /aria-label="批量上架"/)
  assert.match(html, /aria-label="平台商品库"/)
  assert.doesNotMatch(html, /aria-label="本地图库"/)
  assert.match(html, /aria-label="我的商品"/)
  assert.match(html, /aria-label="客服消息"/)

  // Store management stays out of the rail and remains reachable from the top bar.
  assert.doesNotMatch(html, /aria-label="加购"/)
  assert.doesNotMatch(html, /aria-label="工作空间"/)
  assert.doesNotMatch(html, /<button[^>]*data-sidebar="menu-button"[^>]*aria-label="店铺"/)
  assert.doesNotMatch(html, /aria-label="店铺"/)
  assert.match(html, /aria-label="店铺管理"/)
  assert.doesNotMatch(html, /aria-label="设置"/)
  assert.doesNotMatch(html, /aria-label="诊断"/)

  // Header has the notification bell
  assert.match(html, /aria-label="通知（共 0 条）"/)

  // Workspace context stays in the header; the account has its own footer trigger.
  assert.match(html, /aria-label="工作空间 示例工作空间，专业版"/)

  // Breadcrumb names the current module properly as 店铺
  assert.match(html, />店铺</)

  const menuSource = readFileSync(
    new URL("../src/components/workspace-switcher.tsx", import.meta.url),
    "utf8",
  )
  /* The merged menu carries 店铺; 用量 lives on the header wallet badge, and
     平台 administration lives in the settings page. Password, avatar and
     device preferences live in the settings page. */
  assert.match(menuSource, /SCREEN_LABELS\.stores/)
  assert.doesNotMatch(menuSource, /onOpenSpace\("usage"\)/)
  assert.doesNotMatch(menuSource, /onOpenPlatform/)
  /* 设置 and sign-out belong to the account; workspace actions stay in the
     Workspace menu. */
  const accountMenu = menuSource.slice(
    menuSource.indexOf("export function AccountMenu"),
    menuSource.indexOf("export function createWorkspaceRefusal"),
  )
  const dropdown = accountMenu.slice(
    accountMenu.indexOf("<DropdownMenuContent"),
    accountMenu.indexOf("</DropdownMenuContent>"),
  )
  assert.doesNotMatch(accountMenu, /店铺管理|onOpenStores|批注页面/)
  const destinations = ["设置", "退出登录"].map((text) => dropdown.indexOf(text))
  assert.ok(destinations.every((index) => index >= 0), `menu rows: ${destinations.join(",")}`)
  assert.deepEqual(destinations, [...destinations].sort((a, b) => a - b))
  assert.doesNotMatch(accountMenu, /创建工作空间/)
  assert.doesNotMatch(accountMenu, /role="toolbar"/)
  assert.doesNotMatch(menuSource, />\s*更换头像\s*</)
  assert.doesNotMatch(menuSource, />\s*修改密码\s*</)
  assert.match(menuSource, /DropdownMenuSeparator/)
  assert.doesNotMatch(menuSource, /const WELL|bg-muted shadow-\[inset/)
  assert.doesNotMatch(menuSource, /accountChangePassword/)
  assert.doesNotMatch(menuSource, /accountSetAvatar/)
  assert.doesNotMatch(menuSource, /preloadScreen\("diagnostics"\)|onOpenDiagnostics/)

  const settingsSource = readFileSync(
    new URL("../src/app/settings-page.tsx", import.meta.url),
    "utf8",
  )
  assert.match(settingsSource, /onClick=\{\(\) => setPasswordOpen\(true\)\}[\s\S]*?修改密码/)
  assert.match(settingsSource, /accountChangePassword/)
  assert.match(settingsSource, /AccountProfileSection/)
  assert.match(settingsSource, /DeviceStoragePanel/)
  assert.doesNotMatch(html.slice(html.indexOf('<header class="shell-header')), /aria-label="外观：/)
  assert.equal(SCREEN_LABELS["message-center"], "客服消息")
  assert.equal("diagnostics" in SCREEN_LABELS, false)
})

test("AppShell keeps business destinations visible while an order screen is selected", () => {
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
  assert.match(html, /aria-label="经营数据"/)
  assert.match(html, /aria-label="批量上架"/)
  assert.match(html, /aria-label="我的商品"/)
})
