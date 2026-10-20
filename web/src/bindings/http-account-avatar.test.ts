import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { accountHttp } from "./http-account"

const WS = 42
const WS_PATH = route("avatarsWorkspacesByWorkspaceId", { workspace_id: WS })
const WS_UPLOAD = route("avatarsWorkspacesByWorkspaceIdUpload", { workspace_id: WS })
const OVERVIEW = route("viewAccountOverview")
const CLOUD = "/api"
import { invalidateAllSessionCaches } from "@/lib/session-cache"

const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" })
const storage = "https://avatar-origin.invalid/private/staging/image?secret=bearer"
const target = () => ({ upload: { url: storage, expires_at_ms: Date.now() + 600_000,
  headers: { content_type: "image/jpeg", if_none_match: "*" } }, upload_ticket: "private-upload-ticket" })
const overview = { session: { authenticated: true }, workspaces: [], owned_count: 0, owned_limit: 3 }
type Call = { url: string, method: string, init: RequestInit | undefined, body: unknown }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status < 300 ? { data } : data), { status, headers: { "content-type": "application/json" } })
}
function stub(reply: (call: Call) => Response | Promise<Response>) {
  invalidateAllSessionCaches()
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call = { url, method: init?.method ?? "GET", init,
      body: url.startsWith(CLOUD + "/") && init?.body != null ? JSON.parse(String(init.body)) : init?.body }
    calls.push(call)
    return reply(call)
  }) as typeof fetch
  return { calls, restore() { invalidateAllSessionCaches(); globalThis.fetch = previous } }
}
function normal(call: Call): Response {
  if (call.url === WS_UPLOAD) return json(target())
  if (call.url === storage) return new Response(null, { status: 204 })
  if (call.url === OVERVIEW) return json(overview)
  return json({ avatar_revision: 12 })
}
function actions(calls: Call[]) { return calls.map((call) => `${call.method} ${call.url}`) }
const subject = { workspace: { workspace_id: WS } } as const

test("avatar uses metadata grant, anonymous JPEG PUT, ticket confirm then overview", async () => {
  const fetch = stub(normal)
  try {
    await accountHttp.accountSetAvatar({ subject, image })
    assert.deepEqual(actions(fetch.calls), ["POST " + WS_UPLOAD, `PUT ${storage}`, "PUT " + WS_PATH, "GET " + OVERVIEW])
    const spec = fetch.calls[0]!.body as { bytes: number, sha256: string, content_type: string }
    assert.equal(spec.bytes, image.size)
    assert.match(spec.sha256, /^[a-f0-9]{64}$/)
    assert.equal(spec.content_type, "image/jpeg")
    const put = fetch.calls[1]!.init!
    assert.equal(put.body, image)
    assert.equal(put.credentials, "omit")
    assert.equal(put.redirect, "error")
    assert.deepEqual(put.headers, { "Content-Type": "image/jpeg", "If-None-Match": "*" })
    assert.deepEqual(fetch.calls[2]!.body, { upload_ticket: "private-upload-ticket" })
    assert.equal(fetch.calls[2]!.init!.credentials, "include")
  } finally { fetch.restore() }
})

test("already-present grant skips the anonymous PUT and confirms directly", async () => {
  const fetch = stub((call) => call.url === WS_UPLOAD
    ? json({ already_present: true, upload_ticket: "private-upload-ticket" }) : normal(call))
  try {
    await accountHttp.accountSetAvatar({ subject, image })
    assert.deepEqual(actions(fetch.calls), ["POST " + WS_UPLOAD, "PUT " + WS_PATH, "GET " + OVERVIEW])
  } finally { fetch.restore() }
})

test("uncertain anonymous PUT confirms before deciding whether bytes are missing", async () => {
  const fetch = stub((call) => { if (call.url === storage) throw new Error(storage); return normal(call) })
  try {
    await accountHttp.accountSetAvatar({ subject, image })
    assert.deepEqual(actions(fetch.calls), ["POST " + WS_UPLOAD, `PUT ${storage}`, "PUT " + WS_PATH, "GET " + OVERVIEW])
  } finally { fetch.restore() }
})

