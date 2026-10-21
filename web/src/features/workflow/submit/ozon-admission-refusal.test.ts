import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"
import { projectOzonListingIssue } from "./ozon-admission-refusal"
import type { FrozenItem } from "../platforms/core"
import type { OzonBody } from "../platforms/ozon"

for (const [status, serverCode, code] of [[409, "offer_busy", "cloud_offer_busy"], [400, "validation", "cloud_validation"]] as const) {
  test(`legacy ${status} request preserves structured cause and whole-request scope at the exported boundary`, async () => {
    const original = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => { requests++; return Response.json({ code: serverCode, error: "raw provider text must not become a row cause" }, { status, headers: { "x-request-id": "http-trace" } }) }
    const context: OzonSendContext = { storeId: "s1", pins: new Map([["a", { revision: 1 }], ["b", { revision: 2 }]]), shouldStop: () => false, results: new Map(), syncRequired: false, replayed: false }
    const items: FrozenItem<OzonBody>[] = ["a", "b"].map((key) => ({ key, body: { rowId: key, storeId: "s1", offerId: key, import: {}, evidence: { digest: "preview", card_defaults_digest: "fixture-defaults", sources: [] } }, digest: "preview", clientOperationId: `preview-${key}`, provenance: [] }))
    try {
      await submitOzonChunk(context, items)
      assert.equal(requests, 1)
      for (const rowId of ["a", "b"]) {
        const result = context.results.get(rowId)!
        assert.equal(result.outcome, "blocked")
        assert.equal(result.error!.code, code)
        assert.equal(result.error!.serverCode, serverCode)
        assert.equal(result.error!.traceId, "http-trace")
        assert.deepEqual(result.error!.requestCause, { kind: "request_refusal", scope: "request", storeId: "s1", rowIds: ["a", "b"], status, serverCode, traceId: "http-trace", admission: status === 409 ? "offer_busy" : undefined })
        assert.equal(result.error!.listingIssue, undefined, "ListingErrorResponse has no typed ListingIssue; never invent one")
        assert.equal(result.submissionReceipt, undefined)
        assert.doesNotMatch(result.error!.message, /raw provider/)
        if (status === 409) {
          assert.match(result.error!.message, /发送中.*未确认.*已受理.*不表示块内每个货号/)
          assert.doesNotMatch(result.error!.remediation!, /释放/)
        }
      }
    } finally { globalThis.fetch = original }
  })
}

test("actual ListingIssue safe projection preserves Cloud summary, actions, scope and its own trace", () => {
  const issue = { code: "OZON_ROW_REJECTED", phase: "submit", scope: "row", summary: "Cloud summary", remediation: "Cloud next step", allowed_actions: ["edit_row"], trace_id: "job-trace", intent_id: "i1", row_id: "r1", store_id: "s1", dispatch_evidence: "rejected", safe_message: "not a display field", arbitrary: "never project" }
  assert.deepEqual(projectOzonListingIssue(issue), { code: issue.code, phase: issue.phase, scope: issue.scope, summary: issue.summary, remediation: issue.remediation, allowedActions: issue.allowed_actions, traceId: issue.trace_id, intentId: issue.intent_id, rowId: issue.row_id, storeId: issue.store_id, dispatchEvidence: issue.dispatch_evidence })
  assert.equal(projectOzonListingIssue({ ...issue, allowed_actions: ["invented_action"] }), undefined)
})

