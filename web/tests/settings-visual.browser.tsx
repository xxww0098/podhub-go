// Dev-only full SettingsDialog. All identities and endpoints below are fictional.
// Open /tests/settings-visual.html?section=ocr&dark. Unknown requests fail closed.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { AccountOverview, IntegrationCredentialsOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { adminHttp } from "@/bindings/http-admin"
import { integrationsHttp } from "@/bindings/http-integrations"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { supplierDbsHttp } from "@/bindings/http-supplier-dbs"
import { listingHttp } from "@/bindings/http-listing"
import { route } from "@/api/routes"
import { SettingsDialog } from "@/app/settings-dialog"
import { Toaster } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { settingsRowsFor, type SettingsSection } from "@/lib/settings-sections"
import { initTheme } from "@/lib/theme"
import "../src/index.css"

const params = new URLSearchParams(location.search)
const now = Date.parse("2026-10-07T10:00:00Z")
const workspace = { id: 901, uuid: "fixture-workspace", name: "虚构 · 星纸工作室", plan: "pro", role: "owner", is_owned: true }
let overview: AccountOverview = {
  session: { authenticated: true, email: "reviewer@example.invalid", name: "虚构管理员", role: "super_admin" },
  active_workspace: workspace, workspaces: [workspace], account_mode: "owner", owned_count: 1, owned_limit: 3,
  entitlement: {
    plan: "pro", features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
    limits: { stores: 12, stores_used: 2, seats: 8, seats_used: 2, s3_upload_bytes_monthly: 21474836480,
      s3_upload_bytes_used: 2147483648, ai_tokens_monthly: 1000000, ai_tokens_used: 125000, ai_calls_per_day: 100 },
  },
}

// Isolate theme/preferences from the real application on the same dev origin.
const preferences = new Map<string, string>([["podhub.theme", params.has("dark") ? "dark" : "light"]])
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => preferences.get(key) ?? null,
  setItem: (key: string, value: string) => { preferences.set(key, String(value)) },
  removeItem: (key: string) => { preferences.delete(key) }, clear: () => preferences.clear(),
  key: (index: number) => [...preferences.keys()][index] ?? null,
  get length() { return preferences.size },
} satisfies Storage })
// Never enumerate or clear the real origin's OPFS cache during visual review.
if (navigator.storage) {
  Object.defineProperty(navigator.storage, "getDirectory", { configurable: true, value: async () => { throw new Error("Fixture has no OPFS") } })
  Object.defineProperty(navigator.storage, "estimate", { configurable: true, value: async () => ({ usage: 0, quota: 1073741824 }) })
}

const routeFixtures = new Map<string, unknown>([
  [route("automationGrants"), { grants: [] }],
  [route("meCatalogAutomationGrants"), { grants: [] }],
  [route("adminSupplierAutomationGrants"), { grants: [] }],
  [route("adminSupplierAccounts"), { groups: [] }],
])
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  if (url.origin !== location.origin || method !== "GET" || !routeFixtures.has(url.pathname)) {
    throw new Error(`Settings fixture blocked ${method} ${url.pathname}`)
  }
  return Response.json({ data: routeFixtures.get(url.pathname) })
}
// CSP also denies XHR, beacons, WebSocket and resource-based external requests.
// No transport keeps a reference to the real fetch implementation.
window.open = () => null

accountHttp.accountGetOverview = async () => overview
accountHttp.accountListWorkspaces = async () => overview
accountHttp.accountChangePassword = async () => {}
accountHttp.accountRename = async (name) => {
  overview = { ...overview, session: { ...overview.session, name } }
  rememberAccountOverview(overview)
  return overview
}
accountHttp.accountRenameWorkspace = async (name) => {
  overview = { ...overview, active_workspace: { ...workspace, name }, workspaces: [{ ...workspace, name }] }
  rememberAccountOverview(overview)
  return overview
}
accountHttp.accountListNotifications = async () => ({ notifications: [], unread: 0, total: 0 })
accountHttp.accountGetWorkspaceDirectory = async () => ({
  seats_used: 2, pending_used: 0, pending_limit: 8, invitations: [],
  permissions: { dissolve: true, edit_profile: true, invite_roles: ["manager", "member"], leave: false, revoke_invitation: true },
  members: [
    { id: 901, name: "虚构管理员", email: "reviewer@example.invalid", role: "owner", status: "active", joined_at_ms: now,
      permissions: { remove: false, change_roles: [] } },
    { id: 902, name: "虚构运营小禾", email: "operator@example.invalid", role: "member", status: "active", joined_at_ms: now,
      permissions: { remove: true, change_roles: ["manager"] } },
  ],
})
accountHttp.accountGetSeatCatalog = async () => ({
  free_stores: 1, stores_per_seat: 3, min_seats_per_purchase: 1, max_seats_per_purchase: 100,
  max_seats_per_workspace: 100, max_stores_per_workspace: 300,
  terms: [{ key: "month", days: 30, months: 1, discount_percent: 100 }, { key: "year", days: 365, months: 12, discount_percent: 80 }],
  tiers: ["pro", "max"].map((key, index) => ({ key, official_mcp: true, list_unit_month_cents: 2900 + index * 2000,
    terms: [{ term: "month", unit_month_cents: 2900 + index * 2000 }, { term: "year", unit_month_cents: 2320 + index * 1600 }] })),
})
accountHttp.accountGetBillingOverview = async () => ({
  plan: "pro", purchased_seats: 8, lots: [], upgrade_credits: [],
  member_seats: { default: 8, effective: 8, used: 2, suspended: 0 },
  store_slots: { default: 24, effective: 24, used: 2, suspended: 0 },
})
accountHttp.accountGetPaymentMethods = async () => ({ manual: true, providers: ["easypay"] })
accountHttp.accountListPaymentOrders = async () => []
accountHttp.accountListPaymentOrderPage = async () => ({ orders: [], next_cursor: null })

