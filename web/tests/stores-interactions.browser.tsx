// Dev-only Store checks. The real StoresScreen is mounted; HTTP bindings are mocked.
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { AccountOverview, OzonStoresOverview, WorkspaceDirectoryView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { integrationsHttp } from "@/bindings/http-integrations"
import { listingHttp } from "@/bindings/http-listing"
import { forgetStoreRoster, rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { StoresScreen } from "@/features/stores/stores-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const params = new URLSearchParams(location.search)
const role = params.get("role") ?? "owner"
const granted = params.get("granted") === "1"
const editor = params.get("editor") === "1"
if (params.get("mobile") === "1") fixture.style.width = "390px"

const unexpectedRequests: string[] = []
window.fetch = async (input) => { unexpectedRequests.push(String(input)); throw new Error(`Unexpected network request: ${input}`) }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function byText(text: string, root: ParentNode = document): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button")].filter(
    (button) =>
      (button.textContent?.trim() === text ||
        button.textContent?.trim().startsWith(text)) &&
      !button.closest('[aria-hidden="true"]'),
  )
  check(found.length === 1, `Expected one button '${text}', got ${found.length}`); return found[0]!
}
async function click(element: HTMLElement) { check(!element.hasAttribute("disabled"), "Cannot click disabled control"); flushSync(() => element.click()); await settle() }
function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }))
}

const permissions = {
  manage_store: role === "owner" || role === "manager", edit_name: true,
  manage_key_grants: role === "owner", test_key: true,
  manage_tags: role === "owner" || role === "manager",
  manage_key: role === "owner" || granted,
  delete_store: role === "owner" || granted,
}

const rosterStore = {
  id: "store-1", label: "主店", client_id: "client-1", watermark_name: "", advertising_client_id: "", advertising_configured: false,
  configured: true, secret_status: "present" as const, ref_id: "store-1", updated_at_ms: 1_750_000_000_000, verified_at_ms: null,
  last_used_at_ms: null, active: false, cloud_store_uuid: "store-1", create_order: null, cloud_status: "active", manual_disabled: false,
  quota_suspended: false, cloud_revision: 1, credential_revision: 1, needs_reentry: false, can_manage: permissions.manage_store,
  can_edit_credential: permissions.manage_key, assignee_key_manage: granted,
  assignee_name: role === "manager" ? "工作空间管理员" : "工作空间成员", assignee_membership_id: role === "manager" ? 2 : 3, assignee_email: `${role === "manager" ? "manager" : "member"}@example.invalid`, permissions,
  product_quota: {
    daily_create: { limit: 100, usage: 12 },
    daily_update: { limit: 2000, usage: 10 },
    total: {
      limit: -1, usage: 80,
      categories: [
        { category_id: 17027490, limit: 200, usage: 0 },
        { category_id: 17027495, limit: 200, usage: 30 },
      ],
    },
    fetched_at_ms: 1_750_000_000_000,
  },
  finance_balance: {
    outcome: "ready" as const,
    amount: "1520.50",
    currency_code: "CNY",
    period_to: "2026-10-12",
    fetched_at_ms: 1_750_000_000_000,
  },
}
const directory: WorkspaceDirectoryView = {
  members: [
    { id: 1, name: "工作空间所有者", email: "owner@example.invalid", role: "owner", status: "active", joined_at_ms: 1_750_000_000_000, permissions: { remove: false } },
    { id: 2, name: "工作空间管理员", email: "manager@example.invalid", role: "manager", status: "active", joined_at_ms: 1_750_000_000_000, permissions: { remove: false } },
    { id: 3, name: "工作空间成员", email: "member@example.invalid", role: "member", status: "active", joined_at_ms: 1_750_000_000_000, permissions: { remove: role === "owner" || role === "manager" } },
  ], invitations: [], seats_used: 3, pending_used: 0, pending_limit: 5,
  permissions: { invite_roles: role === "owner" ? ["manager", "member"] : role === "manager" ? ["member"] : [], revoke_invitation: role !== "member", edit_profile: role === "owner", dissolve: role === "owner", leave: role === "member" },
}
const workspace = { id: 1, uuid: "550e8400-e29b-41d4-a716-446655440000", name: "深度优化 Workspace", plan: "pro", role, is_owned: role === "owner" }
const overview = {
  session: { authenticated: true, email: `${role}@example.invalid`, name: role, role },
  entitlement: { plan: "pro", features: { ai_relay: true, ocr: true, batch_listing: true, field_package: false }, limits: { stores: 3, stores_used: 1, seats: 8, seats_used: 3, s3_upload_bytes_monthly: 1, s3_upload_bytes_used: 0, ai_tokens_monthly: 1, ai_tokens_used: 0, ai_calls_per_day: 1 } },
  active_workspace: workspace, workspaces: [workspace], account_mode: role === "member" ? "member" : "owner", owned_count: 1, owned_limit: 3,
} as AccountOverview

