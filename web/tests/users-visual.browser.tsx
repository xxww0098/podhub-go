// Dev-only real settings surface. Open /tests/users-visual.html?dark&state=empty|error.
// Every identity is fictional; transports and origin preferences are isolated.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { AccountOverview, AdminDirectoryPersonView, AdminUsersOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { adminHttp } from "@/bindings/http-admin"
import { AppShell } from "@/app/app-shell"
import { Toaster } from "@/components/ui/toast"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { initTheme } from "@/lib/theme"
import type { SettingsSection } from "@/lib/settings-sections"
import "../src/index.css"

const params = new URLSearchParams(location.search)
const workspace = { id: 901, uuid: "fictional-paper-workspace", name: "星纸工作室", plan: "pro", role: "owner", is_owned: true }
const overview: AccountOverview = {
  session: { authenticated: true, email: "lin@example.invalid", name: "林知夏", role: "super_admin" },
  active_workspace: workspace, workspaces: [workspace], account_mode: "owner", owned_count: 1, owned_limit: 3,
  entitlement: { plan: "pro", features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
    limits: { stores: 30, stores_used: 12, seats: 8, seats_used: 4, s3_upload_bytes_monthly: 21474836480,
      s3_upload_bytes_used: 2147483648, ai_tokens_monthly: 1000000, ai_tokens_used: 125000, ai_calls_per_day: 100 } },
}

const preferences = new Map<string, string>([["podhub.theme", params.has("dark") ? "dark" : "light"]])
const sessionPreferences = new Map<string, string>()
for (const [name, values] of [["localStorage", preferences], ["sessionStorage", sessionPreferences]] as const) {
  Object.defineProperty(window, name, { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } satisfies Storage })
}
if (navigator.storage) {
  Object.defineProperty(navigator.storage, "getDirectory", { configurable: true, value: async () => { throw new Error("Fixture has no OPFS") } })
  Object.defineProperty(navigator.storage, "estimate", { configurable: true, value: async () => ({ usage: 0, quota: 1073741824 }) })
}
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  throw new Error(`Users fixture blocked ${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`)
}
window.open = () => null

function person(uuid: string, name: string, email: string, overrides: Partial<AdminDirectoryPersonView> = {}): AdminDirectoryPersonView {
  return { account_kind: "platform", uuid, name, email: `${email}@example.invalid`, role: "user", role_label: "普通用户", kind: "user", is_admin: false,
    disabled: false, status: "active", editable: true, manageable: true, membership_role: "member", membership_status: "active",
    created_at: "2026-10-01T08:00:00Z", last_login_at: "2026-10-22T08:25:00Z", ...overrides }
}
const owner = person("fictional-lin", "林知夏", "lin", {
  role: "super_admin", role_label: "超级管理员", kind: "super_admin", is_admin: true,
  editable: false, manageable: false, membership_role: "owner",
})
const shared = person("fictional-zhou", "周予安", "zhou", {
  role: "admin", role_label: "管理员", kind: "admin", is_admin: true, membership_role: "manager",
})
const directory: AdminUsersOverview = {
  user_count: 9, workspace_count: 2,
  workspaces: [
    { ...workspace, owner_uuid: owner.uuid, created_at: "2026-10-01T08:00:00Z", seat_limit: 8, seats_used: 4,
      ai_tokens_monthly: 1000000, ai_tokens_used: 125000, wallet_available_microfen: 250000000, wallet_held_microfen: 1800000,
      members: [owner, shared, person("fictional-xu", "许禾", "xu"),
        person("fictional-chen", "陈以宁", "chen", { disabled: true, status: "disabled", last_login_at: "2026-10-17T11:40:00Z" })] },
    { id: 902, uuid: "fictional-mountain-workspace", name: "山序设计", owner_uuid: "fictional-song", plan: "max",
      created_at: "2026-09-15T02:00:00Z", seat_limit: 16, seats_used: 4, ai_tokens_monthly: 5000000, ai_tokens_used: 3100000,
      wallet_available_microfen: 480000000, wallet_held_microfen: 0,
      members: [person("fictional-song", "宋闻溪", "song", { membership_role: "owner" }), { ...shared, membership_role: "member" },
        person("fictional-wen", "温见鹿", "wen", { last_login_at: "" }), person("fictional-lu", "陆景行", "lu", { last_login_at: "2026-10-21T13:12:00Z" })] },
  ],
  unaffiliated: [person("fictional-shen", "沈星澜", "shen", { membership_role: null, membership_status: null, last_login_at: "" }),
    person("fictional-su", "苏晚", "su", { membership_role: null, membership_status: null, disabled: true, status: "disabled" })],
}
const fixtureDirectory: AdminUsersOverview = params.get("state") === "many" ? {
  ...directory,
  user_count: directory.user_count + 10,
  unaffiliated: [...directory.unaffiliated, ...Array.from({ length: 10 }, (_, index) =>
    person(`fictional-page-${index + 1}`, `分页用户 ${index + 1}`, `page-${index + 1}`, { membership_role: null, membership_status: null }))],
} : directory
accountHttp.accountGetOverview = async () => overview
accountHttp.accountListWorkspaces = async () => overview
accountHttp.accountListNotifications = async () => ({ notifications: [], unread: 0, total: 0 })
adminHttp.adminListUsers = async () => {
  if (params.get("state") === "error") throw new Error("用户列表读取失败，请稍后重试。")
  if (params.get("state") === "empty") return { user_count: 0, workspace_count: 0, unaffiliated: [], workspaces: [] }
  return fixtureDirectory
}