const media = { id: "fictional-media", ref_id: "fictional-media", label: "虚构 · 商品图片桶", role: "assets" as const, provider: "cloudflare" as const,
  active: true, configured: true, endpoint: "https://storage.example.invalid", region: "auto", bucket: "fictional-assets",
  key_prefix: "preview", public_base_url: "https://assets.example.invalid", force_path_style: true }
let integrations: IntegrationCredentialsOverview = {
  ai_default_model: "fictional-vision-fast",
  ai_accounts: [
    { id: "fictional-ai", ref_id: "fictional-ai", label: "虚构 · 主识图账号", base_url: "https://ai.example.invalid/v1",
      model: "fictional-vision-fast", api_format: "chat_completions", thinking: false, thinking_format: "enable_thinking", active: true, configured: true, priority: 10 },
    { id: "fictional-backup", ref_id: "fictional-backup", label: "虚构 · 备用账号", base_url: "https://backup.example.invalid/v1",
      model: "fictional-vision-pro", api_format: "responses", thinking: "low", thinking_format: "reasoning_effort", active: false, configured: true, priority: 0 },
  ],
  media_accounts: [media],
}
integrationsHttp.integrationsGetCredentials = async () => integrations
aiAccountsHttp.setDefaultModel = async (model) => (integrations = { ...integrations, ai_default_model: model })
aiAccountsHttp.setActive = async (id, active) => (integrations = { ...integrations, ai_accounts: integrations.ai_accounts.map((row) => row.id === id ? { ...row, active } : row) })
aiAccountsHttp.delete = async (id) => (integrations = { ...integrations, ai_accounts: integrations.ai_accounts.filter((row) => row.id !== id) })
aiAccountsHttp.upsert = async (draft) => {
  const id = draft.id ?? `fictional-${integrations.ai_accounts.length}`
  integrations = { ...integrations, ai_accounts: [...integrations.ai_accounts.filter((row) => row.id !== id), {
    id, ref_id: id, label: draft.label, base_url: draft.base_url, model: draft.model, api_format: draft.api_format,
    thinking: draft.thinking, thinking_format: draft.thinking_format, active: draft.active, configured: true, priority: draft.priority,
  }] }
  return integrations
}
adminHttp.adminListAiPrices = async () => ["fictional-vision-fast", "fictional-vision-pro"].map((model) => ({
  model, billing_mode: "per_request", per_request_microfen: 100000, input_microfen_per_million: 0,
  cached_input_microfen_per_million: 0, output_microfen_per_million: 0, reasoning_microfen_per_million: 0,
  max_request_microfen: 100000, effective_from: "2026-10-01T00:00:00Z",
}))
integrationsHttp.mediaStorageObjects = async (accountId, prefix = "") => ({ account_id: accountId, prefix, next_cursor: null,
  items: prefix ? [] : [{ kind: "directory", path: "fictional-workspace", bytes: 0 }, { kind: "file", path: "sample-banner.webp", bytes: 642111, last_modified: "2026-10-01T00:00:00Z" }],
})
integrationsHttp.integrationsMediaStorage = async ({ id, prefix }) => ({ accountId: id, prefix: prefix ?? "", bucket: media.bucket, bytes: 642111, objects: 1, groups: [], scannedAtMs: now, truncated: false })
integrationsHttp.supplierDbStorageObjects = async (prefix = "") => ({ prefix, next_cursor: null, items: [] })
integrationsHttp.integrationsGetPaymentConfig = async () => ({ revision: 1, providers: [
  { provider: "easypay", enabled: true, configured: true, secretFieldsConfigured: ["pkey"],
    values: { pid: "fictional-merchant", apiBase: "https://pay.example.invalid", notifyUrl: "https://cloud.example.invalid/api/billing/webhooks/easypay", returnUrl: "https://cloud.example.invalid/complete" } },
  ...["alipay", "wechat", "stripe", "airwallex"].map((provider) => ({ provider, enabled: false, configured: false, secretFieldsConfigured: [], values: {} })),
] })
integrationsHttp.integrationsGetSellerRelay = async () => ({ sidecar_managed: true, relay_route: "http://relay.example.invalid:8080", nodes: [
  { id: "fictional-relay", name: "虚构 · 示例节点", address: "192.0.2.10:443", active: true },
] })
adminHttp.catalogFetchConfig = async () => ({
  enabled: true, schedule_mode: "fixed", at_minute: 180, window_start_minute: 120, window_end_minute: 240,
  utc_offset_minutes: 480, language: "zh_hans", keys: [{ client_id: "fictional-client", api_key_configured: true, disabled: false }],
  next_run_at_ms: now + 86400000, last_run_at_ms: now, last_status: null, last_error: "", last_duration_ms: 1200,
  last_root_nodes: 24, last_key_attempts: 1, failure_streak: 0, running: false, updated_at_ms: now,
  coordinate_freshness: { total: 24, fresh: 24, stale: 0, expired: 0, missing: 0 },
  wb_credential: { configured: false, credential_revision: 0 },
})
supplierDbsHttp.supplierDbsList = async () => ({ dbs: [] })
supplierDbsHttp.supplierPromptsList = async () => ({ prompts: [] })
listingHttp.listingCardLoadCategoryTree = async () => []
adminHttp.adminListUsers = async () => ({ user_count: 1, workspace_count: 1, unaffiliated: [], workspaces: [{
  ...workspace, created_at: "2026-10-01T00:00:00Z", owner_uuid: "fictional-user", seat_limit: 8, seats_used: 1,
  ai_tokens_monthly: 1000000, ai_tokens_used: 125000, wallet_available_microfen: 250000000, wallet_held_microfen: 0,
  members: [{ uuid: "fictional-user", name: "虚构管理员", email: "reviewer@example.invalid", role: "super_admin", role_label: "超级管理员",
    kind: "owner", is_admin: true, editable: true, manageable: true, disabled: false, status: "active",
    membership_role: "owner", membership_status: "active", created_at: "2026-10-01T00:00:00Z" }],
}] })
adminHttp.adminListOrders = async () => []
adminHttp.adminListRedeemCodes = async () => ({ codes: [], total: 0, expired: 0, redeemed: 0, revoked: 0, unused: 0 })
adminHttp.adminListAgents = async () => ({ agents: [], attribution_validity_days: 30, default_rebate_bps: 1000, min_order_cents: 100, min_withdraw_cents: 10000 })
adminHttp.adminListAgentCommissions = async () => ({ commissions: [], page: 1, page_size: 50, total: 0 })
adminHttp.adminListAgentWithdrawals = async () => []
adminHttp.adminListAiRequests = async () => ({ rows: [], page: 1, page_size: 50, total_pages: 0, total_rows: 0 })
adminHttp.adminListErrorLogs = async () => ({ rows: [], page: 1, page_size: 50, total_pages: 0, total_rows: 0 })
adminHttp.adminAiUsageSummary = async () => ({ absorbed_microfen: 0, cache_hit_rate_bps: 0, cached_input_tokens: 0,
  charged_microfen: 0, failed_rows: 0, failure_classes: [], in_flight_rows: 0, input_tokens: 0, output_tokens: 0,
  settled_rows: 0, total_rows: 0, unbilled_unknown_rows: 0, latency_p50_ms: null, latency_p90_ms: null, latency_p99_ms: null,
  upstream_latency_p50_ms: null, upstream_latency_p90_ms: null, upstream_latency_p99_ms: null, generation_speed_milli_tps_median: null })