let roster: OzonStoresOverview
let failCredential = true
let failClear = true
let nextStore = 2
const calls: string[] = []
function resetMocks() {
  roster = { stores: [{ ...rosterStore }], active_id: null, store_limit: 3, stores_used: 1, suspended: 0 }
  localStorage.removeItem("podhub.workflow.category-tree.v1")
  failCredential = true; failClear = true; nextStore = 2; calls.length = 0
  accountHttp.accountGetWorkspaceDirectory = async () => directory
  integrationsHttp.integrationsListOzonStores = async () => ({ ...roster, stores: roster.stores.map((store) => ({ ...store })) })
  integrationsHttp.integrationsRenameOzonStore = async ({ id, name }) => { calls.push(`rename:${id}`); roster.stores.find((store) => store.id === id)!.label = name.trim(); return { ...roster } }
  integrationsHttp.integrationsUpsertOzonStore = async ({ id, label, client_id }) => {
    calls.push(`key:${id}`)
    if (failCredential) throw new Error("key rejected")
    Object.assign(roster.stores.find((store) => store.id === id)!, { label: label.trim(), client_id: client_id.trim() }); return { overview: { ...roster }, store_id: id }
  }
  integrationsHttp.integrationsSetStoreTags = async ({ id, tag_uuids }) => { calls.push(`tags:${id}`); const store = roster.stores.find((store) => store.id === id)!; store.tags = tag_uuids.map((uuid) => roster.tags?.find((tag) => tag.uuid === uuid) ?? { uuid, name: uuid }); return { ...roster } }
  integrationsHttp.integrationsCreateStoreTag = async ({ name }) => { calls.push(`tag-create:${name}`); roster.tags = [...(roster.tags ?? []), { uuid: `tag-${name}`, name: name.trim(), store_count: 0 }]; return { ...roster } }
  integrationsHttp.integrationsRenameStoreTag = async ({ uuid, name }) => { calls.push(`tag-rename:${uuid}`); const tag = roster.tags?.find((tag) => tag.uuid === uuid); if (tag) tag.name = name.trim(); return { ...roster } }
  integrationsHttp.integrationsDeleteStoreTag = async ({ uuid }) => { calls.push(`tag-delete:${uuid}`); roster.tags = (roster.tags ?? []).filter((tag) => tag.uuid !== uuid); for (const store of roster.stores) store.tags = store.tags?.filter((tag) => tag.uuid !== uuid); return { ...roster } }
  integrationsHttp.integrationsClearOzonStore = async () => { calls.push("clear"); if (failClear) throw new Error("clear rejected"); return { ...roster } }
  integrationsHttp.integrationsCreateOzonStore = async ({ label }) => {
    roster.stores.push({ ...rosterStore, id: "other-window", label: label.trim() })
    roster.stores.push({ ...rosterStore, id: `store-${nextStore++}`, label: label.trim(), client_id: "", configured: false, secret_status: "absent", assignee_key_manage: true, permissions: { ...permissions, manage_key: true, test_key: false }, can_edit_credential: true })
    roster.stores_used = roster.stores.length
    const created = roster.stores.at(-1)!
    return { id: created.id, roster: { ...roster, stores: roster.stores.map((store) => ({ ...store })) } }
  }
  integrationsHttp.integrationsTestOzonStore = async () => ({ ...roster })
  integrationsHttp.integrationsRefreshStoreProductQuotas = async () => ({ ...roster, stores: roster.stores.map((store) => ({ ...store })) })
  integrationsHttp.integrationsRefreshStoreFinanceBalances = async () => ({ ...roster, stores: roster.stores.map((store) => ({ ...store })) })
  integrationsHttp.integrationsSetActiveOzonStore = async () => ({ ...roster })
  integrationsHttp.integrationsAssignOzonStore = async () => ({ ...roster })
  integrationsHttp.integrationsSetStoreKeyGrant = async () => ({ ...roster })
  listingHttp.listingCardLoadCategoryTree = async () => ([
    {
      description_category_id: 17027490, category_name: "古董和收藏品",
      type_id: 0, type_name: "", disabled: false, children: [],
    },
    {
      description_category_id: 17027495, category_name: "汽车用品",
      type_id: 0, type_name: "", disabled: false, children: [],
    },
  ])
  rememberStoreRoster(roster, 1)
}
async function mounted(action: (root: Root) => Promise<void>) {
  resetMocks(); forgetStoreRoster(1); rememberStoreRoster(roster, 1); const root = createRoot(fixture)
  try { flushSync(() => root.render(<StoresScreen overview={overview} />)); await settle(); await action(root) } finally { flushSync(() => root.unmount()); await settle() }
}