for (const phase of ["headers timeout", "body timeout", "body success"] as const) {
  test(`legacy submit keeps one 150000ms deadline through Stop and ${phase}`, async () => {
    const originalFetch = globalThis.fetch, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
    // Allocate a correctly typed handle, then cancel it: the deadline is advanced explicitly.
    const handle = originalSet(() => {}, 150_000)
    originalClear(handle)
    let fireDeadline: (() => void) | undefined
    let timers = 0, clears = 0, requests = 0, aborts = 0, stopped = false
    let signal: AbortSignal | undefined
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => { ready = resolve })
    globalThis.setTimeout = new Proxy(originalSet, {
      apply(_target, _receiver, args) {
        timers++
        assert.equal(args[1], 150_000, "submit must use the S16 request deadline")
        assert.equal(typeof args[0], "function")
        fireDeadline = () => Reflect.apply(args[0], undefined, args.slice(2))
        return handle
      },
    })
    globalThis.clearTimeout = new Proxy(originalClear, {
      apply(target, receiver, args) {
        if (args[0] === handle) clears++
        return Reflect.apply(target, receiver, args)
      },
    })
    const context: OzonSendContext = { storeId: "s1", pins: new Map([["a", { revision: 1 }], ["b", { revision: 2 }]]), shouldStop: () => stopped, results: new Map(), syncRequired: false, replayed: false }
    const items: FrozenItem<OzonBody>[] = ["a", "b"].map((key) => ({ key, body: { rowId: key, storeId: "s1", offerId: key, import: {}, evidence: { digest: "preview", card_defaults_digest: "fixture-defaults", sources: [] } }, digest: "preview", clientOperationId: `preview-${key}`, provenance: [] }))
    globalThis.fetch = async (input, init) => {
      requests++
      assert.equal(String(input), route("listingSubmit"))
      assert.ok(init)
      assert.equal(init.method, "POST")
      assert.equal(init.body, JSON.stringify({ store_id: "s1", row_ids: ["a", "b"],
        expected_revisions: [{ row_id: "a", revision: 1 }, { row_id: "b", revision: 2 }] }))
      signal = init.signal ?? undefined
      assert.ok(signal)
      signal.addEventListener("abort", () => { aborts++ }, { once: true })
      if (phase === "headers timeout") {
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
          ready()
        })
      }
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        body = controller
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true })
      } }))
      const text = response.text.bind(response)
      response.text = () => { ready(); return text() }
      return response
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<never>((_resolve, reject) => {
      watchdog = originalSet(() => reject(new Error("controlled submit did not reach or settle its wait")), 3000)
    })
    try {
      const sending = submitOzonChunk(context, items)
      await Promise.race([waiting, bounded, sending.then(() => { throw new Error("submit settled before reaching the controlled wait") })])
      assert.equal(timers, 1, "the actual submit must arm exactly one 150000ms timer")
      assert.ok(fireDeadline)
      assert.equal(clears, 0, "headers must not clear the body deadline")
      stopped = true
      assert.equal(context.shouldStop("a"), true)
      assert.equal(signal!.aborted, false, "Stop must leave the dispatched request alive")
      assert.equal(context.results.size, 0)
      assert.equal(timers, 1, "Stop must not reset the original deadline")
      if (phase === "body success") {
        assert.ok(body)
        body.enqueue(new TextEncoder().encode(JSON.stringify({ data: { items: ["a", "b"].map((rowId) => ({ row_id: rowId, created: false, skipped: "waiting" })) } })))
        body.close()
      } else fireDeadline()
      await Promise.race([sending, bounded])
      assert.equal(requests, 1, "no retry or follow-up request")
      assert.equal(timers, 1)
      assert.equal(clears, 1, "the original deadline must be cleared exactly once")
      assert.equal(aborts, phase === "body success" ? 0 : 1)
      assert.equal(context.syncRequired, false)
      assert.equal(context.results.size, 2)
      for (const rowId of ["a", "b"]) {
        const result = context.results.get(rowId)!
        assert.equal(result.outcome, phase === "body success" ? "noop" : "unknown")
        assert.equal(result.noop_reason, phase === "body success" ? "waiting" : "result_unconfirmed")
        if (phase !== "body success") assert.equal(result.error?.requestCause?.kind, "result_unconfirmed")
      }
    } finally {
      originalClear(watchdog)
      if (clears === 0) fireDeadline?.()
      globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear
    }
  })
}
