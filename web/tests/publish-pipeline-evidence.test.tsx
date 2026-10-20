import assert from "node:assert/strict"
import test from "node:test"
import { Worker } from "node:worker_threads"
import { renderToStaticMarkup } from "react-dom/server"

// The fixture metrics module installs its read-only getter at import time. Keep
// that getter and passive telemetry listeners on an isolated event target;
// these tests never run browser actions or dispatch telemetry events.
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
const evidence = await import("./publish-pipeline-evidence").finally(() => {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow)
  else Reflect.deleteProperty(globalThis, "window")
})
const { createEvidencePreview, evidencePreviewPage, EVIDENCE_PREVIEW_PAGE_SIZE, PipelineEvidencePanel } = evidence

test("evidence preview reassembles the complete snapshot and download without dropping fields or events", async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `fixture-${index}`, destination: index < 500 ? "fixture-a" : "fixture-b", state: "ready", rev: 1,
  }))
  const snapshot = {
    version: 1, capturedAt: 1234.5, timeOrigin: 100000, readyAt: 12, observerSupported: true, failedActions: 1,
    state: { rows, rowCount: 1000 },
    actions: [{ id: 1, name: "import", start: 20, end: 30, status: "passed", before: null, after: { rows } }],
    business: [{ sequence: 1, request: 1, at: 40, event: "response", method: "POST", path: "/api/listing/submit",
      category: "E", operation: "submit", destination: "fixture-a", rowIds: rows.slice(0, 100).map((row) => row.id), status: 200 }],
    longtasks: [{ start: 21, duration: 51 }], commits: [{ at: 22, phase: "update", duration: 3 }],
    queues: [{ at: 23, value: { inFlight: 1, remaining: 900 } }],
    native: [{ at: 24, kind: "validation", value: { fields: [{ id: 1, value: "中文 😀" }], fact: "Passed" } }],
  }
  const captured = structuredClone(snapshot), json = JSON.stringify(snapshot)
  const preview = createEvidencePreview(json)
  snapshot.actions[0]!.end = 999
  snapshot.state.rows[0]!.rev = 2
  assert.ok(preview.offsets.length > 2)
  assert.equal(preview.json, json)
  assert.equal(preview.offsets[0], 0)
  assert.equal(preview.offsets.at(-1), json.length)
  const pages = Array.from({ length: preview.offsets.length - 1 }, (_, page) => evidencePreviewPage(preview, page))
  assert.ok(pages.every((page) => page.length <= EVIDENCE_PREVIEW_PAGE_SIZE))
  assert.equal(pages.join(""), json)
  assert.deepEqual(JSON.parse(pages.join("")), captured)
  const download = new Blob([preview.json], { type: "application/json" })
  assert.deepEqual(JSON.parse(await download.text()), captured)
  assert.match(download.type, /^application\/json(?:;[ \t]*charset=utf-8)?$/i)
})

test("evidence preview bounds empty, exact-size and final partial pages", () => {
  for (const length of [0, 1, 8191, 8192, 8193, 16384, 16385]) {
    const json = "x".repeat(length), preview = createEvidencePreview(json)
    const pages = Math.max(1, Math.ceil(length / EVIDENCE_PREVIEW_PAGE_SIZE))
    assert.equal(preview.offsets.length - 1, pages)
    assert.equal(Array.from({ length: pages }, (_, page) => evidencePreviewPage(preview, page)).join(""), json)
    for (let page = 0; page < pages; page++) assert.ok(evidencePreviewPage(preview, page).length <= EVIDENCE_PREVIEW_PAGE_SIZE)
  }
})

test("evidence preview keeps Unicode surrogate pairs intact across page boundaries", () => {
  const json = "x".repeat(EVIDENCE_PREVIEW_PAGE_SIZE - 1) + "😀" + "y".repeat(EVIDENCE_PREVIEW_PAGE_SIZE)
  const preview = createEvidencePreview(json)
  assert.equal(preview.offsets[1], EVIDENCE_PREVIEW_PAGE_SIZE - 1)
  const pages = Array.from({ length: preview.offsets.length - 1 }, (_, page) => evidencePreviewPage(preview, page))
  assert.equal(pages.join(""), json)
  for (const page of pages) {
    assert.ok(page.length <= EVIDENCE_PREVIEW_PAGE_SIZE)
    assert.doesNotMatch(page, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  }
  assert.ok(pages[1]!.startsWith("😀"))
})

test("evidence preview rejects negative, fractional, non-finite and missing pages", () => {
  const preview = createEvidencePreview("x".repeat(EVIDENCE_PREVIEW_PAGE_SIZE + 1))
  for (const page of [-1, 0.5, NaN, Infinity, -Infinity, 2, 999]) {
    assert.throws(() => evidencePreviewPage(preview, page), RangeError)
  }
  assert.throws(() => evidencePreviewPage(createEvidencePreview(""), 1), RangeError)
})

test("evidence panel retains the read-only label and explicit pagination and complete-download controls", () => {
  const html = renderToStaticMarkup(<PipelineEvidencePanel />)
  assert.match(html, /导出测量 JSON/)
  assert.match(html, /完整快照（紧凑 JSON，保留所有字段、事件与时间戳）/)
  assert.match(html, /翻页不会重新采集快照/)
  assert.match(html, /id="evidence-preview-page"/)
  assert.match(html, /aria-describedby="evidence-preview-page"/)
  assert.match(html, /上一页/)
  assert.match(html, /下一页/)
  assert.match(html, /<textarea[^>]*aria-label="测量 JSON（只读）"[^>]*readonly[^>]*><\/textarea>/i)
  assert.match(html, /<pre[^>]*role="region"[^>]*aria-label="终态测量证据（只读）"[^>]*><\/pre>/)
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)]
  const disabled = /(?:^|\s)disabled(?=\s|=|$)/
  assert.equal(buttons.length, 3)
  assert.equal(buttons.filter((button) => disabled.test(button[1]!)).length, 2)
  for (const [label, expected] of [["导出测量 JSON", false], ["上一页", true], ["下一页", true]] as const) {
    const matches = buttons.filter((button) => button[2] === label)
    assert.equal(matches.length, 1)
    assert.equal(disabled.test(matches[0]![1]!), expected)
  }
})