const people = [...fixtureDirectory.workspaces.flatMap((item) => item.members), ...fixtureDirectory.unaffiliated]
adminHttp.adminUpdateUser = async (input) => {
  if (params.has("save-error")) throw new Error("模拟保存失败")
  const matches = people.filter((person) => person.uuid === input.uuid)
  if (!matches.length || matches.some((person) => !person.manageable) || (input.role !== "admin" && input.role !== "user")) throw new Error("Fixture rejected account update")
  for (const person of matches) {
    person.role = input.role
    person.role_label = input.role === "admin" ? "平台管理员" : "普通用户"
    person.disabled = !input.enabled
    person.status = input.enabled ? "active" : "disabled"
  }
  document.documentElement.dataset.fixtureUpdate = JSON.stringify(input)
  return { ...matches[0]!, ai_tokens_monthly: 1_000_000, ai_tokens_used: 125_000, seat_limit: 8, seats_used: 4, plan: "pro" }
}
if (people.length < 8 || new Set(people.map((item) => item.uuid)).size !== fixtureDirectory.user_count
  || people.length === fixtureDirectory.user_count || !people.some((item) => item.disabled)
  || !people.some((item) => item.is_admin) || !people.some((item) => !item.last_login_at)
  || directory.unaffiliated.length === 0) throw new Error("Users fixture contract mismatch")
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
  try {
    await fetch("https://unknown.example.invalid/api/fixture-probe", { method })
    throw new Error("Users fixture guard did not reject the operation")
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Users fixture blocked")) throw error
  }
}
document.documentElement.dataset.fixtureChecks = "passed"
initTheme()
rememberAccountOverview(overview)

function Fixture() {
  const [section, setSection] = useState<SettingsSection | null>("users")
  return <NotificationsProvider>
    <AppShell screen="supplier-dbs" adminSurface settingsRequest={section} onSettingsRequestChange={setSection}
      overview={overview} onSignedOut={() => {}} onScreenChange={() => {}}>
      <span className="sr-only">虚构数据视觉检查</span>
    </AppShell>
    <Toaster />
  </NotificationsProvider>
}
const frameParams = new URLSearchParams(params)
frameParams.delete("mobile")
createRoot(document.getElementById("fixture")!).render(params.has("mobile")
  ? <iframe title="375px 用户页面验收" src={`${location.pathname}?${frameParams}`} style={{ display: "block", width: 375, height: 640, border: 0 }} />
  : <Fixture />)
if (params.get("state") === "many" && params.has("check")) void import("./users-pagination-check")
if (params.has("editor-check")) void import("./users-editor-check")
