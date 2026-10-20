import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { accountHttp } from "@/bindings/http-account"
import { route } from "@/api/routes"
import type { NotificationView } from "@/bindings/commands"
import { NotificationActions, NotificationBody } from "./notification-detail"
import type { NotificationsController } from "./notifications"
import {
  clearInvitationCredential, installInvitationLink, parseInvitationCredential,
  pendingInvitationCredential, privateInvitationLink,
} from "@/lib/invitation-link"

const credential = { uuid: "550e8400-e29b-41d4-a716-446655440000", token: "a".repeat(42) + "A" }
const link = privateInvitationLink(credential, "https://podhub.example.invalid")

function browser(href = link) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = new Map<string, string>()
  const events = new EventTarget()
  const win = {
    location: new URL(href),
    history: { replaceState: (_state: unknown, _unused: string, next: string) => {
      win.location = new URL(next, win.location)
    } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  return { win, storage, restore: () => {
    clearInvitationCredential()
    if (original) Object.defineProperty(globalThis, "window", original)
    else Reflect.deleteProperty(globalThis, "window")
  } }
}

test("private links put proof only in the fragment; pasted proofs must match the target", () => {
  const url = new URL(privateInvitationLink(credential, "https://podhub.example.invalid/login?invite=agent"))
  assert.equal(url.pathname, "/")
  assert.equal(url.search, "")
  assert.deepEqual(parseInvitationCredential(url.href), credential)
  assert.deepEqual(parseInvitationCredential(credential.token, credential.uuid), credential)
  assert.deepEqual(parseInvitationCredential(`${credential.uuid}:${credential.token}`), credential)
  assert.equal(parseInvitationCredential(link, "550e8400-e29b-41d4-a716-446655440001"), null)
  for (const invalid of [
    `https://podhub.example.invalid/?workspace_invitation=${credential.uuid}:${credential.token}`,
    `https://podhub.example.invalid/login?invite=${credential.token}`,
    `${link}&workspace_invitation=${credential.uuid}:other`,
    `#workspace_invitation=${credential.uuid}:`,
    `#workspace_invitation=${credential.uuid}:short`,
    `#workspace_invitation=${credential.uuid}:${"a".repeat(44)}`,
    `#workspace_invitation=${credential.uuid}:secret%0Ainjected`,
  ]) assert.equal(parseInvitationCredential(invalid), null)
})

test("opening a link only scrubs and stages proof across login; dismissal clears it", (t) => {
  const { win, storage, restore } = browser(`${link}&tab=notifications`)
  let fetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetches++; throw new Error("No request expected") }
  t.after(() => { globalThis.fetch = originalFetch })
  const remove = installInvitationLink()
  assert.equal(win.location.hash, "#tab=notifications")
  assert.equal(win.location.search, "")
  assert.deepEqual(pendingInvitationCredential(), credential)
  assert.equal(storage.size, 1)
  remove()
  const restored = installInvitationLink()
  t.after(() => { restored(); restore() })
  assert.deepEqual(pendingInvitationCredential(), credential)
  assert.equal(fetches, 0)
  clearInvitationCredential()
  assert.equal(storage.size, 0)
  assert.equal(pendingInvitationCredential(), null)
})

test("accept and decline require proof, send it in JSON, and clear it only after commitment", async (t) => {
  const { storage, restore } = browser()
  let remove = installInvitationLink()
  t.after(() => { remove(); restore() })
  const originalFetch = globalThis.fetch
  const calls: Array<{ path: string; body: unknown; method?: string }> = []
  let status = 403
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)), method: init?.method })
    return new Response(JSON.stringify(status === 200 ? { data: null } : { code: "FORBIDDEN", error: "凭据无效" }), { status })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const respond of [accountHttp.accountAcceptWorkspaceInvitation, accountHttp.accountDeclineWorkspaceInvitation]) {
    await assert.rejects(respond(credential.uuid, undefined as unknown as string), /私下提供/)
    await assert.rejects(respond(credential.uuid, ""), /私下提供/)
    await assert.rejects(respond(credential.uuid, "short"), /私下提供/)
  }
  assert.equal(calls.length, 0)
  await assert.rejects(accountHttp.accountAcceptWorkspaceInvitation(credential.uuid, credential.token))
  assert.deepEqual(pendingInvitationCredential(), credential)
  assert.equal(storage.size, 1)
  status = 200
  await accountHttp.accountAcceptWorkspaceInvitation(credential.uuid, credential.token)
  assert.equal(pendingInvitationCredential(), null)
  assert.equal(storage.size, 0)
  remove()
  window.location.hash = new URL(link).hash
  remove = installInvitationLink()
  await accountHttp.accountDeclineWorkspaceInvitation(credential.uuid, credential.token)
  assert.equal(pendingInvitationCredential(), null)
  assert.equal(storage.size, 0)
  assert.deepEqual(calls.map((call) => call.path), [
    route("invitationsByUuidAccept", { uuid: credential.uuid }), route("invitationsByUuidAccept", { uuid: credential.uuid }),
    route("invitationsByUuidDecline", { uuid: credential.uuid }),
  ])
  for (const call of calls) {
    assert.equal(call.method, "POST")
    assert.deepEqual(call.body, { token: credential.token })
    assert.ok(!call.path.includes(credential.token))
  }
})

test("confirmed sign-out removes the staged proof without persisting account authority", async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: null }))
  t.after(() => { globalThis.fetch = originalFetch })
  for (const signOut of [accountHttp.accountLogout, () => accountHttp.accountLogoutAccount(credential.uuid)]) {
    const { storage, restore } = browser()
    const remove = installInvitationLink()
    try {
      assert.equal(storage.size, 1)
      await signOut()
      assert.equal(storage.size, 0)
      assert.equal(pendingInvitationCredential(), null)
    } finally { remove(); restore() }
  }
})

test("notifications without a private proof fail closed; mounting with proof still never joins", () => {
  let writes = 0
  const controller = {
    writing: false, overviewSyncFailed: false,
    acceptInvitation: async () => { writes++; return true },
    declineInvitation: async () => { writes++; return true },
  } as unknown as NotificationsController
  const notification: NotificationView = {
    uuid: "9b1c4f30-1e5a-4a4f-8a2b-8c1f4f0d1a11", kind: "workspace_invitation", created_at_ms: Date.now(),
    invitation: { uuid: credential.uuid, workspace_id: 7, workspace_name: "目标工作空间", role: "manager",
      inviter_email: "owner@example.invalid", status: "pending", expires_at_ms: Date.now() + 60_000 },
  }
  const missing = renderToStaticMarkup(<NotificationActions notification={notification} controller={controller} />)
  assert.equal((missing.match(/ disabled=""/g) ?? []).length, 2)
  assert.match(missing, /旧邀请.*撤销重发/)
  const supplied = renderToStaticMarkup(<><NotificationBody notification={notification} />
    <NotificationActions notification={notification} controller={controller} credential={credential} /></>)
  assert.doesNotMatch(supplied, / disabled=""/)
  assert.match(supplied, /目标工作空间/)
  assert.match(supplied, /主管/)
  assert.equal(writes, 0)
})
