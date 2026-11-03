import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AdminSurfaceDenied } from "../src/app/admin-surface-gate"
import { AppShell } from "../src/app/app-shell"
import { AiAllowlist } from "../src/features/platform/ai-prices"
import { isPlatformStaffRole, platformStaffRoleLabel } from "../src/lib/platform-role"
import { adminSettingsRowsFor } from "../src/lib/settings-sections"
import { SCREEN_LABELS } from "../src/lib/app-screens"
import { overview, noNotifications } from "./account-fixtures"

test("platform staff predicate matches only exact staff roles", () => {
  assert.equal(isPlatformStaffRole("admin"), true)
  assert.equal(isPlatformStaffRole("super_admin"), true)
  for (const role of ["user", "owner", "ADMIN", " admin ", " super_admin ", "", null, undefined]) {
    assert.equal(isPlatformStaffRole(role), false)
  }
})

test("platform staff labels preserve the super-admin rank", () => {
  assert.equal(platformStaffRoleLabel("super_admin"), "超级管理员")
  assert.equal(platformStaffRoleLabel("admin"), "平台管理员")
  for (const role of ["user", "owner", "SUPER_ADMIN", " admin ", " super_admin ", "", null, undefined]) {
    assert.equal(platformStaffRoleLabel(role), undefined)
  }
})



test("Admin AI allowlist is models and prices, not connection fields", () => {
  const prices = readFileSync(
    new URL("../src/features/platform/ai-prices.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(prices, /id="ai-base"|id="ai-key"|id="ai-thinking-mode"/)
  assert.doesNotMatch(prices, /Responses \(\/responses\)/)
  assert.match(prices, /当前识图/)
  assert.match(prices, /请先定价，再使用此模型识图/)

  const allowlist = renderToStaticMarkup(
    <AiAllowlist
      defaultModel="qwen3.7-flash"
      accounts={[{
        id: "env-ai",
        label: "Qwen",
        ref_id: "env-ai",
        configured: true,
        active: true,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_format: "chat_completions",
        model: "qwen3.7-flash",
        thinking: false,
        thinking_format: "enable_thinking",
        priority: 0,
        purpose: "ocr",
      }]}
      prices={[
        {
          model: "qwen3.7-flash",
          billing_mode: "token",
          input_microfen_per_million: 40_000_000,
          cached_input_microfen_per_million: 20_000_000,
          output_microfen_per_million: 160_000_000,
          reasoning_microfen_per_million: 160_000_000,
          per_request_microfen: 0,
          max_request_microfen: 50_000_000,
          effective_from: "2026-09-04T00:00:00+08:00",
        },
      ]}
      busy={false}
      onPrices={() => {}}
      onDefaultModel={() => {}}
      onDeletePrice={async () => true}
    />,
  )
  assert.match(allowlist, /qwen3\.7-flash/)
  assert.match(allowlist, /当前识图/)
  assert.match(allowlist, /aria-label="添加模型"/)
  assert.match(allowlist, /已就绪/)
  assert.match(allowlist, /下架/)
  assert.match(allowlist, /aria-label="测试 qwen3\.7-flash"/)
  assert.doesNotMatch(allowlist, /API Key|优先级|base_url/)
  assert.doesNotMatch(allowlist, /思考模式|思考深度|enable_thinking/)
})

test("an unpublished hop model is flagged on the allowlist", () => {
  const html = renderToStaticMarkup(
    <AiAllowlist
      defaultModel="not-priced"
      accounts={[{
        id: "env-ai",
        label: "Qwen",
        ref_id: "env-ai",
        configured: true,
        active: true,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_format: "chat_completions",
        model: "not-priced",
        thinking: false,
        thinking_format: "enable_thinking",
        priority: 0,
        purpose: "ocr",
      }]}
      prices={[]}
      busy={false}
      onPrices={() => {}}
      onDefaultModel={() => {}}
      onDeletePrice={async () => true}
    />,
  )
  assert.match(html, /请先定价，再使用此模型识图/)
  assert.match(html, /为它定价/)
  assert.match(html, /aria-label="测试 not-priced"/)
  assert.doesNotMatch(html, /还没有识图模型/)

  const empty = renderToStaticMarkup(
    <AiAllowlist
      defaultModel=""
      accounts={[]}
      prices={[]}
      busy={false}
      onPrices={() => {}}
      onDefaultModel={() => {}}
      onDeletePrice={async () => true}
    />,
  )
  assert.match(empty, /还没有识图模型/)
  assert.match(empty, /待配置/)
})

const adminScreenLabel = SCREEN_LABELS["supplier-dbs"]

function renderShell(node: Parameters<typeof renderToStaticMarkup>[0]) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, "window")
  if (!existing) Object.defineProperty(globalThis, "window", { value: { location: { search: "" } }, configurable: true })
  try { return renderToStaticMarkup(node) }
  finally { if (!existing) Reflect.deleteProperty(globalThis, "window") }
}

