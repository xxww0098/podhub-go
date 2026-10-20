import assert from "node:assert/strict"
import test from "node:test"
import { ROUTES } from "@/api/routes"
import { createErrorFeedbackReporting } from "./error-feedback-reporting"

function harness(fetcher: typeof fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch) {
  let now = 0
  let online = true
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const calls: RequestInit[] = []
  const reporting = createErrorFeedbackReporting({
    fetch: (async (url, init) => { calls.push(init!); return fetcher(url, init) }) as typeof fetch,
    now: () => now, deviceId: () => "spa-test", isOnline: () => online,
    setTimer: (run, ms) => { const id = ++next; timers.set(id, { at: now + ms, run }); return id as unknown as ReturnType<typeof setTimeout> },
    clearTimer: (id) => { timers.delete(id as unknown as number) },
  })
  const advance = async (ms: number) => {
    now += ms
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run() }
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { ...reporting, calls, advance, offline: () => { online = false }, online: () => { online = true } }
}
const input = { errorId: "12345678901234567890", code: "http.failed", stage: "submit", status: 503, rowId: "row-1" }

test("automatic receipts whitelist fields, deduplicate accepted IDs and preserve numeric strings", async () => {
  const h = harness((async () => Response.json({ data: { accepted: [input.errorId], rejected: [] } })) as typeof fetch)
  h.report(input)
  await h.flush()
  assert.equal(h.calls.length, 0)
  h.setContext({ sessionKey: "a" })
  h.report({ ...input, message: "SECRET", rawPayload: { token: "SECRET" } } as typeof input)
  await h.advance(0)
  h.report(input)
  await h.advance(5_000)
  assert.equal(h.calls.length, 1)
  const event = JSON.parse(h.calls[0]!.body as string).events[0]
  assert.equal(event.kind, "error_feedback.v1")
  assert.deepEqual(JSON.parse(event.payload_json), input)
  assert.equal(h.calls[0]!.credentials, "include")
})

test("bounded queue, retry attempts and offline expiry", async () => {
  const h = harness()
  h.setContext({ sessionKey: "a" })
  h.report(input)
  await h.flush()
  await h.advance(1_000)
  await h.advance(2_000)
  await h.advance(10_000)
  assert.equal(h.calls.length, 3)
  h.setContext({ sessionKey: "b" })
  h.offline()
  for (let i = 0; i < 110; i++) h.report({ ...input, errorId: String(i).padStart(20, "0") })
  await h.flush()
  h.online()
  await h.advance(120_001)
  assert.equal(h.calls.length, 3)
})

