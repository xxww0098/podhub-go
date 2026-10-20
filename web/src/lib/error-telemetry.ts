import { setErrorFeedbackContext } from "./error-feedback-reporting"
import { setErrorReportIdentity } from "./error-report-environment"
import { route } from "@/api/routes"
import type { DiagnosticContextInput } from "./diagnostic-context"
import { diagnosticProperty, newDiagnosticId } from "./diagnostic-context"
import { reportError, setDiagnosticReceiptSession } from "./diag-log"
import { createDiagnosticCapture } from "./diagnostic-capture"
import { createDiagnosticMemory } from "./diagnostic-memory"
import { diagnosticSha256, type DiagnosticEvent } from "./diagnostic-summary"
import { createDiagnosticWindow, type DiagnosticClock, type DiagnosticTimer, type DiagnosticPublishAction } from "./diagnostic-window"
import { spaDeviceId } from "./spa-device-id"
export { safeErrorFrames } from "./diagnostic-context"
export type { DiagnosticPublishAction } from "./diagnostic-window"

/** Existing low-level callers supply local metadata, never permission to create a remote event. */
export type ErrorDiagnostic = {
  code: string
  source: "workbench" | "renderer_uncaught" | "renderer_rejection"
  severity: "blocking" | "degraded"
  frames: string[]
  diagnostic?: DiagnosticContextInput
}
export type TelemetryDeps = DiagnosticClock & {
  fetch: typeof fetch
  deviceId: () => string
  isOnline: () => boolean
  uuid?: () => string
  digest?: (text: string) => Promise<string>
}
export type DiagnosticPublishWindow = Readonly<{ action: DiagnosticPublishAction; actionId: string; close: () => void; flush: () => Promise<void> }>
type ActiveWindow = ReturnType<typeof createDiagnosticWindow> & { action: DiagnosticPublishAction }
type PendingEvent = { id: string; payload: string; claimableBy: DiagnosticPublishAction | null }

/** Even a transport that ignores AbortSignal cannot keep a diagnostic request/window alive. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Diagnostic request stopped", "AbortError"))
    // Observe the work even if its synchronous setup already closed the window.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** ONE held in-memory queue. Only an explicit active-route publish/report window may claim it. */
