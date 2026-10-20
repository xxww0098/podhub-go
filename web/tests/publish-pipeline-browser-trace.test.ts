import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import type { Protocol } from "playwright-core/types/protocol"
import type { PageFunction } from "playwright-core/types/structs"
import { createPipelineBrowserTrace, PIPELINE_TRACE_CATEGORIES, unobservedOperation } from "./publish-pipeline-browser-trace"

// Timeline tasks on both sides of the operation and a CPU stack survive unchanged.
const raw = Buffer.from(JSON.stringify({ traceEvents: [
  { name: "RunTask", ts: 1, dur: 9713000 },
  { name: "ProfileChunk", ts: 2, args: { data: { cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: "选择" } }], samples: [1] } } } },
  { name: "RunTask", ts: 99999999, dur: 11539000 },
] }))
class FakeCdp extends EventEmitter {
  failure?: string
  discoveredCategories = [...PIPELINE_TRACE_CATEGORIES]
  startParameters?: Protocol.Tracing.startParameters
  detached = false
  streamClosed = false
  event: Protocol.Tracing.tracingCompletePayload = { stream: "fixture-stream", dataLossOccurred: false, traceFormat: "json", streamCompression: "none" }
  chunks: Protocol.IO.readReturnValue[] = [
    { data: raw.subarray(0, 41).toString("base64"), base64Encoded: true, eof: false },
    { data: raw.subarray(41).toString("utf8"), eof: true },
  ]
  async send<T extends keyof Protocol.CommandParameters>(method: T, _params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T]> {
    if (method === "Tracing.start") this.startParameters = structuredClone(_params as Protocol.Tracing.startParameters)
    if (method === this.failure) throw new Error(`fixture ${method} failure`)
    if (method === "Tracing.recordClockSyncMarker" && !this.startParameters) throw new Error("clock sync sent without trace startup")
    let value: unknown = {}
    if (method === "Tracing.getCategories") value = { categories: this.discoveredCategories }
    if (method === "Tracing.end") this.emit("Tracing.tracingComplete", this.event)
    if (method === "IO.read") {
      value = this.chunks.shift()
      if (!value) throw new Error("fixture stream read failed before EOF")
    }
    if (method === "IO.close") this.streamClosed = true
    return value as Protocol.CommandReturnValues[T]
  }
  async detach(): Promise<void> { this.detached = true }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipeline-trace-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cdp = new FakeCdp()
  let failRead = false
  const page = {
    async evaluate<R, Arg>(predicate: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
      assert.equal(typeof predicate, "function", "clock observation uses a readonly function")
      if (failRead) throw new Error("fixture clock failure")
      // No window/app fixture exists: these reads can only use the platform clock.
      return Reflect.apply(predicate as (...args: unknown[]) => R, undefined, [arg])
    },
  }
  const output = { directory, name: "local", artifacts: [] as string[], problems: [] as string[] }
  const trace = createPipelineBrowserTrace(page, async () => cdp, output)
  const sidecar = async () => JSON.parse(await readFile(path.join(directory, "local-operations.json"), "utf8")) as typeof trace.report
  return { trace, cdp, output, sidecar, failClock: () => { failRead = true } }
}

test("disabled observation returns the original work promise and failure", async () => {
  const promise = Promise.resolve("unchanged")
  assert.equal(unobservedOperation("scenario-selection", () => promise), promise)
  const failure = new Error("original pointer failure")
  await assert.rejects(unobservedOperation("scenario-selection", async () => { throw failure }), (error) => error === failure)
})

test("trace saves the complete streamed bytes including outside tasks and CPU stacks before detaching", async (t) => {
  const f = await fixture(t)
  f.cdp.detach = async () => {
    assert.deepEqual(await readFile(path.join(f.output.directory, "local-chrome-trace.json")), raw, "stream artifact is already complete when CDP detaches")
    f.cdp.detached = true
  }
  await f.trace.start()
  assert.equal(await f.trace.operation("scenario-selection", async () => "clicked"), "clicked")
  await f.trace.finish()
  const saved = await readFile(path.join(f.output.directory, "local-chrome-trace.json"))
  assert.deepEqual(saved, raw)
  const report = await f.sidecar()
  assert.equal(report.status, "complete")
  assert.equal(report.stream.eof, true)
  assert.equal(report.stream.truncated, false)
  assert.equal(report.stream.bytes, raw.length)
  assert.equal(report.stream.sha256, createHash("sha256").update(raw).digest("hex"))
  assert.deepEqual(report.errors, [])
  assert.deepEqual(f.output.artifacts, ["local-chrome-trace.json", "local-operations.json"])
  assert.deepEqual(f.output.problems, [])
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
  const entry = report.operations[0]!
  assert.equal(entry.name, "scenario-selection"); assert.equal(entry.outcome, "passed")
  assert.ok(BigInt(entry.start.monotonicNs) <= BigInt(entry.workStart!.monotonicNs))
  assert.ok(BigInt(entry.workEnd!.monotonicNs) <= BigInt(entry.end!.monotonicNs))
  for (const clock of report.clocks) {
    assert.ok(Number.isFinite(clock.page!.timeOrigin) && Number.isFinite(clock.page!.now))
    assert.ok(Number.isFinite(Date.parse(clock.readStart.utc)))
    assert.ok(BigInt(clock.readStart.monotonicNs) <= BigInt(clock.readEnd!.monotonicNs))
    assert.ok(clock.sync!.id && clock.sync!.end)
  }
  assert.equal(report.overhead.samplingRuntimeOverhead, "unmeasured")
  await f.trace.finish("second finish must not overwrite immutable artifacts")
  assert.deepEqual(await f.sidecar(), report)
})

