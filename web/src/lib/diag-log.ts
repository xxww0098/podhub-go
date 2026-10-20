/**
 * One-line diagnostics for the long-running browser paths — the render worker
 * and the preparation executor — so a stuck 一键准备 can be read off the
 * console: which row, which stage, how long, how much memory.
 *
 * One line per stage, `prefix event key=value …`, so a prefix search finds
 * everything and a row id narrows it. Values stay plain: numbers rounded,
 * strings verbatim, `undefined` dropped.
 */

import type { DiagnosticContextInput } from "./diagnostic-context"
import { createDiagnosticContext, safeErrorFrames } from "./diagnostic-context"

export type DiagFields = Record<string, string | number | boolean | null | undefined>

export const RENDER_LOG = "[render-wasm]"
export const PREPARE_LOG = "[prepare]"

/** Whole milliseconds since a `performance.now()` mark. */
export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

export function diagLine(prefix: string, event: string, fields: DiagFields = {}): string {
  const parts = [prefix, event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${typeof value === "number" ? Math.round(value) : String(value)}`)
  }
  return parts.join(" ")
}

/**
 * `diagnostic` is the failing operation's own business input (e.g. the Ozon
 * item it tried to submit), passed explicitly by that operation. It is
 * kept local. Only approved context identifiers are printed; payload objects
 * are never inspected or queued by this low-level console helper.
 */
export function diagLog(prefix: string, event: string, fields: DiagFields = {}, diagnostic?: DiagnosticContextInput): string | undefined {
  if (event === "error" || /(?:\.fail|\.error|_failed)$/.test(event)) {
    return writeError(prefix, event, undefined, fields, diagnostic)
  }
  console.log(diagLine(prefix, event, fields))
}

const reportedErrors = new WeakSet<object>()
const recentConsoleErrors = new Map<string, { atMs: number; errorId?: string }>()
let receiptSession: string | null = null

/** Test seam: a captured run starts with an empty console-dedupe window. */
export function resetConsoleDedupe(): void {
  recentConsoleErrors.clear()
}

/** A new account/workspace must never reuse the previous session's displayed receipt. */
export function setDiagnosticReceiptSession(sessionKey: string | null): void {
  if (receiptSession === sessionKey) return
  receiptSession = sessionKey
  recentConsoleErrors.clear()
}
const ERROR_PHASES = new Set(["ai", "ocr", "render", "upload", "save", "submit", "media", "compose", "prepare", "download", "slice", "probe", "writeback", "dispatch", "readback", "encode"])
function structuredCode(reason: unknown): string | undefined {
  try {
    if (reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string") return reason.code
  } catch { /* A diagnostic never calls an untrusted getter twice. */ }
  return undefined
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:[a-z]+:)?[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined
}

function writeError(
  prefix: string, event: string, reason: unknown, fields: DiagFields, diagnostic?: DiagnosticContextInput,
): string | undefined {
  const originalCode = safeCode(fields.code) ?? safeCode(structuredCode(reason))
  const code = originalCode
    ?? (event === "error" ? fields.source === "resource" ? "resource_failure" : "operation_failed" : safeCode(event))
    ?? "operation_failed"
  const stage = typeof fields.stage === "string" && ERROR_PHASES.has(fields.stage) ? fields.stage
    : ERROR_PHASES.has(event.split(".")[0]!) ? event.split(".")[0] : undefined
  const leg = typeof fields.leg === "string" && ERROR_PHASES.has(fields.leg) ? fields.leg : undefined
  const phases = [stage ? `stage:${stage}` : undefined, leg ? `leg:${leg}` : undefined].filter((phase): phase is string => phase !== undefined)
  const frames = [...safeErrorFrames(reason, fields.componentStack).slice(0, 20 - phases.length), ...phases]
  const safeFields: DiagFields = { code }
  if (stage) safeFields.stage = stage
  if (leg) safeFields.leg = leg
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" || typeof value === "boolean") safeFields[key] = value
    else if (key === "worker" && typeof value === "string" && /^[a-f0-9]{8}$/.test(value)) safeFields.worker = value
    else if (["source", "tag", "method", "kind", "row", "card", "requestId", "errorId", "traceId"].includes(key)
      && typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) safeFields[key] = value
    else if (key === "path" && typeof value === "string" && /^\/api\/[A-Za-z0-9_/-]{1,200}$/.test(value)) safeFields[key] = value
  }
  // Only the notification layer supplies reviewed operation copy. Raw exception text stays out.
  if (prefix === "[notify]" && typeof fields.message === "string") {
    safeFields.message = fields.message
      .replace(/(?:https?:\/\/|data:|blob:|file:\/\/|[A-Za-z]:\\|\/Users\/|\/home\/)\S+/gi, "[omitted]")
      .replace(/(?:bearer\s+\S+|(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+)/gi, "[omitted]")
      .replace(/\s+/g, " ").slice(0, 240)
  }
  if (diagnostic) safeFields.traceId = createDiagnosticContext(diagnostic).context.traceId
  if (frames.length) safeFields.frames = frames.join(",")
  const consoleKey = JSON.stringify([prefix, event, code, frames, stage, leg,
    safeFields.source, safeFields.row, safeFields.card, safeFields.method, safeFields.path, safeFields.tag, safeFields.kind,
    safeFields.worker, safeFields.request, safeFields.message, safeFields.traceId, safeFields.status])
  const now = Date.now()
  const recent = recentConsoleErrors.get(consoleKey)
  const errorId = safeCode(safeFields.errorId)
  // Repeated notices reuse the logged receipt; a first receipt cannot be hidden by an earlier unnumbered log.
  if (recent && now - recent.atMs < 30_000 && (recent.errorId || !errorId)) return recent.errorId
  recentConsoleErrors.delete(consoleKey)
  recentConsoleErrors.set(consoleKey, { atMs: now, errorId })
  if (recentConsoleErrors.size > 100) recentConsoleErrors.delete(recentConsoleErrors.keys().next().value!)
  console.log(diagLine(prefix, event, safeFields))
  return errorId
}

/**
 * Local console only; arbitrary reason/cause text is never emitted.
 * `diagnostic` is the operation's own business input, as for `diagLog`.
 */
export function reportError(prefix: string, reason: unknown, fields: DiagFields = {}, diagnostic?: DiagnosticContextInput): string | undefined {
  if (typeof reason === "object" && reason !== null) {
    // A displayed receipt must stay findable after the operation logged this exception.
    if (reportedErrors.has(reason) && !safeCode(fields.errorId)) return
    reportedErrors.add(reason)
  }
  return writeError(prefix, "error", reason, fields, diagnostic)
}

/**
 * The render manifest's `stageTimings` as log fields: `stage=count` per stage,
 * with `/<ms>ms` appended where the renderer had a clock. The wasm boundary
 * supplies `performance.now()` to the renderer, while an unavailable clock
 * still leaves the stage count intact.
 */
export function stageCountFields(stageTimings: unknown): DiagFields {
  if (!stageTimings || typeof stageTimings !== "object") return {}
  const fields: DiagFields = {}
  for (const [stage, entry] of Object.entries(stageTimings as Record<string, unknown>)) {
    const { ms, count } = (entry ?? {}) as { ms?: unknown; count?: unknown }
    if (typeof count !== "number") continue
    fields[stage] = typeof ms === "number" ? `${count}/${ms.toFixed(1)}ms` : count
  }
  return fields
}