export function createErrorTelemetry(deps: TelemetryDeps = browserTelemetryDeps()) {
  let sessionKey: string | null = null
  let generation = 0
  let routeScopes = 0
  let queue: PendingEvent[] = []
  let active: ActiveWindow | undefined
  // Weak keys never retain a gesture. Two scalar counters fence all older callbacks without an ID history/LRU.
  let actionTokens = new WeakMap<DiagnosticPublishAction, number>()
  let issuedAction = 0
  let consumedAction = 0
  const memory = createDiagnosticMemory(deps.now, deps)
  let retryTimer: DiagnosticTimer | undefined
  let notBefore = 0
  let flight: AbortController | undefined

  const clearRetry = () => {
    if (retryTimer !== undefined) deps.clearTimer(retryTimer)
    retryTimer = undefined
  }
  const closeWindow = () => {
    active?.close()
    active = undefined
    clearRetry()
    flight?.abort()
    flight = undefined
  }
  const setContext = (next: { sessionKey: string | null }) => {
    if (sessionKey === next.sessionKey) return
    closeWindow()
    sessionKey = next.sessionKey
    generation++
    queue = []
    actionTokens = new WeakMap()
    issuedAction = 0
    consumedAction = 0
    memory.clear()
  }
  const enqueue = (event: DiagnosticEvent, publishAction: DiagnosticPublishAction | null) => {
    if (!sessionKey || queue.length >= 100 || queue.some((item) => item.id === event.diagnostic_id)) return
    // Event contains only capture-owned v4 primitives; originals stay in memory's separate copy port.
    const dispatchPhase = ["pre_dispatch", "submit", "reconcile", "repair", "result"].includes(event.stage)
    const claimableBy = dispatchPhase && active?.isOpen() && publishAction === active.action ? active.action : null
    queue.push({ id: event.diagnostic_id, payload: JSON.stringify(event), claimableBy })
    if (claimableBy && active) schedule(active, 0)
  }
  const normalizeCapture = createDiagnosticCapture({
    memory, generation: () => generation, enqueue, now: deps.now,
    uuid: deps.uuid ?? newDiagnosticId, digest: deps.digest ?? diagnosticSha256,
  })
  const capture: typeof normalizeCapture = (input) => sessionKey ? normalizeCapture(input) : Promise.resolve(null)
  const enterWorkflowRoute = () => {
    if (routeScopes++ === 0) closeWindow()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--routeScopes === 0) closeWindow()
    }
  }
  const eligible = (window: ActiveWindow) => {
    if (!deps.isOnline()) closeWindow()
    return !!sessionKey && routeScopes > 0 && active === window && window.isOpen() && deps.isOnline()
  }
  function schedule(window: ActiveWindow, delay: number) {
    if (!eligible(window) || flight || retryTimer !== undefined || !queue.some((item) => item.claimableBy === window.action)) return
    retryTimer = deps.setTimer(() => {
      retryTimer = undefined
      void flushWindow(window)
    }, Math.max(delay, notBefore - deps.now(), 0))
  }
  const flushWindow = async (window: ActiveWindow): Promise<void> => {
    if (!eligible(window) || flight || deps.now() < notBefore) return
    clearRetry()
    const selection = window.nextBatch(queue.filter((item) => item.claimableBy === window.action).map((item) => item.id))
    if (!selection) return
    const selected = new Set(selection.ids)
    const batch = queue.filter((item) => selected.has(item.id))
    const current = generation
    const controller = new AbortController()
    flight = controller
    const stop = () => controller.abort()
    window.signal.addEventListener("abort", stop, { once: true })
    const timeout = deps.setTimer(stop, Math.min(5_000, Math.max(0, window.deadline - deps.now())))
    let retryDelay = 1_000 * 2 ** (selection.attempt - 1)
    let response: Response | undefined
    try {
      response = await abortable(deps.fetch(route("eventsInbox"), {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Podhub-Device-Id": deps.deviceId() },
        body: JSON.stringify({ events: batch.map((item) => ({
          id: item.id, kind: "desktop_error_log.v4", schema_version: 4, payload_json: item.payload,
        })) }),
      }), controller.signal)
      if (generation !== current || !eligible(window) || controller.signal.aborted) return
      if (response.status === 401 || response.status === 403) { setContext({ sessionKey: null }); return }
      if (response.ok) {
        // The five-second deadline includes response-body consumption.
        const body: unknown = await abortable(response.json(), controller.signal)
        if (generation !== current || !eligible(window) || controller.signal.aborted) return
        const data = body && typeof body === "object" && "data" in body ? body.data : null
        if (data && typeof data === "object" && "accepted" in data && "rejected" in data
          && Array.isArray(data.accepted) && Array.isArray(data.rejected)) {
          const acknowledged = new Set<unknown>(data.accepted.filter((id) => typeof id === "string"))
          for (const rejected of data.rejected) {
            if (rejected && typeof rejected === "object" && typeof rejected.id === "string") acknowledged.add(rejected.id)
          }
          queue = queue.filter((item) => !selected.has(item.id) || !acknowledged.has(item.id))
        }
      } else if (response.status < 500 && response.status !== 429) {
        queue = queue.filter((item) => !selected.has(item.id))
      }
      const retryAfter = response.headers.get("Retry-After")
      if (retryAfter) {
        const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - deps.now()
        if (!Number.isNaN(delay)) retryDelay = Math.min(30_000, Math.max(retryDelay, delay))
      }
    } catch { /* Held immutable events can retry only within this action's remaining budget. */ }
    finally {
      // Retire every attempt before releasing ownership, including unread streaming 429/5xx bodies.
      // Abort is independent of submission; cancel also releases synthetic/non-fetch streams without waiting on their sink.
      controller.abort()
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
      deps.clearTimer(timeout)
      window.signal.removeEventListener("abort", stop)
      if (flight === controller) flight = undefined
      if (generation === current && eligible(window)) {
        notBefore = deps.now() + retryDelay
        schedule(window, retryDelay)
      }
    }
  }
  /** Mint once at the explicit gesture, never from retry/normalization; late callbacks retain this exact token. */
  const createPublishAction = (actionId: string): DiagnosticPublishAction | null => {
    if (!sessionKey || typeof actionId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(actionId)
      || issuedAction >= Number.MAX_SAFE_INTEGER) return null
    const action = Object.freeze({ actionId }) as DiagnosticPublishAction
    actionTokens.set(action, ++issuedAction)
    return action
  }
  const openPublishWindow = (action: DiagnosticPublishAction, signal: AbortSignal, timeoutMs = 120_000): DiagnosticPublishWindow | null => {
    const sequence = actionTokens.get(action)
    if (sequence === undefined || sequence <= consumedAction) return null
    // Spend before admission: Stop/offline/route-exit/invalid duration cannot make this gesture reusable.
    consumedAction = sequence
    actionTokens.delete(action)
    if (!sessionKey || routeScopes === 0 || !deps.isOnline() || signal.aborted) return null
    closeWindow()
    notBefore = 0
    const window: ActiveWindow = { ...createDiagnosticWindow(action.actionId, signal, deps, () => {
      if (active === window) { active = undefined; clearRetry(); flight?.abort(); flight = undefined }
    }, timeoutMs), action }
    active = window
    if (!window.isOpen()) { active = undefined; return null }
    // This explicit action can claim already-held records. Later unrelated/closed-action records cannot join it.
    for (const item of queue) item.claimableBy = action
    schedule(window, 0)
    return Object.freeze({ action, actionId: action.actionId, close: window.close, flush: () => flushWindow(window) })
  }
  /** General flush/online recovery cannot claim held items or reset an action's attempts. */
  const flush = async (): Promise<void> => { if (!deps.isOnline()) closeWindow() }
  const resume = () => { if (!deps.isOnline()) closeWindow() }
  return {
    capture, setContext, enterWorkflowRoute, createPublishAction, openPublishWindow, closePublishWindow: closeWindow,
    offline: closeWindow, flush, resume, detail: memory.detail, copyData: memory.copyData,
  }
}