// Small executable fixture checks catch missing navigation and transport leaks.
const sections = settingsRowsFor("super_admin")
if (sections.length !== 20) throw new Error(`Expected 20 settings sections; got ${sections.length}`)
try {
  await window.fetch("https://unknown.example.invalid/api/probe")
  throw new Error("Network guard did not reject unknown URL")
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith("Settings fixture blocked")) throw error
}
initTheme()
rememberAccountOverview(overview)

function Fixture() {
  const [open, setOpen] = useState(true)
  const [account, setAccount] = useState(overview)
  const [section, setSection] = useState<SettingsSection>(() => sections.find((row) => row.id === params.get("section"))?.id ?? "account")
  function navigate(next: SettingsSection) {
    setSection(next)
    const url = new URL(location.href)
    url.searchParams.set("section", next)
    history.replaceState(null, "", url)
  }
  return <NotificationsProvider>
    <main className="p-6"><p className="mb-4 text-sm text-muted-foreground">设置视觉检查 · 全部为虚构数据 · 无网络访问</p>
      <Button onClick={() => setOpen(true)}>打开完整设置</Button>
    </main>
    <SettingsDialog open={open} onOpenChange={setOpen} overview={account} onOverviewChange={setAccount}
      section={section} onSectionChange={navigate} onOpenNotifications={() => { navigate("notifications"); setOpen(true) }} />
    <Toaster />
  </NotificationsProvider>
}
createRoot(document.getElementById("fixture")!).render(<Fixture />)
