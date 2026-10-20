import { route } from "@/api/routes"
import type { DiagnosticClock, DiagnosticTimer } from "./diagnostic-window"
import type { ErrorMediaSummary, ErrorReportEnvironment } from "./error-report-environment"
import { spaDeviceId } from "./spa-device-id"
import { UUID_PATTERN } from "./utils"

/** Machine identifiers and bounded environment. Never exception text, URLs or secrets. */
export type ErrorFeedbackInput = ErrorReportEnvironment & {
  errorId: string
  code: string
  traceId?: string
  status?: number
  appVersion?: string
  userId?: string
  workspaceId?: string
  userAgent?: string
}

export const ERROR_FEEDBACK_KEYS = ["errorId", "code", "traceId", "status", "stage", "rowId", "cardId", "appVersion", "userId", "workspaceId", "userAgent", "requestId", "apiPath", "apiStatus", "refusalReason", "media"] as const
type Deps = DiagnosticClock & { fetch: typeof fetch; deviceId: () => string; isOnline: () => boolean }
type Pending = { id: string; payload: string; attempts: number; expires: number }

const ID = /^[A-Za-z0-9_.:-]+$/
const TALLY = /^[a-z0-9_]+:\d+(?:,[a-z0-9_]+:\d+)*$/

function text(value: unknown, pattern: RegExp, max: number): string | undefined {
  return typeof value === "string" && value.length <= max && pattern.test(value) ? value : undefined
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}
function tally(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 && TALLY.test(value) ? value : undefined
}
function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined
}

function mediaOf(value: ErrorMediaSummary | undefined): ErrorMediaSummary | undefined {
  if (!value) return undefined
  const media: ErrorMediaSummary = {}
  const stage = text(value.stage, /^[a-z0-9_]+$/, 32)
  const phase = text(value.media, /^[a-z0-9_]+$/, 32)
  const phases = tally(value.phases)
  const objects = tally(value.objects)
  const imageTotal = boundedCount(value.imageTotal)
  const imageCompleted = boundedCount(value.imageCompleted)
  const videos = boundedCount(value.videos)
  const blockedRows = boundedCount(value.blockedRows)
  if (stage) media.stage = stage
  if (phase) media.media = phase
  if (imageTotal !== undefined) media.imageTotal = imageTotal
  if (imageCompleted !== undefined) media.imageCompleted = imageCompleted
  if (phases) media.phases = phases
  if (videos !== undefined) media.videos = videos
  if (value.cover === "present" || value.cover === "absent") media.cover = value.cover
  if (objects) media.objects = objects
  if (blockedRows !== undefined) media.blockedRows = blockedRows
  return Object.keys(media).length ? media : undefined
}

function receipt(input: ErrorFeedbackInput): ErrorFeedbackInput | null {
  const safe: ErrorFeedbackInput = { errorId: input.errorId, code: input.code }
  if (typeof safe.errorId !== "string" || !/^[0-9]{20}$/.test(safe.errorId)
    || typeof safe.code !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(safe.code)) return null
  for (const key of ["traceId", "rowId", "cardId"] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !ID.test(value) || value.length > 128) return null
    safe[key] = value
  }
  const requestId = text(input.requestId, ID, 128)
  if (requestId) safe.requestId = requestId
  const stage = input.stage
  if (stage !== undefined) {
    if (typeof stage !== "string" || !ID.test(stage) || stage.length > 32) return null
    safe.stage = stage
  }
  const status = httpStatus(input.status)
  if (input.status !== undefined && status === undefined) return null
  if (status !== undefined) safe.status = status
  const appVersion = text(input.appVersion, /^\d+\.\d+\.\d+$/, 32)
  if (appVersion) safe.appVersion = appVersion
  const userId = text(input.userId, UUID_PATTERN, 36)
  if (userId) safe.userId = userId.toLowerCase()
  const workspaceId = text(input.workspaceId, UUID_PATTERN, 36)
  if (workspaceId) safe.workspaceId = workspaceId.toLowerCase()
  const userAgent = text(input.userAgent, /^[\x20-\x7e]{1,180}$/, 180)
  if (userAgent && !/:\/\/|bearer|token|x-amz|secret|password|=/i.test(userAgent)) safe.userAgent = userAgent
  const apiPath = text(input.apiPath, /^\/api\/[A-Za-z0-9_./-]{1,154}$/, 160)
  if (apiPath && !apiPath.includes("..") && !apiPath.includes("//")) safe.apiPath = apiPath
  const apiStatus = httpStatus(input.apiStatus)
  if (apiStatus !== undefined) safe.apiStatus = apiStatus
  const refusalReason = text(input.refusalReason, /^(?:[a-z]+:)?[A-Za-z0-9_.-]{1,64}$/, 64)
  if (refusalReason && refusalReason !== "operation_failed" && refusalReason !== "-") safe.refusalReason = refusalReason
  const media = mediaOf(input.media)
  if (media) safe.media = media
  const payload = JSON.stringify(safe)
  if (payload.length > 2048) {
    const core = { ...safe }
    delete core.media
    delete core.userAgent
    const shorter = JSON.stringify(core)
    return shorter.length <= 2048 ? core : null
  }
  return safe
}

