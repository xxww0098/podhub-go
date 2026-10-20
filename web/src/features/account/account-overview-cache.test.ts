import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { route } from "@/api/routes"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  captureDiagnostic, createDiagnosticPublishAction, enterDiagnosticWorkflowRoute, getDiagnosticCopyData, getDiagnosticDetail,
  openDiagnosticPublishWindow, queueErrorTelemetry, resumeErrorTelemetry, setErrorTelemetryContext,
} from "@/lib/error-telemetry"
import { normalizedProblem, v4Payload, type EventWire } from "@/lib/diagnostic-test-support"
import {
  invalidateAccountOverview,
  loadAccountOverview,
  peekAccountOverview,
  rememberAccountOverview,
  sameAccountOverview,
  subscribeAccountOverview,
} from "./account-overview-cache"

function overview(plan: string): AccountOverview {
  return {
    session: { authenticated: true, email: "op@example.invalid", role: "user" },
    entitlement: {
      plan,
      features: {
        ai_relay: true,
        ocr: true,
        batch_listing: true,
        field_package: true,
      },
      limits: {
        stores: 1,
        stores_used: 0,
        seats: 1,
        seats_used: 1,
        s3_upload_bytes_monthly: 0,
        s3_upload_bytes_used: 0,
        ai_tokens_monthly: 0,
        ai_tokens_used: 0,
        ai_calls_per_day: 0,
      },
    },
    active_workspace: {
      id: 7,
      uuid: "workspace-7",
      name: "运营",
      plan,
      role: "owner",
      is_owned: true,
    },
    workspaces: [
      {
        id: 7,
        uuid: "workspace-7",
        name: "运营",
        plan,
        role: "owner",
        is_owned: true,
      },
    ],
    account_mode: "owner",
    owned_count: 1,
    owned_limit: 3,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function readNearby(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

test("same standing does not count as a change", () => {
  const first = overview("free")
  const copy = overview("free")
  assert.equal(sameAccountOverview(first, copy), true)
  assert.equal(sameAccountOverview(first, overview("ultra")), false)
  assert.equal(sameAccountOverview(null, first), false)
})

test("an identical later read does not notify subscribers", () => {
  invalidateAccountOverview()
  rememberAccountOverview(overview("free"))
  const seen: string[] = []
  const stop = subscribeAccountOverview(() => {
    seen.push(peekAccountOverview()?.entitlement?.plan ?? "none")
  })
  rememberAccountOverview(overview("free"))
  rememberAccountOverview(overview("ultra"))
  stop()
  invalidateAccountOverview()
  assert.deepEqual(seen, ["ultra"])
})

test("a later overview load updates every subscriber", async (t) => {
  invalidateAccountOverview()
  const original = accountHttp.accountGetOverview
  const free = deferred<AccountOverview>()
  const ultra = deferred<AccountOverview>()
  const responses = [free.promise, ultra.promise]
  accountHttp.accountGetOverview = () => responses.shift()!
  t.after(() => {
    accountHttp.accountGetOverview = original
    invalidateAccountOverview()
  })

  const seen: string[] = []
  const stop = subscribeAccountOverview(() => {
    seen.push(peekAccountOverview()?.entitlement?.plan ?? "none")
  })
  t.after(stop)

  const first = loadAccountOverview()
  free.resolve(overview("free"))
  await first
  const second = loadAccountOverview()
  ultra.resolve(overview("ultra"))
  await second
  assert.deepEqual(seen, ["free", "ultra"])
})

test("a request resolved after invalidate cannot repopulate the cache", async (t) => {
  invalidateAccountOverview()
  const original = accountHttp.accountGetOverview
  const pending = deferred<AccountOverview>()
  accountHttp.accountGetOverview = () => pending.promise
  t.after(() => {
    accountHttp.accountGetOverview = original
    invalidateAccountOverview()
  })

  const request = loadAccountOverview()
  invalidateAccountOverview()
  pending.resolve(overview("ultra"))
  await request
  assert.equal(peekAccountOverview(), null)
})

test("an anonymous snapshot clears the store instead of publishing", () => {
  invalidateAccountOverview()
  rememberAccountOverview(overview("free"))
  rememberAccountOverview({
    session: { authenticated: false },
    workspaces: [],
    owned_count: 0,
    owned_limit: 3,
  })
  assert.equal(peekAccountOverview(), null)
})

test("shell, 设置 and sign-out share the overview snapshot", () => {
  const cache = readNearby("./account-overview-cache.ts")
  const queryClientModule = readNearby("../../lib/query-client.ts")
  const app = readNearby("../../app/App.tsx")
  const shell = readNearby("../../app/app-shell.tsx")
  const settings = readNearby("../../app/settings-dialog.tsx")
  const workspace = readNearby("../workspace/workspace-screen.tsx")
  const plans = readNearby("../plans/plans-screen.tsx")

  assert.match(queryClientModule, /from "@tanstack\/react-query"/)
  assert.match(cache, /@tanstack\/react-query/)
  assert.match(app, /rememberAccountOverview/)
  assert.match(app, /invalidateAccountOverview/)
  assert.match(shell, /useAccountOverview/)
  assert.match(shell, /loadAccountOverview/)
  assert.match(settings, /useAccountOverview/)
  assert.match(settings, /loadAccountOverview/)
  assert.match(workspace, /useAccountOverview/)
  assert.match(plans, /useAccountOverview/)
})


test("post-mutation refresh bypasses an earlier poll and fences its stale reply", async (t) => {
  invalidateAccountOverview()
  const original = accountHttp.accountGetOverview
  const stale = deferred<AccountOverview>()
  const fresh = deferred<AccountOverview>()
  const responses = [stale.promise, fresh.promise]
  accountHttp.accountGetOverview = () => responses.shift()!
  t.after(() => { accountHttp.accountGetOverview = original; invalidateAccountOverview() })

  const poll = loadAccountOverview()
  const refresh = loadAccountOverview({ force: true })
  assert.equal(responses.length, 0, "refresh must start a new request")
  fresh.resolve(overview("ultra"))
  assert.equal((await refresh)?.active_workspace?.plan, "ultra")
  stale.resolve(overview("free"))
  await poll
  assert.equal(peekAccountOverview()?.active_workspace?.plan, "ultra")
})

test("Cookie and Workspace writes retire queued errors and stale polls until a fresh overview restores authority", async (t) => {
  const originalGet = accountHttp.accountGetOverview
  const originalFetch = globalThis.fetch
  const delivered: EventWire[] = []
  const authorityCalls: { path: string; method: string | undefined; credentials: RequestCredentials | undefined; retired: boolean }[] = []
  let pendingWrite = deferred<void>()
  let expectedPath = ""
  const leaveRoute = enterDiagnosticWorkflowRoute()
  globalThis.fetch = (async (input, init) => {
    if (String(input) === route("eventsInbox")) {
      assert.equal(init?.method, "POST")
      assert.equal(init?.credentials, "include")
      const { events } = JSON.parse(String(init?.body)) as { events: EventWire[] }
      events.forEach(v4Payload)
      delivered.push(...events)
      return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
    }
    authorityCalls.push({ path: String(input), method: init?.method, credentials: init?.credentials, retired: peekAccountOverview() === null })
    assert.equal(String(input), expectedPath)
    assert.equal(init?.credentials, "include")
    assert.equal(peekAccountOverview(), null, "authority must be retired before the Cookie/Workspace request starts")
    await pendingWrite.promise
    throw new Error("simulated response loss after an authority write")
  }) as typeof fetch
  t.after(() => {
    accountHttp.accountGetOverview = originalGet
    globalThis.fetch = originalFetch
    pendingWrite.resolve()
    invalidateAccountOverview()
    leaveRoute()
  })

  const writes = [
    () => accountHttp.accountLogin({ email: "op@example.invalid", password: "password-1" }),
    () => accountHttp.accountRegister({ email: "op@example.invalid", name: "运营", password: "password-1" }),
    () => accountHttp.accountChangePassword({ current_password: "password-1", new_password: "password-2" }),
    () => accountHttp.accountLogout(),
    () => accountHttp.accountSwitchAccount("account-2"),
    () => accountHttp.accountLogoutAccount("account-1"),
    () => accountHttp.accountSwitchWorkspace(8),
    () => accountHttp.accountCreateWorkspace("新工作空间"),
    () => accountHttp.accountDissolveWorkspace("运营"),
    () => accountHttp.accountLeaveWorkspace(7),
  ]
  const paths = [
    route("authLogin"), route("authRegister"), route("authPassword"), route("authLogout"),
    route("authSwitch"), route("authAccountsByUuid", { uuid: "account-1" }), route("workspacesSwitch"),
    route("workspaces"), route("workspacesDissolve"), route("workspacesLeave"),
  ]
  for (const [index, write] of writes.entries()) {
    expectedPath = paths[index]!
    pendingWrite = deferred<void>()
    invalidateAccountOverview()
    rememberAccountOverview(overview("free"))
    const stale = deferred<AccountOverview>()
    accountHttp.accountGetOverview = () => stale.promise
    const poll = loadAccountOverview()
    const oldText = JSON.stringify({ name: `old-authority-${index}` })
    const old = await captureDiagnostic(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: oldText } }))
    assert.ok(old)
    const oldAction = createDiagnosticPublishAction(`pending-${index}`)
    assert.ok(oldAction)
    assert.equal(getDiagnosticCopyData(old.diagnosticId).originalJson, oldText)
    const failedWrite = assert.rejects(write(), { code: "cloud_unavailable" })
    assert.equal(getDiagnosticDetail(old.diagnosticId).event, null, "authority changes clear local diagnostic details")
    assert.equal(getDiagnosticCopyData(old.diagnosticId).originalJson, null)
    assert.equal(await captureDiagnostic(normalizedProblem()), null)
    assert.equal(openDiagnosticPublishWindow(oldAction, new AbortController().signal), null)
    assert.equal(createDiagnosticPublishAction(`pending-${index}`), null)
    const during = deferred<AccountOverview>()
    accountHttp.accountGetOverview = () => during.promise
    const duringPoll = loadAccountOverview({ force: true })
    if (write === writes[0]) {
      setErrorTelemetryContext({ sessionKey: "old-account:old-workspace" })
      queueErrorTelemetry({ code: "test:mid_write", source: "workbench", severity: "blocking", frames: [] })
      assert.equal(await captureDiagnostic(normalizedProblem()), null, "a positive stale identity is ignored while the write is pending")
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.deepEqual(delivered, [], "a poll cannot re-enable diagnostics while the authority write is pending")
    }
    pendingWrite.resolve()
    await failedWrite
    // Assert outside request's catch: a mock assertion must not masquerade as the expected network failure.
    assert.deepEqual(authorityCalls[index], { path: expectedPath, method: index === 5 ? "DELETE" : "POST", credentials: "include", retired: true })
    assert.equal(authorityCalls.length, index + 1)
    stale.resolve(overview("free"))
    during.resolve(overview("free"))
    await Promise.all([poll, duringPoll])
    assert.equal(peekAccountOverview(), null, "neither a pre-write nor mid-write poll may restore authority after settlement")
    assert.equal(await captureDiagnostic(normalizedProblem()), null)
    const verified = { ...overview("ultra"), session: { authenticated: true, email: "next@example.invalid", role: "user" } }
    accountHttp.accountGetOverview = async () => verified
    await loadAccountOverview({ force: true })
    assert.equal(peekAccountOverview()?.session.email, "next@example.invalid")
    const action = createDiagnosticPublishAction(`verified-${index}`)
    assert.ok(action)
    const window = openDiagnosticPublishWindow(action, new AbortController().signal)
    assert.ok(window)
    try { await window.flush() } finally { window.close() }
    assert.deepEqual(delivered, [], "even an explicit fresh action cannot deliver retired events")
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(delivered, [], "old errors cannot be sent under the refreshed Cookie")

  // Identical standing restores identity; it cannot authorize automatic delivery.
  const verified = peekAccountOverview()!
  setErrorTelemetryContext({ sessionKey: null })
  rememberAccountOverview(verified)
  queueErrorTelemetry({ code: "test:fresh_authority", source: "workbench", severity: "blocking", frames: [] })
  const original = '{"name":"fresh local original","attributes":[{"id":85,"values":[{"value":"private value"}]}]}'
  const input = normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: original } })
  const fresh = await captureDiagnostic(input)
  assert.ok(fresh)
  assert.equal((await captureDiagnostic(input))?.diagnosticId, fresh.diagnosticId)
  assert.equal(getDiagnosticCopyData(fresh.diagnosticId).originalJson, original)
  resumeErrorTelemetry()
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(delivered, [], "fresh standing and general resume do not open a publish window")
  const action = createDiagnosticPublishAction("fresh-authority-report")
  assert.ok(action)
  const window = openDiagnosticPublishWindow(action, new AbortController().signal)
  assert.ok(window)
  try { await window.flush() } finally { window.close() }
  assert.equal(delivered.length, 1)
  const remote = v4Payload(delivered[0]!)
  assert.equal(remote.diagnostic_id, fresh.diagnosticId)
  assert.equal(remote.trace_id, fresh.event?.trace_id)
  assert.equal(remote.code, "result_unknown")
  assert.equal(remote.payload_sha256, createHash("sha256").update(original, "utf8").digest("hex"))
  assert.equal(remote.summary.find((field) => field.field === "attributes[0].id")?.field_id, 85)
  assert.doesNotMatch(JSON.stringify(delivered), /old-authority|fresh local original|private value|password|example\.invalid|workspace-7|rawPayload/)
})

