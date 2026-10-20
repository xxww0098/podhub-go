/** Runner-only observation. Never writes page state or changes fixture metrics. */
import { createHash } from "node:crypto"
import { open, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CDPSession, Page } from "playwright-core"
import type { Protocol } from "playwright-core/types/protocol"

export type RunnerOperation = <T>(name: string, work: () => Promise<T>) => Promise<T>
export const unobservedOperation: RunnerOperation = (_name, work) => work()
export const PIPELINE_TRACE_CATEGORIES = [
  "toplevel", "devtools.timeline", "v8", "v8.execute", "blink", "cc", "renderer.scheduler",
  "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack", "disabled-by-default-v8.cpu_profiler",
]
const COMMAND_MS = 5000, FINISH_MS = 45_000, MAX_BYTES = 512 * 1024 * 1024
export const PIPELINE_TRACE_LATE_DRAIN_MS = 100
type TraceSession = Pick<CDPSession, "send" | "on" | "off" | "detach">
type HostClock = { monotonicNs: string; utc: string }
type ClockReading = {
  label: string; readStart: HostClock; readEnd?: HostClock
  page?: { timeOrigin: number; now: number }
  sync?: { id: string; start: HostClock; end?: HostClock }
}
type OperationBoundary = {
  id: number; name: string; start: HostClock; before?: ClockReading
  workStart?: HostClock; workEnd?: HostClock; after?: ClockReading; end?: HostClock
  outcome: "pending" | "passed" | "failed" | "incomplete"; error?: string
}
const hostClock = (): HostClock => ({ monotonicNs: process.hrtime.bigint().toString(), utc: new Date().toISOString() })
const elapsedMs = (start: HostClock, end: HostClock) => Number(BigInt(end.monotonicNs) - BigInt(start.monotonicNs)) / 1e6
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) })]) }
  finally { clearTimeout(timer) }
}