async function storeChecks() {
  await mounted(async () => {
    check(fixture.textContent?.includes("新建88 88 / 100"), "daily create remaining missing")
    check(fixture.textContent?.includes("更新1990 1990 / 2000"), "daily update remaining missing")
    check(fixture.textContent?.includes("基础不限 不限"), "unlimited assortment missing")
    check(fixture.textContent?.includes("附加370 370 / 400"), "additional category quota missing")
    check(fixture.textContent?.includes("期末余额"), "period-end balance column missing")
    check(fixture.textContent?.includes("CNY"), "period-end balance must keep the reported currency")
    await settle()
    const quotaTitles = [...fixture.querySelectorAll<HTMLElement>("[title]")].map((element) => element.title)
    check(
      quotaTitles.some((title) => title.includes("古董和收藏品") && title.includes("汽车用品")),
      "additional quota tooltip must name the in-demand categories",
    )
    const config = fixture.querySelector<HTMLButtonElement>('[aria-label="店铺资料"]')!
    if (config.disabled) { check(!editor || role === "member", "configuration should be available to this actor"); return }
    await click(config); check(document.querySelector('[role="dialog"]'), "real StoresScreen configuration dialog missing")
    if (!editor) return
    const label = document.querySelector<HTMLInputElement>("#store-label")!; setInput(label, "新名字"); await click(byText("验证并保存"))
    check(roster.stores[0]!.label === "新名字", "rename-only did not persist"); check(roster.stores[0]!.configured, "rename-only changed credentials")
    check(calls.join(",") === "rename:store-1", "rename must not call credential write")
    await click(fixture.querySelector<HTMLButtonElement>('[aria-label="店铺资料"]')!)
    const key = document.querySelector<HTMLInputElement>("#store-api-key")!
    if (permissions.manage_key) {
      setInput(document.querySelector<HTMLInputElement>("#store-label")!, "尚未保存的名称"); setInput(key, "bad-key"); await click(byText("验证并保存"))
      check(key.value === "bad-key", "failed key save must retain draft")
      check(calls.join(",") === "rename:store-1,key:store-1", "key save must not rename")
      check(roster.stores[0]!.label === "新名字", "key failure must not rename")
    } else {
      check(key.disabled && byText("验证并保存").hasAttribute("disabled"), "ungranted actor must not edit credentials")
    }
    const clear = document.querySelector<HTMLButtonElement>("button[title^=\"只删除托管密钥\"]")
    if (permissions.manage_key) {
      check(clear, "authorized clear button missing"); await click(clear)
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      await click(byText("清除密钥", dialogs.at(-1)!))
      check([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some((d) => d.textContent?.includes("清除这家店的密钥")), "failed clear must retain confirmation")
      check(calls.at(-1) === "clear", "clear endpoint was not called")
    } else check(!clear, "ungranted actor must not clear credentials")
    if (role === "manager") check(!document.querySelector('[aria-label="允许指派人管理密钥"]'), "manager must not grant key permissions")
  })
}

async function newStoreCheck() {
  await mounted(async () => {
    await click(byText("新增店铺"))
    const label = document.querySelector<HTMLInputElement>("#store-label")!
    check(label.value === "", "new store must start with an empty name")
    const client = document.querySelector<HTMLInputElement>("#store-client-id")!
    check(client && !client.disabled, "new store draft must allow credential entry")
    check(!document.querySelector("button[title^=\"只删除托管密钥\"]"), "new store draft must not offer clear")
    const newTag = document.querySelector<HTMLInputElement>("#store-new-tag")
    if (newTag) {
      setInput(newTag, "新标签")
      await click(byText("新建"))
      check(calls.includes("tag-create:新标签"), "inline tag creation must call the API")
      const attached = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button[aria-pressed="true"]')]
      check(attached.some((button) => button.textContent?.trim() === "新标签"), "created tag must attach to the draft")
    } else check(role === "member", "only a member loses inline tag creation")
    setInput(label, "新店先命名")
    check(byText("验证并保存").hasAttribute("disabled"), "incomplete new store must not submit")
    setInput(client, "12345"); setInput(document.querySelector<HTMLInputElement>("#store-api-key")!, "bad-key")
    await click(byText("验证并保存"))
    check(calls.filter((call) => call.startsWith("key:")).length === 1, "new store must submit one credential upsert")
  })
}

let previewRoot = createRoot(fixture)
resetMocks(); flushSync(() => previewRoot.render(<StoresScreen overview={overview} />))
run.onclick = async () => {
  run.disabled = true; previewRoot.unmount(); await settle(); results.textContent = "运行中"; unexpectedRequests.length = 0
  const lines: string[] = []
  try { await storeChecks(); await newStoreCheck(); lines.push("PASS StoresScreen credential checks") } catch (error) { lines.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`) }
  if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
  results.textContent = lines.join("\n"); results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  previewRoot = createRoot(fixture); resetMocks(); flushSync(() => previewRoot.render(<StoresScreen overview={overview} />)); run.disabled = false
}