test("an authenticated account without an active Workspace keeps error delivery paused", async (t) => {
  const originalFetch = globalThis.fetch
  let requests = 0
  const leaveRoute = enterDiagnosticWorkflowRoute()
  globalThis.fetch = (async (input) => {
    requests += 1
    assert.equal(String(input), route("eventsInbox"))
    return Response.json({ data: { accepted: [], rejected: [] } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch; invalidateAccountOverview(); leaveRoute() })
  invalidateAccountOverview()
  rememberAccountOverview(overview("free"))
  const action = createDiagnosticPublishAction("no-workspace")
  assert.ok(action)
  rememberAccountOverview({ ...overview("free"), active_workspace: undefined })
  queueErrorTelemetry({ code: "test:no_workspace", source: "workbench", severity: "blocking", frames: [] })
  assert.equal(await captureDiagnostic(normalizedProblem()), null)
  assert.equal(openDiagnosticPublishWindow(action, new AbortController().signal), null)
  assert.equal(createDiagnosticPublishAction("no-workspace"), null)
  resumeErrorTelemetry()
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(requests, 0)
})

test("overlapping Cookie and Workspace writes keep diagnostics fenced until both settle and a fresh poll commits", async (t) => {
  const originalGet = accountHttp.accountGetOverview
  const originalFetch = globalThis.fetch
  const logout = deferred<void>()
  const workspace = deferred<void>()
  const stale = deferred<AccountOverview>()
  const requests: string[] = []
  const leaveRoute = enterDiagnosticWorkflowRoute()
  globalThis.fetch = (async (input, init) => {
    const path = String(input)
    requests.push(path)
    assert.equal(init?.credentials, "include")
    assert.ok(path === route("authLogout") || path === route("workspacesSwitch"))
    await (path === route("authLogout") ? logout.promise : workspace.promise)
    throw new Error("simulated response loss after overlapping writes")
  }) as typeof fetch
  t.after(() => {
    logout.resolve(); workspace.resolve(); stale.resolve(overview("free"))
    accountHttp.accountGetOverview = originalGet
    globalThis.fetch = originalFetch
    invalidateAccountOverview(); leaveRoute()
  })
  invalidateAccountOverview()
  rememberAccountOverview(overview("free"))
  const action = createDiagnosticPublishAction("overlap-pending")
  assert.ok(action)
  accountHttp.accountGetOverview = () => stale.promise
  const stalePoll = loadAccountOverview()
  const first = assert.rejects(accountHttp.accountLogout(), { code: "cloud_unavailable" })
  const second = assert.rejects(accountHttp.accountSwitchWorkspace(8), { code: "cloud_unavailable" })
  accountHttp.accountGetOverview = async () => overview("ultra")
  await loadAccountOverview({ force: true })
  assert.equal(await captureDiagnostic(normalizedProblem()), null, "a poll during overlapping writes cannot restore diagnostic identity")
  logout.resolve()
  await first
  await loadAccountOverview({ force: true })
  setErrorTelemetryContext({ sessionKey: "stale-account:stale-workspace" })
  assert.equal(await captureDiagnostic(normalizedProblem()), null, "settling one write must not release the other write's fence")
  assert.equal(openDiagnosticPublishWindow(action, new AbortController().signal), null)
  assert.equal(createDiagnosticPublishAction("overlap-pending"), null)
  workspace.resolve()
  await second
  stale.resolve(overview("free"))
  await stalePoll
  assert.equal(peekAccountOverview(), null)
  assert.equal(await captureDiagnostic(normalizedProblem()), null, "settlement alone cannot restore identity")
  await loadAccountOverview({ force: true })
  assert.equal(peekAccountOverview()?.active_workspace?.plan, "ultra")
  assert.ok(await captureDiagnostic(normalizedProblem()))
  resumeErrorTelemetry()
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(requests, [route("authLogout"), route("workspacesSwitch")], "fresh identity never dispatches diagnostics automatically")
})

test("active account and Workspace UUID changes clear local originals and held v4 despite unchanged display fields", async (t) => {
  const originalFetch = globalThis.fetch
  const delivered: EventWire[] = []
  const leaveRoute = enterDiagnosticWorkflowRoute()
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), route("eventsInbox"))
    const { events } = JSON.parse(String(init?.body)) as { events: EventWire[] }
    events.forEach(v4Payload)
    delivered.push(...events)
    return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch; invalidateAccountOverview(); leaveRoute() })
  invalidateAccountOverview()
  const first = { ...overview("free"), accounts: [{ active: true, uuid: "account-alpha", email: "op@example.invalid", name: "运营" }] }
  rememberAccountOverview(first)
  const old = await captureDiagnostic(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: '{"name":"alpha private"}' } }))
  assert.ok(old)
  assert.equal(getDiagnosticCopyData(old.diagnosticId).originalJson, '{"name":"alpha private"}')
  const nextAccount = { ...first, accounts: [{ ...first.accounts[0]!, uuid: "account-beta" }] }
  rememberAccountOverview(nextAccount)
  assert.equal(getDiagnosticDetail(old.diagnosticId).event, null)
  assert.equal(getDiagnosticCopyData(old.diagnosticId).originalJson, null)
  const middle = await captureDiagnostic(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: '{"name":"beta private"}' } }))
  assert.ok(middle)
  assert.equal(getDiagnosticCopyData(middle.diagnosticId).originalJson, '{"name":"beta private"}')
  const nextWorkspace = { ...nextAccount.active_workspace!, uuid: "workspace-other" }
  rememberAccountOverview({ ...nextAccount, active_workspace: nextWorkspace, workspaces: [nextWorkspace] })
  assert.equal(getDiagnosticDetail(middle.diagnosticId).event, null)
  assert.equal(getDiagnosticCopyData(middle.diagnosticId).originalJson, null)
  const text = '{"name":"current private"}'
  const current = await captureDiagnostic(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: text } }))
  assert.ok(current)
  assert.equal(getDiagnosticCopyData(current.diagnosticId).originalJson, text)
  assert.notEqual(current.diagnosticId, old.diagnosticId)
  assert.notEqual(current.diagnosticId, middle.diagnosticId)
  assert.equal(delivered.length, 0)
  const action = createDiagnosticPublishAction("current-identity-report")
  assert.ok(action)
  const window = openDiagnosticPublishWindow(action, new AbortController().signal)
  assert.ok(window)
  try { await window.flush() } finally { window.close() }
  assert.deepEqual(delivered.map((event) => v4Payload(event).diagnostic_id), [current.diagnosticId])
  assert.equal(v4Payload(delivered[0]!).payload_sha256, createHash("sha256").update(text, "utf8").digest("hex"))
  assert.doesNotMatch(JSON.stringify(delivered), /alpha private|beta private|current private|account-alpha|account-beta|workspace-other|example\.invalid/)
})