test("temporary confirmation failure retains receipt and retry confirms without retransmitting", async () => {
  let confirmations = 0
  const fetch = stub((call) => call.url === WS_PATH && confirmations++ === 0
    ? json({ code: "UNAVAILABLE", error: "请稍后重试确认" }, 503) : normal(call))
  try {
    await assert.rejects(accountHttp.accountSetAvatar({ subject, image }), (error: unknown) => {
      const fields = error as { cause?: unknown, message: string }
      assert.equal(fields.cause, undefined)
      assert.doesNotMatch(fields.message, /bearer|private-upload-ticket/)
      return true
    })
    const before = fetch.calls.length
    await accountHttp.accountSetAvatar({ subject, image })
    assert.deepEqual(actions(fetch.calls.slice(before)), ["PUT " + WS_PATH, "GET " + OVERVIEW])
    assert.equal(fetch.calls.filter((call) => call.url === storage).length, 1)
  } finally { fetch.restore() }
})

test("only explicit object missing permits a second PUT after uncertain transfer", async () => {
  let puts = 0, confirmations = 0
  const fetch = stub((call) => {
    if (call.url === storage && puts++ === 0) throw new Error(storage)
    if (call.url === WS_PATH && confirmations++ === 0) return json({ code: "MEDIA_COMPLETE_MISSING", error: "上传对象尚不存在" }, 404)
    return normal(call)
  })
  try {
    await accountHttp.accountSetAvatar({ subject, image })
    assert.deepEqual(actions(fetch.calls), ["POST " + WS_UPLOAD, `PUT ${storage}`, "PUT " + WS_PATH, `PUT ${storage}`, "PUT " + WS_PATH, "GET " + OVERVIEW])
  } finally { fetch.restore() }
})

test("a generic not-found refusal is not permission to retransmit", async () => {
  const fetch = stub((call) => call.url === WS_PATH ? json({ code: "NOT_FOUND", error: "主体已不存在" }, 404) : normal(call))
  try {
    await assert.rejects(accountHttp.accountSetAvatar({ subject, image }))
    assert.equal(fetch.calls.filter((call) => call.url === storage).length, 1)
  } finally { fetch.restore() }
})

test("session invalidation after grant request fences upload and confirmation", async () => {
  let grant!: (response: Response) => void
  let reached!: () => void
  const reachedGrant = new Promise<void>((resolve) => { reached = resolve })
  const waiting = new Promise<Response>((resolve) => { grant = resolve })
  const fetch = stub((call) => { if (call.url === WS_UPLOAD) { reached(); return waiting } return normal(call) })
  try {
    const operation = accountHttp.accountSetAvatar({ subject, image })
    await reachedGrant
    assert.equal(fetch.calls.length, 1)
    invalidateAllSessionCaches()
    grant(json(target()))
    await assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === "avatar_cancelled")
    assert.equal(fetch.calls.length, 1)
  } finally { fetch.restore() }
})

test("caller cancellation during PUT never confirms after cancellation", async () => {
  let complete!: (response: Response) => void
  let reached!: () => void
  const reachedPut = new Promise<void>((resolve) => { reached = resolve })
  const waiting = new Promise<Response>((resolve) => { complete = resolve })
  const fetch = stub((call) => { if (call.url === storage) { reached(); return waiting } return normal(call) })
  const controller = new AbortController()
  try {
    const operation = accountHttp.accountSetAvatar({ subject, image, signal: controller.signal })
    await reachedPut
    controller.abort()
    complete(new Response(null, { status: 204 }))
    await assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === "avatar_cancelled")
    assert.equal(fetch.calls.length, 2)
  } finally { fetch.restore() }
})

test("expired unknown receipt is never evicted into another byte upload", async () => {
  const originalNow = Date.now
  const now = Date.now()
  let confirmations = 0
  const fetch = stub((call) => call.url === WS_PATH ? json({ code: "UNAVAILABLE", error: "确认暂不可用" }, 503) : normal(call))
  try {
    await assert.rejects(accountHttp.accountSetAvatar({ subject, image }))
    confirmations = fetch.calls.length
    Date.now = () => now + 5 * 60 * 60 * 1000
    await assert.rejects(accountHttp.accountSetAvatar({ subject, image }))
    assert.deepEqual(actions(fetch.calls.slice(confirmations)), ["PUT " + WS_PATH])
    assert.equal(fetch.calls.filter((call) => call.url === storage).length, 1)
  } finally { Date.now = originalNow; fetch.restore() }
})