/** Separate automatic, memory-only receipts; this never opens a v4 diagnostic publish window. */
export function createErrorFeedbackReporting(deps: Deps) {
  let sessionKey: string | null = null
  let generation = 0
  let queue: Pending[] = []
  const seen = new Set<string>()
  let timer: DiagnosticTimer | undefined
  let flight: AbortController | undefined
  let notBefore = 0
  const clearTimer = () => {
    if (timer !== undefined) deps.clearTimer(timer)
    timer = undefined
  }
  const setContext = (context: { sessionKey: string | null }) => {
    if (context.sessionKey === sessionKey) return
    sessionKey = context.sessionKey
    generation++
    clearTimer()
    flight?.abort()
    flight = undefined
    queue = []
    seen.clear()
    notBefore = 0
  }
  function schedule(delay = 0) {
    if (!sessionKey || flight || timer !== undefined || !queue.length) return
    timer = deps.setTimer(() => { timer = undefined; void flush() }, Math.max(delay, notBefore - deps.now(), 0))
  }
  async function flush(): Promise<void> {
    if (!sessionKey || flight) return
    clearTimer()
    queue = queue.filter((item) => item.expires > deps.now() && item.attempts < 3)
    if (!queue.length) return
    if (!deps.isOnline()) { schedule(5_000); return }
    if (deps.now() < notBefore) { schedule(); return }
    const batch = queue.slice(0, 20)
    const current = generation
    const controller = new AbortController()
    flight = controller
    batch.forEach((item) => item.attempts++)
    const timeout = deps.setTimer(() => controller.abort(), 5_000)
    let abort = () => {}
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Receipt request stopped", "AbortError"))
      controller.signal.addEventListener("abort", abort, { once: true })
    })
    let delay = 1_000 * 2 ** (Math.max(...batch.map((item) => item.attempts)) - 1)
    let response: Response | undefined
    const remove = (ids: Set<unknown>) => { queue = queue.filter((item) => !batch.includes(item) || !ids.has(item.id)) }
    try {
      response = await Promise.race([deps.fetch(route("eventsInbox"), {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Podhub-Device-Id": deps.deviceId() },
        body: JSON.stringify({ events: batch.map((item) => ({ id: item.id, kind: "error_feedback.v1", schema_version: 1, payload_json: item.payload })) }),
      }), stopped])
      if (generation !== current || controller.signal.aborted) return
      if (response.status === 401 || response.status === 403) { setContext({ sessionKey: null }); return }
      if (response.ok) {
        const body: unknown = await Promise.race([response.json(), stopped])
        if (generation !== current || controller.signal.aborted) return
        const data = body && typeof body === "object" && "data" in body ? body.data : null
        if (data && typeof data === "object" && "accepted" in data && "rejected" in data
          && Array.isArray(data.accepted) && Array.isArray(data.rejected)) {
          const ids = new Set<unknown>(data.accepted.filter((id) => typeof id === "string"))
          for (const rejected of data.rejected) {
            // Inbox write failures are transient; malformed/conflicting receipts are terminal.
            if (rejected && typeof rejected === "object" && typeof rejected.id === "string"
              && rejected.reason !== "写入失败" && rejected.reason !== "服务暂不可用") ids.add(rejected.id)
          }
          remove(ids)
          if (batch.some((item) => ids.has(item.id))) delay = 250
        }
      } else if (response.status < 500 && response.status !== 429 && response.status !== 408) {
        remove(new Set(batch.map((item) => item.id)))
      }
      const retryAfter = response.headers.get("Retry-After")
      if (retryAfter) {
        const ms = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - deps.now()
        if (Number.isFinite(ms)) delay = Math.max(delay, Math.min(120_000, ms))
      }
    } catch { /* Receipt delivery is best effort and must never recursively report its own failure. */ }
    finally {
      controller.signal.removeEventListener("abort", abort)
      controller.abort()
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
      deps.clearTimer(timeout)
      if (flight === controller) flight = undefined
      if (generation === current) {
        queue = queue.filter((item) => item.attempts < 3 && item.expires > deps.now())
        notBefore = deps.now() + delay
        schedule()
      }
    }
  }
  const report = (input: ErrorFeedbackInput): void => {
    if (!sessionKey || queue.length >= 1_000) return
    try {
      const safe = receipt(input)
      if (!safe || seen.has(safe.errorId)) return
      seen.add(safe.errorId)
      if (seen.size > 2_000) seen.delete(seen.values().next().value!)
      queue.push({ id: safe.errorId, payload: JSON.stringify(safe), attempts: 0, expires: deps.now() + 120_000 })
      schedule()
    } catch { /* Invalid runtime input cannot break the user's error feedback. */ }
  }
  return { report, setContext, flush }
}

const reporting = createErrorFeedbackReporting({
  fetch: (...args) => fetch(...args), deviceId: spaDeviceId, now: Date.now,
  setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer: (timer) => globalThis.clearTimeout(timer),
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
})
export const reportErrorFeedback = reporting.report
/** Parent must fence this alongside error telemetry on logout, workspace switch, and cookie mutation. */
export const setErrorFeedbackContext = reporting.setContext