export function createPipelineBrowserTrace(
  page: Pick<Page, "evaluate">,
  connect: () => Promise<TraceSession>,
  output: { directory: string; name: string; artifacts: string[]; problems: string[] },
) {
  const traceFile = `${output.name}-chrome-trace.json`, operationsFile = `${output.name}-operations.json`
  const report = {
    version: 1, scenario: output.name, mode: "PUBLISH_PIPELINE_TRACE=1", traceFile, operationsFile,
    status: "not-started" as "not-started" | "recording" | "complete" | "failed",
    started: null as HostClock | null, stopped: null as HostClock | null,
    categories: PIPELINE_TRACE_CATEGORIES, supportedCategories: [] as string[], missingCategories: [] as string[],
    categoryDiscovery: { status: "not-requested" as "not-requested" | "unknown" | "populated" | "failed", reason: null as string | null },
    startupEstablished: false, eventCoverage: "unverified" as const,
    config: { recordMode: "recordAsMuchAsPossible", traceBufferSizeInKb: 256 * 1024, enableSampling: true,
      enableSystrace: false, transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none" },
    limits: { commandMs: COMMAND_MS, finishDrainMs: FINISH_MS, finishIncludingCleanupMs: FINISH_MS + 4 * COMMAND_MS, maxStreamBytes: MAX_BYTES },
    stream: { eof: false, bytes: 0, sha256: null as string | null, dataLossOccurred: null as boolean | null,
      traceFormat: null as string | null, compression: null as string | null, truncated: false },
    operations: [] as OperationBoundary[], clocks: [] as ClockReading[], errors: [] as { phase: string; message: string }[],
    overhead: { clockReadHostMs: 0, clockSyncHostMs: 0, startHostMs: 0, finishHostMs: 0,
      lateDrainRequestedMs: PIPELINE_TRACE_LATE_DRAIN_MS, samplingRuntimeOverhead: "unmeasured" },
    limitations: [
      "Optional tracing, CPU sampling, clock reads and the 100ms late drain perturb timing; raw tasks are never subtracted or filtered.",
      "CPU sampling interval is Chrome's default, not verified; unsampled/native stacks and unavailable symbols may remain unresolved.",
      "Empty category discovery is unknown support. Complete stream delivery does not verify category/event coverage; inspect the actual trace for timeline tasks and CPU samples.",
      "Host work intervals include Playwright/protocol latency. Page clock reads and CDP clock_sync markers have recorded host uncertainty brackets.",
      "Clocks are per document (navigation changes timeOrigin). UTC can drift; host monotonic nanoseconds order runner observations.",
      "Stream bytes count acknowledged writes; sha256 is available only after confirmed EOF and file close, never after an uncertain write.",
      "This run cannot retroactively attribute report78/report81; a clean rerun is not a causal explanation of historical tasks.",
    ],
  }
  let session: TraceSession | undefined, startAttempted = false, finishing = false, sealed = false
  let finishPromise: Promise<void> | undefined
  let resolveComplete!: (event: Protocol.Tracing.tracingCompletePayload) => void
  const completion = new Promise<Protocol.Tracing.tracingCompletePayload>((resolve) => { resolveComplete = resolve })
  const onComplete = (event: Protocol.Tracing.tracingCompletePayload) => resolveComplete(event)
  function fail(phase: string, error: unknown) {
    if (sealed) return
    report.status = "failed"
    report.errors.push({ phase, message: message(error) })
    output.problems.push(`Chrome trace ${phase}: ${message(error)}`)
  }
  async function clock(label: string): Promise<ClockReading> {
    const reading: ClockReading = { label, readStart: hostClock() }
    report.clocks.push(reading)
    try {
      reading.page = await bounded(page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() })), COMMAND_MS, "readonly page clock")
    } catch (error) { fail("page clock", error) }
    finally {
      reading.readEnd = hostClock()
      report.overhead.clockReadHostMs += elapsedMs(reading.readStart, reading.readEnd)
    }
    if (session && report.startupEstablished && !finishing) {
      reading.sync = { id: `publish-pipeline:${output.name}:${report.clocks.length}`, start: hostClock() }
      try { await bounded(session.send("Tracing.recordClockSyncMarker", { syncId: reading.sync.id }), COMMAND_MS, "trace clock sync") }
      catch (error) { fail("clock sync", error) }
      finally {
        reading.sync.end = hostClock()
        report.overhead.clockSyncHostMs += elapsedMs(reading.sync.start, reading.sync.end)
      }
    }
    return reading
  }
  const operation: RunnerOperation = async (name, work) => {
    if (finishing) return work()
    const entry: OperationBoundary = { id: report.operations.length + 1, name, start: hostClock(), outcome: "pending" }
    report.operations.push(entry)
    entry.before = await clock(`${entry.id}:${name}:before`)
    entry.workStart = hostClock()
    try {
      const value = await work()
      if (!finishing && !sealed) entry.outcome = "passed"
      return value
    } catch (error) {
      if (!finishing && !sealed) { entry.outcome = "failed"; entry.error = message(error) }
      throw error // preserve the original action failure, even if the final clock read fails
    } finally {
      if (!finishing) {
        entry.workEnd = hostClock()
        entry.after = await clock(`${entry.id}:${name}:after`)
        entry.end = hostClock()
      }
    }
  }
  async function start(): Promise<void> {
    report.started = hostClock()
    try {
      const connecting = connect().then(async (connected) => {
        if (finishing || sealed) {
          // A timed-out connection can still resolve. It must not retain a live session.
          await bounded(connected.detach(), COMMAND_MS, "late CDP detach")
          throw new Error("CDP connection arrived after trace finalization")
        }
        return connected
      })
      session = await bounded(connecting, COMMAND_MS, "CDP connection")
      if (finishing) throw new Error("trace startup interrupted")
      session.on("Tracing.tracingComplete", onComplete)
      try { report.supportedCategories = (await bounded(session.send("Tracing.getCategories"), COMMAND_MS, "trace categories")).categories }
      catch (error) { report.categoryDiscovery.status = "failed"; report.categoryDiscovery.reason = message(error); throw error }
      if (finishing) throw new Error("trace startup interrupted")
      const populated = report.supportedCategories.length > 0
      report.categoryDiscovery.status = populated ? "populated" : "unknown"
      if (populated) report.missingCategories = PIPELINE_TRACE_CATEGORIES.filter((category) => !report.supportedCategories.includes(category))
      else report.categoryDiscovery.reason = "Tracing.getCategories returned an empty list; category support is unknown and missing categories cannot be determined."
      if (report.missingCategories.length) throw new Error(`unsupported categories: ${report.missingCategories.join(", ")}`)
      startAttempted = true
      await bounded(session.send("Tracing.start", { transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
        traceConfig: { recordMode: "recordAsMuchAsPossible", traceBufferSizeInKb: 256 * 1024,
          enableSampling: true, enableSystrace: false, includedCategories: PIPELINE_TRACE_CATEGORIES } }), COMMAND_MS, "trace start")
      if (finishing) throw new Error("trace startup interrupted")
      report.startupEstablished = true
      report.status = "recording"
      await clock("trace-start-before-navigation")
    } catch (error) { fail("start", error); throw error }
    finally { report.overhead.startHostMs = elapsedMs(report.started, hostClock()) }
  }
  async function finish(reason?: string): Promise<void> {
    return finishPromise ??= (async () => {
      const finishStart = hostClock(), deadline = performance.now() + FINISH_MS
      if (reason) fail("interrupted", reason)
      // The final page clock is still inside the recording, before Tracing.end.
      if (session && report.startupEstablished) await clock("trace-final-read")
      finishing = true
      for (const entry of report.operations.filter((entry) => entry.outcome === "pending")) {
        entry.outcome = "incomplete"; entry.end = hostClock(); fail("operation incomplete", entry.name)
      }
      let stream: string | undefined, file: Awaited<ReturnType<typeof open>> | undefined
      const hash = createHash("sha256")
      const within = <T>(work: Promise<T>, label: string, cap = COMMAND_MS) => bounded(work, Math.max(1, Math.min(cap, deadline - performance.now())), label)
      try {
        if (!session || !startAttempted) throw new Error("no started trace; completeness unavailable")
        await within(session.send("Tracing.end"), "trace stop")
        const event = await within(completion, "trace completion", 15_000)
        stream = event.stream
        report.stream.dataLossOccurred = event.dataLossOccurred
        report.stream.traceFormat = event.traceFormat ?? null
        report.stream.compression = event.streamCompression ?? null
        if (event.dataLossOccurred !== false) {
          report.stream.truncated = true
          fail("data loss", "Chrome reported lost trace events or omitted the loss flag")
        }
        if (!stream) throw new Error("Tracing.tracingComplete supplied no stream")
        if (event.traceFormat !== "json" || event.streamCompression !== "none") throw new Error("unexpected trace stream format/compression")
        file = await within(open(path.join(output.directory, traceFile), "wx"), "trace artifact open")
        output.artifacts.push(traceFile)
        while (!report.stream.eof) {
          if (performance.now() >= deadline) throw new Error(`trace stream drain exceeded ${FINISH_MS}ms`)
          const chunk = await within(session.send("IO.read", { handle: stream, size: 1024 * 1024 }), "trace stream read")
          const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")
          if (report.stream.bytes + bytes.length > MAX_BYTES) throw new Error(`trace stream exceeds ${MAX_BYTES} bytes`)
          await within(file.writeFile(bytes), "trace artifact write")
          hash.update(bytes); report.stream.bytes += bytes.length; report.stream.eof = chunk.eof
        }
        if (!report.stream.bytes) throw new Error("Chrome returned an empty trace stream")
      } catch (error) { report.stream.truncated = true; fail("finish", error) }
      finally {
        if (file) {
          try {
            await bounded(file.close(), COMMAND_MS, "trace artifact close")
            if (report.stream.eof) report.stream.sha256 = hash.digest("hex")
          } catch (error) { fail("file cleanup", error) }
        }
        if (session) {
          if (stream) { try { await bounded(session.send("IO.close", { handle: stream }), COMMAND_MS, "trace stream close") } catch (error) { fail("stream cleanup", error) } }
          try { session.off("Tracing.tracingComplete", onComplete) } catch (error) { fail("listener cleanup", error) }
          try { await bounded(session.detach(), COMMAND_MS, "CDP detach") } catch (error) { fail("session cleanup", error) }
        }
        report.stopped = hostClock()
        report.overhead.finishHostMs = elapsedMs(finishStart, report.stopped)
        report.status = report.errors.length || !report.stream.eof ? "failed" : "complete"
        try {
          await bounded(writeFile(path.join(output.directory, operationsFile), JSON.stringify(report, null, 2), { flag: "wx" }), COMMAND_MS, "operation sidecar write")
          output.artifacts.push(operationsFile)
        } catch (error) { fail("sidecar write", error) }
        sealed = true
      }
    })()
  }
  return { start, operation, finish, report }
}