test("terminal evidence publishes completed windows and late measurements without polling or full row traversal", { timeout: 10_000 }, async () => {
  // A separate host worker confines the clock, observer and frame ports to this
  // probe. It imports the actual recorder, without changing this test's globals.
  const worker = new Worker(String.raw`
    const assert = require("node:assert/strict")
    const { parentPort, workerData } = require("node:worker_threads")
    let now = 10, observer, frameCalls = 0, timerCalls = 0, clones = 0
    const frames = [], nativeTimeout = setTimeout, nativeClone = structuredClone
    globalThis.window = {}
    Object.defineProperty(globalThis, "performance", { value: { now: () => now, timeOrigin: 123456 }, configurable: true })
    globalThis.requestAnimationFrame = (callback) => { frameCalls++; frames.push(callback); return frameCalls }
    class Observer {
      static supportedEntryTypes = ["longtask"]
      constructor(callback) { this.callback = callback; this.pending = []; observer = this }
      observe(options) { assert.deepEqual(options, { type: "longtask", buffered: true }) }
      takeRecords() { const entries = this.pending; this.pending = []; return entries }
      deliver(entries) { this.callback({ getEntries: () => entries }, this) }
    }
    globalThis.PerformanceObserver = Observer
    void (async () => {
      const metrics = await import(workerData.moduleUrl)
      globalThis.setTimeout = (...args) => { timerCalls++; return nativeTimeout(...args) }
      globalThis.setInterval = () => { throw new Error("Terminal publication must not start a recurring timer") }
      globalThis.structuredClone = (...args) => { clones++; return nativeClone(...args) }
      const stringify = JSON.stringify
      JSON.stringify = (value, ...args) => {
        for (const key of ["state", "business", "queues", "native"]) assert.equal(Object.hasOwn(value, key), false)
        for (const action of value.actions) {
          assert.equal(Object.hasOwn(action, "before"), false)
          assert.equal(Object.hasOwn(action, "after"), false)
        }
        return stringify(value, ...args)
      }
      const output = { textContent: null }, detach = metrics.bindTerminalEvidence(output)
      const read = () => JSON.parse(output.textContent)
      assert.equal(read().version, 1); assert.equal(read().timeOrigin, 123456)
      assert.equal(read().readyAt, null); assert.equal(read().observerSupported, true)
      assert.equal(read().totals.unfinished, 0)
      observer.deliver([{ startTime: 2, duration: 70 }])
      metrics.recordCommit("fixture", "mount", 3)
      now = 20; metrics.markReady()
      assert.equal(read().readyAt, 20)
      assert.deepEqual(read().firstPaint, [{ start: 2, duration: 70 }])
      assert.deepEqual(read().afterReadyLongtasks, [])
      const rows = Array.from({ length: 1000 }, (_, id) => ({ id }))
      metrics.recordState({ rows }); metrics.recordQueue({ rows }); metrics.recordNative("probe", { rows })
      assert.equal(clones, 3)
      const capturedClones = clones
      const capturedRows = metrics.evidenceSnapshot().state.rows
      const rowGraphs = new Set([capturedRows, ...capturedRows])
      const values = Object.values, keys = Object.keys
      Object.values = (value) => { assert.equal(rowGraphs.has(value), false, "Terminal/read paths traversed rows"); return values(value) }
      Object.keys = (value) => { assert.equal(rowGraphs.has(value), false, "Terminal/read paths traversed rows"); return keys(value) }
      assert.equal(read().totals.queueRecords, 1); assert.equal(read().totals.nativeRecords, 1)
      now = 25; const exporting = metrics.beginAction("evidence-export")
      metrics.recordCommit("fixture", "update", 1)
      now = 26; const frozen = metrics.evidenceSnapshot()
      assert.equal(frozen.actions[0].end, undefined); assert.equal(frozen.actions[0].status, "running")
      assert.equal(frozen.state.rows.length, 1000)
      now = 27; const ending = metrics.endAction(exporting)
      assert.equal(read().actions[0].end, null); assert.equal(read().totals.unfinished, 1)
      now = 30; metrics.recordCommit("fixture", "update", 1)
      metrics.recordBusiness({ request: 1, event: "dispatch", method: "POST", path: "/mock", category: "E", operation: "submit" })
      assert.equal(read().actions[0].commits, 2); assert.equal(read().actions[0].dispatches, 1)
      frames.shift()(now); frames.shift()(now); now = 40; await ending
      assert.equal(read().actions[0].end, 40); assert.equal(read().actions[0].status, "passed")
      assert.equal(read().totals.unfinished, 0); assert.equal(read().totals.completed, 1)
      metrics.recordCommit("fixture", "update", 1) // delivered at the inclusive end boundary
      now = 41; metrics.recordCommit("fixture", "update", 1)
      assert.equal(read().actions[0].commits, 3)
      now = 100; observer.deliver([{ startTime: 28, duration: 60 }, { startTime: 42, duration: 50 }])
      assert.deepEqual(read().afterReadyLongtasks, [{ start: 28, duration: 60 }, { start: 42, duration: 50 }])
      assert.equal(read().capturedAt, 100); assert.equal(read().totals.longtasks, 3)
      async function finish(name, start, end, ok) {
        now = start; const action = metrics.beginAction(name), promise = metrics.endAction(action, ok)
        frames.shift()(now); frames.shift()(now); now = end; await promise
      }
      await finish("evidence-expand", 110, 120, true)
      await finish("screenshot", 130, 140, false)
      now = 150; metrics.beginAction("normal-send")
      assert.deepEqual(read().actions.map(({ id, name, status, end }) => ({ id, name, status, end })), [
        { id: 1, name: "evidence-export", status: "passed", end: 40 },
        { id: 2, name: "evidence-expand", status: "passed", end: 120 },
        { id: 3, name: "screenshot", status: "failed", end: 140 },
        { id: 4, name: "normal-send", status: "running", end: null },
      ])
      observer.pending.push({ startTime: 145, duration: 51 })
      now = 210; metrics.recordCommit("fixture", "update", 2)
      const terminal = read(), raw = metrics.evidenceSnapshot()
      assert.equal(terminal.version, raw.version); assert.equal(terminal.timeOrigin, raw.timeOrigin)
      assert.equal(terminal.readyAt, raw.readyAt); assert.equal(terminal.observerSupported, raw.observerSupported)
      assert.deepEqual(terminal.allLongtasks, raw.longtasks); assert.deepEqual(terminal.commits, raw.commits)
      assert.deepEqual(terminal.totals, { actions: 4, completed: 3, unfinished: 1, failed: 1,
        commits: 6, afterReadyCommits: 5, longtasks: 4, firstPaintLongtasks: 1, afterReadyLongtasks: 3,
        businessEvents: 1, queueRecords: 1, nativeRecords: 1 })
      assert.equal(raw.state.rows.length, 1000); assert.equal(raw.queues[0].value.rows.length, 1000)
      assert.equal(raw.native[0].value.rows.length, 1000)
      assert.equal(frozen.actions[0].end, undefined) // the original complete download stays frozen
      // Only the new business payload was captured; action boundaries, raw reads,
      // observer delivery and terminal publication never traverse captured rows.
      assert.equal(clones, capturedClones + 1)
      assert.equal(raw.actions[0].before, raw.state); assert.equal(raw.actions[0].after, raw.state)
      assert.equal(Reflect.set(raw.state.rows[0], "id", "tampered"), false)
      assert.equal(Reflect.set(raw.actions[0], "end", 999), false)
      assert.equal(Reflect.set(raw.queues[0].value.rows[0], "id", "tampered"), false)
      assert.equal(Reflect.set(raw.native[0].value.rows[0], "id", "tampered"), false)
      const replacement = { textContent: null }, retire = metrics.bindTerminalEvidence(replacement)
      detach(); now = 220; metrics.recordCommit("fixture", "update", 1)
      assert.equal(JSON.parse(replacement.textContent).totals.commits, 7)
      assert.equal(output.textContent, stringify(terminal))
      retire(); const last = replacement.textContent
      now = 230; metrics.recordCommit("fixture", "update", 1)
      assert.equal(replacement.textContent, last)
      assert.equal(frameCalls, 6); assert.equal(timerCalls, 3); assert.equal(frames.length, 0)
      parentPort.postMessage("passed")
    })().catch((error) => { throw error })
  `, { eval: true, workerData: { moduleUrl: new URL("./publish-pipeline-metrics.ts", import.meta.url).href } })
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve)
      worker.once("error", reject)
      worker.once("exit", (code) => reject(new Error(`Recorder probe exited before reporting: ${code}`)))
    })
    assert.equal(result, "passed")
  } finally { await worker.terminate() }
})
