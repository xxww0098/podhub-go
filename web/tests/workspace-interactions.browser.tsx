// Dev-only Workspace checks. Every accountHttp call is mocked; fetch is a tripwire.
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { AccountOverview, WorkspaceDirectoryView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Toaster } from "@/components/ui/toast"
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
async function click(el: HTMLElement) { check(!el.hasAttribute("disabled"), "Cannot click disabled control"); flushSync(() => el.click()); await settle() }
async function waitEnabled(el: HTMLButtonElement) { for (let i = 0; i < 8 && el.hasAttribute("disabled"); i++) await settle(); check(!el.hasAttribute("disabled"), "Control stayed disabled") }
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const role = new URLSearchParams(location.search).get("role") ?? "owner"
const errorMode = new URLSearchParams(location.search).has("error")
const autoInvite = new URLSearchParams(location.search).has("invite")
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
let invitationCalls = 0
let removeCalls = 0
let directoryCalls = 0
let rejectInvite = false
let rejectRemove = false
let inviteDeferred: { resolve: (value: any) => void, reject: (reason: unknown) => void } | undefined
function installMocks() {
  invitationCalls = 0; removeCalls = 0; directoryCalls = 0; rejectInvite = false; rejectRemove = false
  accountHttp.accountGetWorkspaceDirectory = async () => { directoryCalls++; if (errorMode) throw new Error("directory unavailable"); return directory }
  accountHttp.accountCreateWorkspaceInvitation = async () => { invitationCalls++; return new Promise((resolve, reject) => { inviteDeferred = { resolve, reject }; if (!rejectInvite) resolve({ uuid: "550e8400-e29b-41d4-a716-446655440000", token: "a".repeat(42) + "A", email: "new@example.invalid", role: "member", expires_at_ms: 1_760_000_000_000, pending_used: 2, pending_limit: 5, notified: true }) }) }
  accountHttp.accountRemoveWorkspaceMember = async () => { removeCalls++; if (rejectRemove) throw new Error("remove failed") }
  accountHttp.accountListWorkspaces = async () => overview
}
async function mounted(node: ReactNode, action: (root: Root) => Promise<void>, configure?: () => void) { installMocks(); configure?.(); const root = createRoot(fixture); try { flushSync(() => root.render(<Toaster>{node}</Toaster>)); await settle(); await action(root) } finally { flushSync(() => root.unmount()); Object.assign(accountHttp, originals); await settle() } }

