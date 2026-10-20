/** Append-only evidence. The driver can read snapshots, never invoke actions. */
export type ActionName = "import" | "single-edit" | "validate-compose" | "normal-send" | "stop" | "continue" | "query" | "reload" | "scope-switch" | "wb-import" | "wb-open" | "wb-refresh" | "wb-edit-validate" | "idle" | "evidence-export" | "screenshot" | "mock-release" | "evidence-expand"
  | "diagnostic-select" | "diagnostic-details" | "diagnostic-copy" | "diagnostic-report" | "diagnostic-route" | "diagnostic-offline"
  | "workbench-load" | "workbench-configure" | "brand-repair" | "unknown-inspect" | "unknown-confirm" | "unknown-release" | "workbench-stop" | "workbench-scope"
export type ActionWindow = { id: number; name: ActionName; start: number; end?: number; status: "running" | "passed" | "failed"; before: unknown; after?: unknown }
export type InboxEvidence = { id: string; kind: string; schemaVersion: number; diagnosticId?: string; traceId?: string; payloadSha256?: string | null; platform?: string | null; stage?: string | null; code?: string | null; summary?: import("@/lib/diagnostic-summary").DiagnosticFieldSummary[] }
export type BusinessEvent = { sequence: number; request: number; at: number; event: "dispatch" | "response" | "rejection" | "abort" | "held"; method: string; path: string; category: "C" | "E" | "legacy-row" | "fixture-media" | "unexpected"; operation: "submit" | "intents" | "wb-catalog" | "schema" | "media" | "inbox" | "row-read" | "row-patch" | "release" | "unexpected"; destination?: string; rowIds?: string[]; attempt?: number; requestBytes?: number; status?: number; signalAborted?: boolean; draftHashes?: string[]; schemaRevisions?: string[]; renewedMedia?: boolean; events?: InboxEvidence[]; acceptedIds?: string[]; releasedIntentIds?: string[]; baseRevision?: number; revision?: number; viewRevision?: number; contentUnchanged?: boolean; latestPerRow?: boolean; limit?: number }
const actions: ActionWindow[] = [], business: BusinessEvent[] = []
const longtasks: { start: number; duration: number }[] = []
const commits: { at: number; phase: string; duration: number }[] = []
const queues: { at: number; value: unknown }[] = []
const native: { at: number; kind: string; value: unknown }[] = []
let readyAt: number | undefined
let state: unknown = null
let failedActions = 0
let terminalOutput: { output: Pick<HTMLElement, "textContent"> } | undefined
const observerSupported = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")
const observer = observerSupported ? new PerformanceObserver((list) => recordLongtasks(list.getEntries())) : undefined
function appendLongtasks(entries: PerformanceEntry[]) { for (const entry of entries) longtasks.push({ start: entry.startTime, duration: entry.duration }) }
function recordLongtasks(entries: PerformanceEntry[]) {
  if (!entries.length) return
  appendLongtasks(entries); publishTerminalEvidence()
}
observer?.observe({ type: "longtask", buffered: true })

/** Small measurement projection only: never inspect row state or recorded payloads. */
export function terminalEvidenceSnapshot() {
  const capturedAt = performance.now(), ready = readyAt ?? Infinity
  const allLongtasks = longtasks.map((entry) => ({ ...entry }))
  const firstPaint = allLongtasks.filter((entry) => entry.start < ready)
  const afterReadyLongtasks = allLongtasks.filter((entry) => entry.start >= ready)
  const completed = actions.filter((action) => action.end !== undefined).length
  return {
    version: 1, timeOrigin: performance.timeOrigin, capturedAt, readyAt: readyAt ?? null, observerSupported,
    actions: actions.map(({ id, name, start, end, status }) => ({
      id, name, start, end: end ?? null, status,
      // Same inclusive commit/dispatch boundaries as performanceProblems; no copied budgets.
      commits: commits.filter((entry) => entry.at >= start && entry.at <= (end ?? capturedAt)).length,
      dispatches: business.filter((entry) => entry.event === "dispatch" && entry.at >= start && entry.at <= (end ?? capturedAt)).length,
    })),
    commits: commits.map((entry) => ({ ...entry })), allLongtasks, firstPaint, afterReadyLongtasks,
    totals: { actions: actions.length, completed, unfinished: actions.length - completed, failed: failedActions,
      commits: commits.length, afterReadyCommits: commits.filter((entry) => entry.at >= ready).length,
      longtasks: allLongtasks.length, firstPaintLongtasks: firstPaint.length, afterReadyLongtasks: afterReadyLongtasks.length,
      businessEvents: business.length, queueRecords: queues.length, nativeRecords: native.length },
  }
}
export type TerminalEvidence = ReturnType<typeof terminalEvidenceSnapshot>