const adminShell = (role: string, settingsRequest: "account" | "payment" | null = null) =>
  renderShell(
    <AppShell
      screen="supplier-dbs"
      adminSurface
      settingsRequest={settingsRequest}
      overview={{
        ...overview,
        session: { ...overview.session, role },
      }}
      onScreenChange={() => {}}
      onSignedOut={() => {}}
      notifications={noNotifications}
    >
      <div />
    </AppShell>,
  )

test("the /admin surface paints the staff rail, one mode and no switcher", () => {
  const html = adminShell("super_admin")
  assert.doesNotMatch(html, /对象存储/)
  assert.match(html, new RegExp(`aria-label="${adminScreenLabel}"`))
  /* One mode leaves nothing to switch between. */
  assert.doesNotMatch(html, /aria-label="导航模式"/)
  // Platform settings offer only the permitted sections.
  assert.deepEqual(
    adminSettingsRowsFor("super_admin").map((row) => row.label),
    ["用户", "工厂管理", "AI 账号", "支付", "网络代理", "全局受限标签", "类目", "兑换", "代理", "日志", "订单"],
  )
})

test("admin settings keep business navigation beside the inline pane and a return control", () => {
  const html = adminShell("super_admin", "payment")
  assert.match(html, /aria-label="设置分区"/)
  assert.match(html, /aria-label="返回业务页面"/)
  assert.match(html, /data-settings-page/)
  assert.match(html, /aria-label="主导航"/)
  assert.doesNotMatch(html, /role="dialog"|data-slot="dialog-content"/)
  const businessNav = html.slice(html.indexOf('aria-label="主导航"'), html.indexOf("</nav>", html.indexOf('aria-label="主导航"')))
  assert.doesNotMatch(businessNav, /aria-current="page"/)
  assert.match(html, /aria-label="支付"[^>]*aria-current="page"/)
  const refused = adminShell("admin", "payment")
  assert.match(refused, /没有权限打开该设置/)
  assert.doesNotMatch(refused, /aria-label="支付"/)
})

test("detail settings panes keep a centred reading column, rosters keep the canvas", () => {
  const cases = [
    /* 账号 is a form: one column with side margins, not a full-bleed sheet. */
    { html: adminShell("super_admin", "account"), centred: true },
    /* 支付 is a ledger; it must stay edge to edge. */
    { html: adminShell("super_admin", "payment"), centred: false },
  ]
  for (const { html, centred } of cases) {
    const column =
      html
        .slice(html.indexOf("data-settings-page"))
        .match(/<div class="([^"]*\bp-[34]\b[^"]*)"/)?.[1] ?? ""
    assert.equal(/mx-auto w-full max-w-4xl/.test(column), centred, column)
  }
})

test("the /admin rail hides super_admin panes from an admin-rank session", () => {
  const html = adminShell("admin")
  assert.match(html, new RegExp(`aria-label="${adminScreenLabel}"`))
  /* Every section in that rail is super_admin-only, so admin-rank mounts none. */
  assert.deepEqual(adminSettingsRowsFor("admin"), [])
})

test("the /admin surface paints no platform destination for a session that is not staff", () => {
  const html = adminShell("user")
  assert.doesNotMatch(html, /aria-label="平台"/)
  assert.doesNotMatch(html, /平台管理/)
  assert.doesNotMatch(html, new RegExp(`aria-label="${adminScreenLabel}"`))
})

test("the workbench shell never paints the admin rail or an admin section", () => {
  const html = renderShell(
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
  assert.doesNotMatch(html, /aria-label="支付"/)
  assert.doesNotMatch(html, /aria-label="提示词"/)
  assert.match(html, /aria-label="主导航"/)
})

test("AdminSurfaceDenied refuses without an alert role or raw error text", () => {
  const html = renderToStaticMarkup(<AdminSurfaceDenied onLeave={() => {}} />)
  assert.match(html, /仅平台管理员可以访问管理面/)
  assert.match(html, /data-admin-surface="forbidden"/)
  assert.match(html, /返回工作台/)
  assert.doesNotMatch(html, /role="alert"/)
})