async function baseline() { await mounted(<WorkspaceScreen overview={overview} />, async () => { if (restrictedMode || errorMode) return; check(fixture.textContent?.includes("工作空间所有者"), "owner row missing"); check(fixture.textContent?.includes("工作空间管理员"), "manager row missing"); check(fixture.textContent?.includes("工作空间成员"), "member row missing"); check(fixture.textContent?.includes("pending@example.invalid"), "pending invitation missing"); check(directoryCalls >= 1, "directory should load"); if (autoInvite && role !== "member") { await click(byText("邀请成员")); check(document.querySelector('[role="dialog"]'), "?invite=1 should open invite dialog") } }) }
async function inviteGuards() { if (role === "member" || restrictedMode) return; await mounted(<WorkspaceScreen overview={overview} />, async () => { const invite = byText("邀请成员") as HTMLButtonElement; await waitEnabled(invite); await click(invite); const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!; check(dialog, "invite dialog missing"); const email = dialog.querySelector<HTMLInputElement>("#invite-email")!; setInput(email, "new@example.invalid"); await settle(); const cancel = byText("取消", dialog); rejectInvite = true; await click(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!); check(email.disabled, "busy invitation must lock email");
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    check(invitationCalls === 1, "duplicate submit must not create another invitation"); check(cancel.hasAttribute("disabled"), "busy invite must disable close"); check(dialog.querySelectorAll('input[name="role"]').length === (role === "owner" ? 2 : 1), "manager role must be owner-only"); const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true }); dialog.dispatchEvent(esc); check(document.querySelector('[role="dialog"]'), "busy invite must ignore Escape close"); inviteDeferred?.reject(new Error("invite failed")); await settle(); check(dialog.querySelector<HTMLInputElement>("#invite-email")?.value === "new@example.invalid", "failed invite must retain input"); check(document.querySelector('[data-slot="toast"], [role="alertdialog"], [role="alert"], [data-sonner-toast]'), "invite error must be announced by the toast") }) }
async function memberRoleGuard() {
  for (const actor of ["member", "manager"] as const) {
    const actorOverview = { ...overview, session: { ...overview.session, email: `${actor}@example.invalid` }, active_workspace: { ...workspace, role: actor } }
    await mounted(<WorkspaceScreen overview={actorOverview} />, async () => {
      const removeManager = '[aria-label="将 manager@example.invalid 移出工作空间"]'
      check(!fixture.querySelector(removeManager), "only owner may remove managers")
      if (actor === "member") check(byText("邀请成员").hasAttribute("disabled"), "member cannot invite")
      else {
        await click(byText("邀请成员"))
        check(document.querySelectorAll('input[name="role"]').length === 1, "manager may only grant member")
        await click(byText("取消", document.querySelector<HTMLElement>('[role="dialog"]')!))
      }
      await click(fixture.querySelector<HTMLButtonElement>('[aria-label="查看 工作空间管理员 的详情"]')!)
      check(!document.querySelector<HTMLElement>('[role="dialog"]')?.querySelector(removeManager), "manager removal must also be hidden in details")
    }, () => { accountHttp.accountGetWorkspaceDirectory = async () => directoryForRole(actor) })
  }
}
async function removeGuard() { if (role !== "owner") return; await mounted(<WorkspaceScreen overview={overview} />, async () => { const remove = fixture.querySelector<HTMLButtonElement>('[aria-label="将 manager@example.invalid 移出工作空间"]')!; await click(remove); const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!; check(dialog.textContent?.includes("移除工作空间成员"), "remove confirmation missing"); await click(byText("取消", dialog)); check(removeCalls === 0, "cancel must retain member"); await click(remove); rejectRemove = true; await click(byText("移除成员", document.querySelector<HTMLElement>('[role="dialog"]')!)); await settle(); check(document.querySelector('[role="dialog"]'), "failed remove must retain confirmation") }) }
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
  const next = { ...overview, active_workspace: { ...workspace, id: 2, name: "第二工作空间" } }
  await mounted(<WorkspaceScreen overview={overview} />, async (root) => {
    accountHttp.accountGetWorkspaceDirectory = async () => ({ ...directory, members: [member(20, "新工作空间成员", "new-workspace@example.invalid", "member")] })
    flushSync(() => root.render(<WorkspaceScreen overview={next} />))
    await settle()
    resolveOld(directory)
    await settle()
    check(fixture.textContent?.includes("新工作空间成员"), "new workspace directory must remain")
    check(!fixture.textContent?.includes("工作空间所有者"), "late old workspace directory must be ignored")
    if (directory.permissions.invite_roles.length) await click(byText("邀请成员"))
    flushSync(() => root.render(<WorkspaceScreen overview={overview} />))
    await settle()
    check(!document.querySelector('[role="dialog"]'), "switch must discard old invitation form")
  }, () => { accountHttp.accountGetWorkspaceDirectory = () => oldRequest })
}
async function inviteLimits() {
  if (!directory.permissions.invite_roles.length) return
  for (const [data, reason] of [
    [{ ...directory, pending_used: directory.pending_limit }, "待接受的邀请已达上限"],
    [{ ...directory, seats_used: 8 }, "成员名额已满"],
  ] as const) {
    await mounted(<WorkspaceScreen overview={overview} />, async () => {
      check(byText("邀请成员").hasAttribute("disabled"), "full quota must disable invitation")
      check(fixture.textContent?.includes(reason), "full quota reason must be visible")
    }, () => { accountHttp.accountGetWorkspaceDirectory = async () => data })
  }
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
    await click(fixture.querySelector<HTMLButtonElement>(`[aria-label="将 ${targetEmail} 移出工作空间"]`)!)
    await click(byText("移除成员", document.querySelector<HTMLElement>('[role="dialog"]')!))
    for (let i = 0; i < 30 && document.querySelector('[role="dialog"]'); i++) await settle()
    check(removeCalls === 1, "member removal must run once")
    check(!document.querySelector('[role="dialog"]'), "successful removal must close confirmation even if overview fails")
  }, () => { accountHttp.accountListWorkspaces = async () => { throw new Error("overview unavailable") } })
}

let previewRoot = createRoot(fixture)
installMocks()
flushSync(() => previewRoot.render(<WorkspaceScreen overview={overview} />))
run.onclick = async () => { run.disabled = true; previewRoot.unmount(); await settle(); results.textContent = "运行中"; unexpectedRequests.length = 0; const lines: string[] = []; for (const [name, fn] of [["default fixture", baseline], ["invite guards", inviteGuards], ["member role guard", memberRoleGuard], ["remove confirmation", removeGuard], ["restricted member", restrictedMember], ["directory error", directoryError], ["switch isolation", switchIsolation], ["invitation limits", inviteLimits], ["stale leave", staleLeave], ["remove refresh failure", removeRefreshFailure]] as const) { try { await fn(); lines.push(`PASS ${name}`) } catch (e) { lines.push(`FAIL ${name}: ${String(e)}`) } results.textContent = lines.join("\n") } if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`); results.textContent = lines.join("\n"); results.dataset.result = lines.some((x) => x.startsWith("FAIL")) ? "failed" : "passed"; previewRoot = createRoot(fixture); installMocks(); flushSync(() => previewRoot.render(<WorkspaceScreen overview={overview} />)); run.disabled = false }

// ?invite=1 is consumed by baseline after the real WorkspaceScreen has mounted.