function publishTerminalEvidence() {
  if (!terminalOutput) return
  if (observer) appendLongtasks(observer.takeRecords())
  // Imperative text publication creates no React render or recurring scheduler.
  // Its own cost remains visible to the same unfiltered longtask observer.
  terminalOutput.output.textContent = JSON.stringify(terminalEvidenceSnapshot())
}
export function bindTerminalEvidence(output: Pick<HTMLElement, "textContent">): () => void {
  const binding = { output }
  terminalOutput = binding; publishTerminalEvidence()
  return () => { if (terminalOutput === binding) terminalOutput = undefined }
}
export const settlePaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))
/** Fixture payloads are plain JSON data. Detach once, then share immutable captures. */
function captureValue<T>(value: T): T {
  const captured = structuredClone(value)
  function freeze(item: unknown) {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("Evidence payload must contain plain JSON objects and arrays")
    }
    Object.freeze(item)
    for (const child of Object.values(item)) freeze(child)
  }
  freeze(captured)
  return captured
}
export function recordState(value: unknown) { state = captureValue(value) }
export function recordQueue(value: unknown) { queues.push(Object.freeze({ at: performance.now(), value: captureValue(value) })); publishTerminalEvidence() }
export function recordNative(kind: string, value: unknown) { native.push(Object.freeze({ at: performance.now(), kind, value: captureValue(value) })); publishTerminalEvidence() }
export function recordBusiness(event: Omit<BusinessEvent, "sequence" | "at">) { business.push(captureValue({ ...event, sequence: business.length + 1, at: performance.now() })); publishTerminalEvidence() }
export function markReady() { readyAt ??= performance.now(); publishTerminalEvidence() }
export function recordCommit(_id: string, phase: string, duration: number) { commits.push({ at: performance.now(), phase, duration }); publishTerminalEvidence() }
export function beginAction(name: ActionName): ActionWindow {
  const action: ActionWindow = { id: actions.length + 1, name, start: performance.now(), status: "running", before: state }
  actions.push(action); publishTerminalEvidence()
  return action
}
export async function endAction(action: ActionWindow, ok = true) {
  await settlePaint()
  action.after = state; action.end = performance.now(); action.status = ok ? "passed" : "failed"
  if (!ok) failedActions++
  publishTerminalEvidence()
}
export function evidenceSnapshot() {
  if (observer) recordLongtasks(observer.takeRecords())
  // Copy only append-only indexes and mutable window metadata, never historical
  // row graphs. A synchronous read freezes this instant, including running actions.
  return Object.freeze({ version: 1, capturedAt: performance.now(), timeOrigin: performance.timeOrigin, readyAt, observerSupported, state, failedActions,
    actions: Object.freeze(actions.map((action) => Object.freeze({ ...action }))),
    business: Object.freeze(business.slice()), longtasks: Object.freeze(longtasks.map((entry) => Object.freeze({ ...entry }))),
    commits: Object.freeze(commits.map((entry) => Object.freeze({ ...entry }))),
    queues: Object.freeze(queues.slice()), native: Object.freeze(native.slice()) })
}
export type PipelineEvidence = ReturnType<typeof evidenceSnapshot>
declare global { interface Window { readonly publishPipelineMetrics: PipelineEvidence } }
Object.defineProperty(window, "publishPipelineMetrics", { configurable: false, get: evidenceSnapshot })
