import assert from "node:assert/strict"
import test from "node:test"
import { Worker } from "node:worker_threads"
import { serializeEvidence, EVIDENCE_PREVIEW_PAGE_SIZE } from "./publish-pipeline-evidence-serialize"
import type { PipelineEvidence } from "./publish-pipeline-metrics"

test("evidence serializer preserves native JSON order, escaping, undefined and numeric semantics in bounded Unicode pages", async () => {
  const input = Object.freeze({ "20": 20, "2": 2, absent: undefined, values: [undefined, NaN, Infinity, -Infinity, -0, null, true],
    text: "x".repeat(8191) + "😀" + "\ud800\u0000\n\t\"\\中文" + "\u0000".repeat(100_000), nested: { after: "kept", before: "kept" } })
  const expected = JSON.stringify(input)
  let yields = 0
  const result = await serializeEvidence(input as unknown as PipelineEvidence, async () => { yields++ })
  assert.equal(result.json, expected)
  assert.equal(result.pages.join(""), expected)
  assert.equal(await result.blob.text(), expected)
  assert.deepEqual(JSON.parse(result.json), JSON.parse(expected))
  assert.match(result.blob.type, /^application\/json(?:;[ \t]*charset=utf-8)?$/i)
  assert.ok(yields > 2)
  assert.equal(result.offsets[0], 0); assert.equal(result.offsets.at(-1), expected.length)
  for (let index = 0; index < result.pages.length; index++) {
    const page = result.pages[index]!
    assert.ok(page.length <= EVIDENCE_PREVIEW_PAGE_SIZE)
    assert.equal(page, expected.slice(result.offsets[index], result.offsets[index + 1]))
    assert.doesNotMatch(page, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  }
  assert.equal(Reflect.set(result.pages, 0, "tampered"), false)
  assert.equal(Reflect.set(result.offsets, 1, 0), false)
})

test("evidence serializer propagates scheduling and non-JSON failures without returning a partial export", async () => {
  const failure = new Error("host yield refused")
  await assert.rejects(serializeEvidence({} as PipelineEvidence, () => Promise.reject(failure)), (error) => error === failure)
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  for (const input of [cycle, { bigint: 1n }, { date: new Date(0) }]) {
    await assert.rejects(serializeEvidence(input as unknown as PipelineEvidence, async () => {}), TypeError)
  }
})

test("complete history exports retain 1000 rows and 132 completed page windows, yield, and stay immutable while recording continues", { timeout: 60_000 }, async () => {
  // Host-only isolation; no browser worker, injected script or global test ports.
  const worker = new Worker(String.raw`
    const assert = require("node:assert/strict")
    const { parentPort, workerData } = require("node:worker_threads")
    let now = 10, observer, cloneCalls = 0, yieldCalls = 0, blobBatches = 0
    const frames = [], clone = structuredClone, NativeBlob = Blob
    globalThis.window = new EventTarget()
    Object.defineProperty(globalThis, "performance", { value: { now: () => now, timeOrigin: 123456 }, configurable: true })
    globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
    globalThis.setInterval = () => { throw new Error("Evidence capture must not poll") }
    class Observer {
      static supportedEntryTypes = ["longtask"]
      constructor(callback) { this.callback = callback; this.pending = []; observer = this }
      observe(options) { assert.deepEqual(options, { type: "longtask", buffered: true }) }
      takeRecords() { const entries = this.pending; this.pending = []; return entries }
      deliver(entries) { this.callback({ getEntries: () => entries }, this) }
    }
    globalThis.PerformanceObserver = Observer
    void (async () => {
      const metrics = await import(workerData.metricsUrl), serializer = await import(workerData.serializerUrl)
      const { evidencePreviewPage, createEvidencePreview } = await import(workerData.previewUrl)
      globalThis.structuredClone = (...args) => { cloneCalls++; return clone(...args) }
      globalThis.Blob = class extends NativeBlob {
        constructor(parts, options) {
          if (parts.every((part) => typeof part === "string")) {
            blobBatches++; assert.ok(parts.reduce((size, part) => size + part.length, 0) <= 32 * 8192)
          } else assert.ok(parts.every((part) => part instanceof NativeBlob))
          super(parts, options)
        }
      }
      const original = { rowCount: 1000, closed: false, destinations: ["a", "b"], actionId: "persistent-action",
        snapshot: { phase: "idle", inFlight: 0, deadlines: [], counts: { accepted: 0, rejected: 0, unknown: 0, pending: 1000 }, haltedDestinations: [] },
        rows: Array.from({ length: 1000 }, (_, id) => ({ id: "fixture-row-" + id, destination: id < 500 ? "a" : "b", state: "ready", rev: 3, fields: { price: "999.00", title: "商品 😀" } })),
        parents: [{ id: "block-a", destination: "a", state: "pending", budget: { submits: 0, schema: 0, media: 0 }, remaining: 500 }] }
      const baselineState = clone(original), expectedActions = []
      metrics.recordState(original)
      original.rows[0].fields.price = "tampered"
      const queue = { at: now, value: { phase: "idle", pending: 1000 } }
      metrics.recordQueue(queue.value)
      const native = { at: now, kind: "validation", value: { rows: baselineState.rows, payload: { fields: [{ id: 1, values: ["中文 😀"] }] }, fact: "Passed" } }
      metrics.recordNative(native.kind, native.value)
      const business = { request: 1, event: "response", method: "POST", path: "/api/listing/submit", category: "E", operation: "submit",
        destination: "a", rowIds: baselineState.rows.slice(0, 100).map((row) => row.id), draftHashes: ["sha256"], schemaRevisions: ["schema-1"],
        acceptedIds: ["accepted"], events: [{ id: "event", kind: "diagnostic", schemaVersion: 4, summary: [{ fieldId: "id", valueType: "string", length: 2 }] }],
        sequence: 1, at: now, status: 200 }
      metrics.recordBusiness(business)
      business.rowIds[0] = "tampered"
      const expectedBusiness = clone(business); expectedBusiness.rowIds[0] = "fixture-row-0"
      const output = { textContent: null }, detach = metrics.bindTerminalEvidence(output)
      const longtasks = [{ start: 2, duration: 70 }, { start: 19.7, duration: 54 }, { start: 1400, duration: 537 }]
      observer.deliver([{ startTime: 2, duration: 70 }])
      now = 15; metrics.markReady()
      const commits = []
      const initialClones = cloneCalls
      async function finish(name, state, ok = true) {
        const start = now, action = metrics.beginAction(name)
        metrics.recordCommit("fixture", "update", 1); commits.push({ at: now, phase: "update", duration: 1 })
        const ending = metrics.endAction(action, ok)
        frames.shift()(now); frames.shift()(now); now += 2; await ending
        expectedActions.push({ id: action.id, name, start, status: ok ? "passed" : "failed", before: state, after: state, end: now })
      }
      for (let page = 0; page < 132; page++) { now = 20 + page * 10; await finish("evidence-expand", baselineState) }
      assert.equal(cloneCalls, initialClones) // no historical clone at page start/end
      now = 2000
      observer.deliver(longtasks.slice(1).map(({ start, duration }) => ({ startTime: start, duration })))
      const exporting = metrics.beginAction("evidence-export")
      const captured = metrics.evidenceSnapshot()
      const expected = { version: 1, capturedAt: now, timeOrigin: 123456, readyAt: 15, observerSupported: true, state: baselineState, failedActions: 0,
        actions: [...expectedActions, { id: 133, name: "evidence-export", start: now, status: "running", before: baselineState }],
        business: [expectedBusiness], longtasks, commits, queues: [queue], native: [native] }
      assert.deepEqual(captured, expected)
      assert.equal(cloneCalls, initialClones)
      assert.equal(Reflect.set(captured.actions[0], "end", 99999), false)
      assert.equal(Reflect.set(captured.state.rows[0].fields, "price", "corrupted"), false)
      assert.equal(Reflect.set(captured.business[0].rowIds, 0, "corrupted"), false)
      assert.equal(Reflect.set(captured.actions, 0, null), false)
      const baselineJson = JSON.stringify(expected)
      let heartbeat = false
      setTimeout(() => { heartbeat = true }, 0)
      const result = await serializer.serializeEvidence(captured, async () => {
        yieldCalls++
        if (yieldCalls === 1) {
          assert.equal(captured.capturedAt, 2000); assert.equal(captured.actions[132].end, undefined)
          now = 2001; metrics.recordState({ ...baselineState, rows: baselineState.rows.map((row) => ({ ...row, state: "accepted", rev: 4 })) })
          await finish("normal-send", metrics.evidenceSnapshot().state)
          now = 2070; observer.deliver([{ startTime: 2000.7, duration: 66 }]); metrics.recordCommit("fixture", "update", 2)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      assert.ok(heartbeat); assert.ok(yieldCalls > 2); assert.ok(blobBatches > 1)
      assert.equal(cloneCalls, initialClones + 1)
      assert.equal(result.json, baselineJson); assert.equal(result.pages.join(""), baselineJson)
      assert.equal(await result.blob.text(), baselineJson); assert.deepEqual(JSON.parse(result.json), JSON.parse(baselineJson))
      const pages = result.pages.map((_, page) => evidencePreviewPage(result, page))
      assert.equal(pages.join(""), baselineJson)
      const samePages = createEvidencePreview(baselineJson)
      assert.deepEqual(result.offsets, samePages.offsets)
      assert.deepEqual(pages, samePages.offsets.slice(0, -1).map((_, page) => evidencePreviewPage(samePages, page)))
      // Navigation of a prepared preview must not read/flatten the full string.
      const pageOnly = { ...result, get json() { throw new Error("Full JSON read during page navigation") } }
      for (let page = 0; page < pages.length; page++) assert.equal(evidencePreviewPage(pageOnly, page), pages[page])
      const ending = metrics.endAction(exporting); frames.shift()(now); frames.shift()(now); now++; await ending
      const live = metrics.evidenceSnapshot(), terminal = JSON.parse(output.textContent)
      assert.equal(live.actions[132].status, "passed"); assert.equal(live.actions[132].after.rows.length, 1000)
      assert.equal(live.actions[132].after.rows[0].state, "accepted")
      assert.equal(terminal.actions[132].status, "passed"); assert.equal(terminal.totals.unfinished, 0)
      assert.deepEqual(terminal.allLongtasks, live.longtasks)
      assert.ok(terminal.afterReadyLongtasks.some((task) => task.start === 19.7)) // before a named window remains failing evidence
      assert.ok(terminal.afterReadyLongtasks.some((task) => task.start === 1400)) // outside every window remains retained
      const secondAction = metrics.beginAction("evidence-export"), secondCapture = metrics.evidenceSnapshot()
      const secondBaseline = JSON.stringify(secondCapture)
      const second = await serializer.serializeEvidence(secondCapture, async () => { now++; await new Promise((resolve) => setTimeout(resolve, 0)) })
      const secondEnding = metrics.endAction(secondAction); frames.shift()(now); frames.shift()(now); now++; await secondEnding
      assert.equal(second.json, secondBaseline); assert.equal(await second.blob.text(), secondBaseline)
      assert.deepEqual(JSON.parse(second.pages.join("")), JSON.parse(secondBaseline))
      assert.equal(result.json, baselineJson); assert.equal(await result.blob.text(), baselineJson)
      assert.equal(secondCapture.actions.at(-1).end, undefined)
      const final = metrics.evidenceSnapshot()
      for (const action of final.actions.slice(0, 132)) {
        assert.equal(action.status, "passed"); assert.equal(action.before.rows.length, 1000); assert.equal(action.after.rows.length, 1000)
      }
      assert.deepEqual(final.native[0].value, native.value); assert.deepEqual(final.business, [expectedBusiness])
      detach(); assert.equal(frames.length, 0)
      parentPort.postMessage("passed")
    })().catch((error) => { throw error })
  `, { eval: true, workerData: { metricsUrl: new URL("./publish-pipeline-metrics.ts", import.meta.url).href,
    serializerUrl: new URL("./publish-pipeline-evidence-serialize.ts", import.meta.url).href,
    previewUrl: new URL("./publish-pipeline-evidence.tsx", import.meta.url).href } })
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject)
      worker.once("exit", (code) => reject(new Error(`History probe exited before reporting: ${code}`)))
    })
    assert.equal(result, "passed")
  } finally { await worker.terminate() }
})