function browserTelemetryDeps(): TelemetryDeps {
  return {
    fetch: (...args) => fetch(...args), deviceId: spaDeviceId, now: Date.now,
    setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimer: (timer) => globalThis.clearTimeout(timer),
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  }
}

const telemetry = createErrorTelemetry()
if (typeof window !== "undefined") window.addEventListener("offline", telemetry.offline)
let contextChanges = 0
export function setErrorTelemetryContext(context: { sessionKey: string | null; userId?: string; workspaceId?: string }): void {
  if (contextChanges > 0 && context.sessionKey !== null) return
  telemetry.setContext(context)
  setErrorFeedbackContext(context)
  setDiagnosticReceiptSession(context.sessionKey)
  setErrorReportIdentity(context.sessionKey ? { userId: context.userId, workspaceId: context.workspaceId } : null)
}
/** Cookie mutations fence concurrent polls; only a fresh overview may restore identity. */
export function beginErrorTelemetryContextChange(): () => void {
  contextChanges++
  telemetry.setContext({ sessionKey: null })
  setErrorFeedbackContext({ sessionKey: null })
  setDiagnosticReceiptSession(null)
  setErrorReportIdentity(null)
  let finished = false
  return () => {
    if (finished) return
    finished = true
    contextChanges--
    telemetry.setContext({ sessionKey: null })
    setErrorFeedbackContext({ sessionKey: null })
  }
}
/** Legacy low-level input stays local. Only captureDiagnostic creates reportable v4 events. */
export function queueErrorTelemetry(diagnostic: ErrorDiagnostic): void {
  const code = diagnosticProperty(diagnostic, "code")
  const source = diagnosticProperty(diagnostic, "source")
  reportError("[diagnostic]", null, {
    code: typeof code === "string" ? code : undefined, source: typeof source === "string" ? source : undefined,
  }, diagnosticProperty(diagnostic, "diagnostic") as DiagnosticContextInput | undefined)
}
export const captureDiagnostic = telemetry.capture
export const getDiagnosticDetail = telemetry.detail
export const getDiagnosticCopyData = telemetry.copyData
export const enterDiagnosticWorkflowRoute = telemetry.enterWorkflowRoute
export const createDiagnosticPublishAction = telemetry.createPublishAction
export const openDiagnosticPublishWindow = telemetry.openPublishWindow
export const closeDiagnosticPublishWindow = telemetry.closePublishWindow
export const resumeErrorTelemetry = telemetry.resume
