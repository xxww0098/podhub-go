// Dev-only Workspace checks. Every accountHttp call is mocked; fetch is a tripwire.
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { AccountOverview, WorkspaceDirectoryView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { subscriptionHttp, type SubscriptionView } from "@/bindings/http-subscription"
import { Toaster } from "@/components/ui/toast"
import { SidebarProvider } from "@/components/ui/sidebar"
import { WorkspaceMenu } from "@/components/workspace-switcher"
import { WorkspaceScreen } from "@/features/workspace/workspace-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
window.fetch = async (input) => { unexpectedRequests.push(String(input)); throw new Error(`Unexpected network request: ${input}`) }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function byText(text: string, root: ParentNode = document): HTMLElement {
  const xs = [...root.querySelectorAll<HTMLElement>("button")].filter((x) => x.textContent?.trim() === text && !x.closest('[aria-hidden="true"]'))
  check(xs.length === 1, `Expected one button '${text}', got ${xs.length}`); return xs[0]!
}
async function openMember(name: string) {
  const target = [...fixture.querySelectorAll<HTMLButtonElement>("tbody td:first-child button")].find(button => button.textContent?.includes(name))
  check(target, `Member ${name} missing`)
  await click(target)
}
async function requestRemoval(name: string, email: string) {
  await openMember(name)
  const remove = document.querySelector<HTMLButtonElement>(`[aria-label="将 ${email} 移出工作空间"]`)
  check(remove, `Removal for ${email} missing`)
  await click(remove)
}
async function click(el: HTMLElement) { check(!el.hasAttribute("disabled"), "Cannot click disabled control"); flushSync(() => el.click()); await settle() }
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const role = new URLSearchParams(location.search).get("role") ?? "owner"
const errorMode = new URLSearchParams(location.search).has("error")
const restrictedMode = new URLSearchParams(location.search).has("restricted")
if (new URLSearchParams(location.search).has("mobile")) fixture.style.width = "390px"
const member = (id: number, name: string, email: string, r: string) => ({ id, name, email, role: r, status: "active" as const, joined_at_ms: 1_750_000_000_000, permissions: { remove: (role === "owner" && r !== "owner") || (role === "manager" && r === "member") } })
const directory: WorkspaceDirectoryView = {
  members: [member(1, "工作空间所有者", "owner@example.invalid", "owner"), member(2, "工作空间管理员", "manager@example.invalid", "manager"), member(3, "工作空间成员", "member@example.invalid", "member")],
  invitations: [{ id: 7, uuid: "invite-7", email: "pending@example.invalid", role: "member", invited_by_email: "owner@example.invalid", created_at_ms: 1_755_000_000_000, expires_at_ms: 1_760_000_000_000 }],
  seats_used: 3, pending_used: 1, pending_limit: 5,
  permissions: { invite_roles: role === "owner" ? ["manager", "member"] : role === "manager" ? ["member"] : [], revoke_invitation: role !== "member", edit_profile: role === "owner", dissolve: role === "owner", leave: role !== "owner" },
}
function directoryForRole(actor: "owner" | "manager" | "member"): WorkspaceDirectoryView {
  return {
    ...directory,
    members: directory.members.map((row) => ({
      ...row,
      permissions: { remove: (actor === "owner" && row.role !== "owner") || (actor === "manager" && row.role === "member") },
    })),
    permissions: {
      ...directory.permissions,
      invite_roles: actor === "owner" ? ["manager", "member"] : actor === "manager" ? ["member"] : [],
      revoke_invitation: actor !== "member",
      edit_profile: actor === "owner",
      dissolve: actor === "owner",
      leave: actor !== "owner",
    },
  }
}
const workspace = { id: 1, uuid: "550e8400-e29b-41d4-a716-446655440000", name: "深度优化 Workspace", plan: "pro", role, is_owned: role === "owner" }
const overview = (restrictedMode ? { session: { authenticated: true, email: "member@example.invalid", name: "member", role: "member" }, workspaces: [], account_mode: "member", owned_count: 0, owned_limit: 0 } : { session: { authenticated: true, email: `${role}@example.invalid`, name: role, role }, entitlement: { plan: "pro", features: { ai_relay: true, ocr: true, batch_listing: true, field_package: false }, limits: { stores: 3, stores_used: 1, seats: 8, seats_used: 3, s3_upload_bytes_monthly: 1, s3_upload_bytes_used: 0, ai_tokens_monthly: 1, ai_tokens_used: 0, ai_calls_per_day: 1 } }, active_workspace: workspace, workspaces: [workspace], account_mode: role === "member" ? "member" : "owner", owned_count: 1, owned_limit: 3 }) as AccountOverview

const originals = { ...accountHttp }
const originalSubscription = { ...subscriptionHttp }
const capacityView = (used: number, limit: number) => ({ members: { used, limit } }) as SubscriptionView
let removeCalls = 0
let directoryCalls = 0
let rejectRemove = false
function installMocks() {
  removeCalls = 0; directoryCalls = 0; rejectRemove = false
  accountHttp.accountGetWorkspaceDirectory = async () => { directoryCalls++; if (errorMode) throw new Error("directory unavailable"); return directory }
  accountHttp.accountRemoveWorkspaceMember = async () => { removeCalls++; if (rejectRemove) throw new Error("remove failed") }
  accountHttp.accountListWorkspaces = async () => overview
  subscriptionHttp.view = async () => capacityView(3, 8)
}
async function mounted(node: ReactNode, action: (root: Root) => Promise<void>, configure?: () => void) { installMocks(); configure?.(); const root = createRoot(fixture); try { flushSync(() => root.render(<Toaster>{node}</Toaster>)); await settle(); await action(root) } finally { flushSync(() => root.unmount()); Object.assign(accountHttp, originals); Object.assign(subscriptionHttp, originalSubscription); await settle() } }

async function baseline() { await mounted(<WorkspaceScreen overview={overview} />, async () => {
  if (restrictedMode || errorMode) return
  check(fixture.textContent?.includes("工作空间所有者"), "owner row missing")
  check(fixture.textContent?.includes("工作空间管理员"), "manager row missing")
  check(fixture.textContent?.includes("工作空间成员"), "member row missing")
  check(!fixture.textContent?.includes("pending@example.invalid"), "pending invitations must have their own tab")
  await click(byText("邀请", fixture))
  check(fixture.textContent?.includes("pending@example.invalid"), "pending invitation missing")
  check(!fixture.textContent?.includes("工作空间所有者"), "members must not appear in the invitation tab")
  await click(byText("成员", fixture))
  check(fixture.textContent?.includes("工作空间所有者"), "member tab must restore the directory")
  check(directoryCalls >= 1, "directory should load")
  check(fixture.textContent?.includes("成员 3 / 8"), "subscription capacity missing")
}) }
async function switcherInviteUnavailable() {
  if (role === "member" || restrictedMode) return
  await mounted(<SidebarProvider><WorkspaceMenu overview={overview} onOpenSpace={() => {}} /></SidebarProvider>, async () => {
    const trigger = fixture.querySelector<HTMLElement>('button[aria-label^="工作空间 "]')
    check(trigger, "workspace switcher trigger missing")
    await click(trigger)
    check(!document.querySelector('[role="menuitem"][aria-label^="邀请成员"]'), "unimplemented invitation entry must be absent")
  })
}
async function memberRoleGuard() {
  for (const actor of ["member", "manager"] as const) {
    const actorOverview = { ...overview, session: { ...overview.session, email: `${actor}@example.invalid` }, active_workspace: { ...workspace, role: actor } }
    await mounted(<WorkspaceScreen overview={actorOverview} />, async () => {
      const removeManager = '[aria-label="将 manager@example.invalid 移出工作空间"]'
      check(!fixture.querySelector(removeManager), "only owner may remove managers")
      await openMember("工作空间管理员")
      check(!document.querySelector<HTMLElement>('[role="dialog"]')?.querySelector(removeManager), "manager removal must also be hidden in details")
    }, () => { accountHttp.accountGetWorkspaceDirectory = async () => directoryForRole(actor) })
  }
}
async function removeGuard() {
  if (role !== "owner") return
  await mounted(<WorkspaceScreen overview={overview} />, async () => {
    await requestRemoval("工作空间管理员", "manager@example.invalid")
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    check(dialog.textContent?.includes("移除工作空间成员"), "remove confirmation missing")
    await click(byText("取消", dialog))
    check(removeCalls === 0, "cancel must retain member")
    await requestRemoval("工作空间管理员", "manager@example.invalid")
    rejectRemove = true
    await click(byText("移除成员", document.querySelector<HTMLElement>('[role="dialog"]')!))
    check(document.querySelector('[role="dialog"]'), "failed remove must retain confirmation")
  })
}
async function restrictedMember() {
  const restricted: AccountOverview = { ...overview, active_workspace: undefined, workspaces: [], account_mode: "member" }
  await mounted(<WorkspaceScreen overview={restricted} />, async () => {
    check(fixture.textContent?.includes("工作空间访问受限"), "restricted member message missing")
    check(fixture.textContent?.includes("离开工作空间"), "restricted member needs Leave action")
    check(directoryCalls === 0, "restricted member must not request directory")
  })
}
async function directoryError() {
  await mounted(<WorkspaceScreen overview={overview} />, async () => {
    check(document.querySelector('[data-slot="toast"], [role="alertdialog"], [role="alert"]'), "directory error must be announced by the toast")
    check(!fixture.textContent?.includes("directory unavailable"), "directory error must stay out of the page")
    check(!fixture.textContent?.includes("没有符合当前条件的成员"), "directory error must not look empty")
  }, () => { accountHttp.accountGetWorkspaceDirectory = async () => { throw new Error("directory unavailable") } })
}
async function switchIsolation() {
  let resolveOld!: (value: WorkspaceDirectoryView) => void
  const oldRequest = new Promise<WorkspaceDirectoryView>((resolve) => { resolveOld = resolve })
  let resolveOldCapacity!: (value: SubscriptionView) => void
  const oldCapacity = new Promise<SubscriptionView>((resolve) => { resolveOldCapacity = resolve })
  const next = { ...overview, active_workspace: { ...workspace, id: 2, name: "第二工作空间" } }
  await mounted(<WorkspaceScreen overview={overview} />, async (root) => {
    accountHttp.accountGetWorkspaceDirectory = async () => ({ ...directory, members: [member(20, "新工作空间成员", "new-workspace@example.invalid", "member")] })
    subscriptionHttp.view = async () => capacityView(2, 10)
    flushSync(() => root.render(<WorkspaceScreen overview={next} />))
    await settle()
    resolveOld(directory)
    resolveOldCapacity(capacityView(8, 8))
    await settle()
    check(fixture.textContent?.includes("新工作空间成员"), "new workspace directory must remain")
    check(!fixture.textContent?.includes("工作空间所有者"), "late old workspace directory must be ignored")
    check(fixture.textContent?.includes("成员 2 / 10"), "late old workspace capacity must be ignored")
    flushSync(() => root.render(<WorkspaceScreen overview={overview} />))
    await settle()
    check(!document.querySelector('[role="dialog"]'), "switch must discard old invitation form")
  }, () => { accountHttp.accountGetWorkspaceDirectory = () => oldRequest; subscriptionHttp.view = () => oldCapacity })
}
async function missingEntitlement() {
  const noEntitlement = { ...overview, entitlement: undefined }
  await mounted(<WorkspaceScreen overview={noEntitlement} />, async () => {
    check(fixture.textContent?.includes("成员 3 / 8"), "subscription is authoritative even when overview lacks entitlement")
  })
  await mounted(<WorkspaceScreen overview={noEntitlement} />, async () => {
    check(!fixture.textContent?.includes("成员 3 / 8"), "failed subscription read must not reuse an old limit")
  }, () => { subscriptionHttp.view = async () => { throw new Error("subscription unavailable") } })
}
async function staleLeave() {
  let resolveLeave!: (value: AccountOverview) => void
  let updates = 0
  const memberOverview = { ...overview, active_workspace: { ...workspace, role: "member" } }
  const memberDirectory: WorkspaceDirectoryView = {
    ...directory,
    permissions: { ...directory.permissions, invite_roles: [], revoke_invitation: false, edit_profile: false, dissolve: false, leave: true },
    members: directory.members.map((row) => ({ ...row, permissions: { remove: false } })),
  }
  await mounted(<WorkspaceScreen overview={memberOverview} onOverviewChange={() => { updates++ }} />, async (root) => {
    await click(byText("离开工作空间"))
    await click(byText("离开工作空间", document.querySelector<HTMLElement>('[role="dialog"]')!))
    flushSync(() => root.render(<WorkspaceScreen overview={{ ...overview, active_workspace: { ...workspace, id: 2 } }} onOverviewChange={() => { updates++ }} />))
    resolveLeave(memberOverview)
    await settle()
    check(updates === 0, "late exit must not replace current overview")
  }, () => {
    accountHttp.accountGetWorkspaceDirectory = async () => memberDirectory
    accountHttp.accountLeaveWorkspace = () => new Promise((resolve) => { resolveLeave = resolve })
  })
}
async function removeRefreshFailure() {
  if (role === "member" || restrictedMode || errorMode) return
  const targetEmail = role === "owner" ? "manager@example.invalid" : "member@example.invalid"
  await mounted(<WorkspaceScreen overview={overview} />, async () => {
    await requestRemoval(role === "owner" ? "工作空间管理员" : "工作空间成员", targetEmail)
    await click(byText("移除成员", document.querySelector<HTMLElement>('[role="dialog"]')!))
    const confirmation = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => dialog.textContent?.includes("移除工作空间成员？"))
    for (let i = 0; i < 30 && confirmation(); i++) await settle()
    check(removeCalls === 1, "member removal must run once")
    check(!confirmation(), "successful removal must close confirmation even if overview fails")
    check(document.body.textContent?.includes("成员已移除，但工作空间信息刷新失败"), "refresh failure must still be announced")
  }, () => { accountHttp.accountListWorkspaces = async () => { throw new Error("overview unavailable") } })
}

let previewRoot = createRoot(fixture)
installMocks()
flushSync(() => previewRoot.render(<WorkspaceScreen overview={overview} />))
run.onclick = async () => { run.disabled = true; previewRoot.unmount(); await settle(); results.textContent = "运行中"; unexpectedRequests.length = 0; const lines: string[] = []; for (const [name, fn] of [["default fixture", baseline], ["switcher invitation unavailable", switcherInviteUnavailable], ["member role guard", memberRoleGuard], ["remove confirmation", removeGuard], ["restricted member", restrictedMember], ["directory error", directoryError], ["switch isolation", switchIsolation], ["missing entitlement", missingEntitlement], ["stale leave", staleLeave], ["remove refresh failure", removeRefreshFailure]] as const) { try { await fn(); lines.push(`PASS ${name}`) } catch (e) { lines.push(`FAIL ${name}: ${String(e)}`) } results.textContent = lines.join("\n") } if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`); results.textContent = lines.join("\n"); results.dataset.result = lines.some((x) => x.startsWith("FAIL")) ? "failed" : "passed"; previewRoot = createRoot(fixture); installMocks(); flushSync(() => previewRoot.render(<WorkspaceScreen overview={overview} />)); run.disabled = false }