test("failed operation records its finally boundary and preserves its error despite failed clock reads", async (t) => {
  const f = await fixture(t), failure = new Error("original scenario-selection failure")
  await f.trace.start()
  await assert.rejects(f.trace.operation("scenario-selection", async () => { f.failClock(); throw failure }), (error) => error === failure)
  await f.trace.finish()
  const report = await f.sidecar(), entry = report.operations[0]!
  assert.equal(entry.outcome, "failed"); assert.equal(entry.error, failure.message)
  assert.ok(entry.workEnd && entry.after && entry.after.readEnd && entry.end)
  assert.equal(report.status, "failed")
  assert.ok(report.errors.some((error) => error.phase === "page clock"))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("trace start rejection is explicit and still drains and cleans its session", async (t) => {
  const f = await fixture(t)
  f.cdp.failure = "Tracing.start"
  await assert.rejects(f.trace.start(), /fixture Tracing.start failure/)
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.status, "failed")
  assert.ok(report.errors.some((error) => error.phase === "start"))
  assert.ok(f.output.problems.some((problem) => problem.includes("Tracing.start")))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("trace stop failure never becomes success and detaches without a fabricated stream", async (t) => {
  const f = await fixture(t)
  await f.trace.start()
  f.cdp.failure = "Tracing.end"
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.status, "failed"); assert.equal(report.stream.eof, false); assert.equal(report.stream.truncated, true)
  assert.deepEqual(f.output.artifacts, ["local-operations.json"])
  assert.ok(report.errors.some((error) => error.message.includes("Tracing.end")))
  assert.equal(f.cdp.detached, true)
})

test("trace read failure retains an explicitly truncated artifact and closes stream and session", async (t) => {
  const f = await fixture(t)
  await f.trace.start()
  f.cdp.chunks.length = 1 // the next read fails after a real saved prefix
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.status, "failed"); assert.equal(report.stream.eof, false); assert.equal(report.stream.truncated, true)
  assert.deepEqual(await readFile(path.join(f.output.directory, "local-chrome-trace.json")), raw.subarray(0, 41))
  assert.equal(report.stream.bytes, 41); assert.equal(report.stream.sha256, null)
  assert.ok(f.output.artifacts.includes("local-chrome-trace.json"))
  assert.ok(f.output.problems.some((problem) => problem.includes("before EOF")))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("stream cleanup rejection fails the diagnostic despite complete trace bytes and still detaches", async (t) => {
  const f = await fixture(t)
  await f.trace.start()
  f.cdp.failure = "IO.close"
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.stream.eof, true); assert.equal(report.status, "failed")
  assert.ok(report.errors.some((error) => error.phase === "stream cleanup"))
  assert.equal(f.cdp.detached, true)
})

test("a stalled CDP stream read expires with explicit truncation and cleanup", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t)
  await f.trace.start()
  const send = f.cdp.send.bind(f.cdp)
  f.cdp.send = <T extends keyof Protocol.CommandParameters>(method: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T]> =>
    method === "IO.read" ? new Promise(() => {}) : send(method, params)
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.status, "failed"); assert.equal(report.stream.truncated, true); assert.equal(report.stream.eof, false)
  assert.ok(report.errors.some((error) => error.message.includes("trace stream read exceeded 5000ms")))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("Chrome data loss preserves all returned bytes and fails completeness", async (t) => {
  const f = await fixture(t)
  f.cdp.event.dataLossOccurred = true
  await f.trace.start(); await f.trace.finish()
  assert.deepEqual(await readFile(path.join(f.output.directory, "local-chrome-trace.json")), raw)
  const report = await f.sidecar()
  assert.equal(report.status, "failed"); assert.equal(report.stream.eof, true); assert.equal(report.stream.truncated, true)
  assert.equal(report.stream.dataLossOccurred, true)
  assert.ok(report.errors.some((error) => error.phase === "data loss"))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("trace artifact collision preserves the existing bytes and reports failure with cleanup", async (t) => {
  const f = await fixture(t), file = path.join(f.output.directory, "local-chrome-trace.json")
  await writeFile(file, "immutable prior artifact", { flag: "wx" })
  await f.trace.start(); await f.trace.finish()
  assert.equal(await readFile(file, "utf8"), "immutable prior artifact")
  assert.equal((await f.sidecar()).status, "failed")
  assert.ok(f.output.problems.some((problem) => problem.includes("EEXIST")))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("interrupted cleanup records an unfinished operation and saves before resource detachment", async (t) => {
  const f = await fixture(t)
  await f.trace.start()
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const work = f.trace.operation("complete-scenario", async () => { entered(); await held })
  await ready
  await f.trace.finish("runner interrupted")
  const report = await f.sidecar()
  assert.equal(report.status, "failed")
  assert.equal(report.operations[0]!.outcome, "incomplete")
  assert.ok(report.operations[0]!.end)
  assert.ok(report.errors.some((error) => error.phase === "interrupted"))
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
  release(); await work
  assert.deepEqual(await f.sidecar(), report, "late completion cannot rewrite the operation sidecar")
})

test("empty category discovery attempts the unchanged start and keeps event capability unverified after full stream delivery", async (t) => {
  const f = await fixture(t)
  f.cdp.discoveredCategories = []
  await f.trace.start()
  assert.deepEqual(f.cdp.startParameters, {
    transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
    traceConfig: { recordMode: "recordAsMuchAsPossible", traceBufferSizeInKb: 262144, enableSampling: true, enableSystrace: false,
      includedCategories: ["toplevel", "devtools.timeline", "v8", "v8.execute", "blink", "cc", "renderer.scheduler",
        "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-devtools.timeline.stack", "disabled-by-default-v8.cpu_profiler"] },
  })
  await f.trace.operation("scenario-selection", async () => "original interaction")
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.categoryDiscovery.status, "unknown")
  assert.match(report.categoryDiscovery.reason!, /empty list.*unknown.*cannot be determined/)
  assert.deepEqual(report.supportedCategories, [])
  assert.deepEqual(report.missingCategories, [], "empty discovery does not establish any missing category")
  assert.equal(report.startupEstablished, true)
  assert.equal(report.eventCoverage, "unverified", "delivery cannot establish timeline or CPU sample coverage")
  assert.equal(report.status, "complete"); assert.equal(report.stream.eof, true); assert.equal(report.stream.truncated, false)
  assert.deepEqual(report.errors, []); assert.deepEqual(f.output.problems, [])
  assert.deepEqual(await readFile(path.join(f.output.directory, "local-chrome-trace.json")), raw)
  assert.ok(f.cdp.streamClosed && f.cdp.detached)
})

test("populated discovery missing the CPU category fails before start without secondary clock-sync errors", async (t) => {
  const f = await fixture(t), missing = "disabled-by-default-v8.cpu_profiler"
  f.cdp.discoveredCategories = PIPELINE_TRACE_CATEGORIES.filter((category) => category !== missing)
  await assert.rejects(f.trace.start(), (error) => error instanceof Error && error.message === `unsupported categories: ${missing}`)
  await f.trace.operation("after-failed-start", async () => "readonly cleanup work")
  await f.trace.finish()
  const report = await f.sidecar()
  assert.equal(report.categoryDiscovery.status, "populated")
  assert.deepEqual(report.supportedCategories, f.cdp.discoveredCategories)
  assert.deepEqual(report.missingCategories, [missing])
  assert.equal(f.cdp.startParameters, undefined, "missing requested categories must not be dropped to permit start")
  assert.equal(report.startupEstablished, false); assert.equal(report.eventCoverage, "unverified")
  assert.equal(report.status, "failed"); assert.equal(report.stream.eof, false)
  assert.ok(report.clocks.every((clock) => clock.sync === undefined))
  assert.ok(report.errors.some((error) => error.phase === "start" && error.message.includes(missing)))
  assert.ok(report.errors.every((error) => error.phase !== "clock sync"))
  assert.deepEqual(f.output.artifacts, ["local-operations.json"])
  assert.equal(f.cdp.detached, true)
})

test("discovery and actual start errors retain their original failure with no clock-sync before established startup", async (t) => {
  for (const method of ["Tracing.getCategories", "Tracing.start"] as const) {
    const f = await fixture(t)
    f.cdp.failure = method
    // Any sync attempt is an observable protocol error, even after an attempted start.
    const send = f.cdp.send.bind(f.cdp)
    f.cdp.send = <T extends keyof Protocol.CommandParameters>(command: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T]> => {
      if (command === "Tracing.recordClockSyncMarker") return Promise.reject(new Error("forbidden sync after absent startup"))
      return send(command, params)
    }
    await assert.rejects(f.trace.start(), (error) => error instanceof Error && error.message === `fixture ${method} failure`)
    await f.trace.operation("after-start-error", async () => "readonly cleanup work")
    await f.trace.finish()
    const report = await f.sidecar()
    assert.equal(report.status, "failed"); assert.equal(report.startupEstablished, false)
    assert.equal(report.categoryDiscovery.status, method === "Tracing.getCategories" ? "failed" : "populated")
    if (method === "Tracing.getCategories") assert.equal(report.categoryDiscovery.reason, `fixture ${method} failure`)
    assert.ok(report.errors.some((error) => error.phase === "start" && error.message === `fixture ${method} failure`))
    assert.ok(report.errors.every((error) => error.phase !== "clock sync"))
    assert.ok(report.clocks.length > 0 && report.clocks.every((clock) => clock.sync === undefined))
    assert.equal(report.overhead.clockSyncHostMs, 0)
    assert.equal(f.cdp.detached, true)
  }
})