test("session switch aborts a hung request and ignores its late acknowledgement", async () => {
  let resolve!: (response: Response) => void
  const h = harness((() => new Promise<Response>((done) => { resolve = done })) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  h.report(input)
  const old = h.flush()
  h.setContext({ sessionKey: "b" })
  await old
  assert.equal(h.calls[0]!.signal!.aborted, true)
  h.report(input)
  resolve(Response.json({ data: { accepted: [input.errorId], rejected: [] } }))
  await h.advance(0)
  assert.equal(h.calls.length, 2)
  h.setContext({ sessionKey: null })
})

test("environment fields that match the receipt stay, and secrets are left out", async () => {
  const h = harness((async () => Response.json({ data: { accepted: [input.errorId], rejected: [] } })) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  const media = { stage: "ready_to_publish" as const, imageTotal: 8, objects: "bound:8,unbound:0", publicUrl: "https://cdn.example/a.jpg" }
  h.report({ ...input, appVersion: "0.0.98", userId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    workspaceId: "11111111-2222-3333-4444-555555555555", userAgent: "token=secret",
    apiPath: `${ROUTES.listingSubmit}?sig=secret`, requestId: "req-1", apiStatus: 200, media })
  await h.advance(0)
  const payload = JSON.parse(JSON.parse(h.calls[0]!.body as string).events[0].payload_json)
  assert.equal(payload.appVersion, "0.0.98")
  assert.equal(payload.userId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  assert.equal(payload.workspaceId, "11111111-2222-3333-4444-555555555555")
  assert.equal(payload.requestId, "req-1")
  assert.equal(payload.apiStatus, 200)
  assert.equal(payload.userAgent, undefined)
  assert.equal(payload.apiPath, undefined)
  assert.deepEqual(payload.media, { stage: "ready_to_publish", imageTotal: 8, objects: "bound:8,unbound:0" })
  assert.doesNotMatch(h.calls[0]!.body as string, /token|sig=|https/)
})

test("a bad refusal reason is omitted and a concrete one is kept", async () => {
  const h = harness((async () => Response.json({ data: { accepted: [input.errorId], rejected: [] } })) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  h.report({ ...input, refusalReason: "operation_failed" })
  await h.advance(0)
  const dropped = JSON.parse(JSON.parse(h.calls[0]!.body as string).events[0].payload_json)
  assert.equal(dropped.refusalReason, undefined)
  assert.equal(dropped.code, input.code)
  h.report({ ...input, errorId: "12345678901234567891", refusalReason: "media_not_ready" })
  await h.advance(250)
  const kept = JSON.parse(JSON.parse(h.calls[1]!.body as string).events[0].payload_json)
  assert.equal(kept.refusalReason, "media_not_ready")
})

test("invalid input is dropped; auth loss stops automatic reporting", async () => {
  const h = harness((async () => new Response(null, { status: 401 })) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  h.report({ ...input, code: "raw error message" })
  h.report({ ...input, errorId: "abc" })
  h.report({ ...input, traceId: "https://secret" })
  h.report({ ...input, status: 999 })
  await h.flush()
  assert.equal(h.calls.length, 0)
  h.report(input)
  await h.flush()
  h.report({ ...input, errorId: "00000000000000000000" })
  await h.advance(10_000)
  assert.equal(h.calls.length, 1)
})

test("timeout fences a transport ignoring abort and permits bounded retries", async () => {
  const h = harness((() => new Promise<Response>(() => {})) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  h.report(input)
  void h.flush()
  await h.advance(5_000)
  assert.equal(h.calls[0]!.signal!.aborted, true)
  await h.advance(1_000)
  assert.equal(h.calls.length, 2)
  h.setContext({ sessionKey: null })
})

test("500 simultaneous failures drain in 20-item chunks without losing or duplicating IDs", async () => {
  const received: string[] = []
  const h = harness((async (_url, init) => {
    const ids = JSON.parse(init!.body as string).events.map((event: { id: string }) => event.id) as string[]
    assert.ok(ids.length <= 20)
    received.push(...ids)
    return Response.json({ data: { accepted: ids, rejected: [] } })
  }) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  for (let i = 0; i < 500; i++) {
    const event = { ...input, errorId: String(i).padStart(20, "0") }
    h.report(event)
    h.report(event)
  }
  for (let i = 0; i < 26; i++) await h.advance(1_000)
  assert.equal(received.length, 500)
  assert.equal(new Set(received).size, 500)
  assert.equal(h.calls.length, 25)
})

test("1000-item bound and partial receipt retry do not discard unacknowledged events", async () => {
  const h = harness((async (_url, init) => {
    const ids = JSON.parse(init!.body as string).events.map((event: { id: string }) => event.id)
    return Response.json({ data: { accepted: ids.slice(0, 10), rejected: [] } })
  }) as typeof fetch)
  h.setContext({ sessionKey: "a" })
  for (let i = 0; i < 1_100; i++) h.report({ ...input, errorId: String(i).padStart(20, "0") })
  for (let i = 0; i < 110; i++) await h.advance(1_000)
  const sent = h.calls.flatMap((call) => JSON.parse(call.body as string).events.map((event: { id: string }) => event.id))
  assert.equal(new Set(sent).size, 1_000)
  assert.ok(sent.length > 1_000)
  h.setContext({ sessionKey: null })
})
