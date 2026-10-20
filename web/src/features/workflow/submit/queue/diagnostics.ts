import type { RequestEvidence } from "@/api/client-options"
import {
  closeDiagnosticPublishWindow, createDiagnosticPublishAction, openDiagnosticPublishWindow,
  type DiagnosticPublishAction, type DiagnosticPublishWindow,
} from "@/lib/error-telemetry"
import type { PublishProblem, PublishRemediation } from "../../model/publish-problem"
import { capturePublishDiagnostic, normalizePublishDiagnostic, type PublishDiagnosticDispatch } from "../../model/publish-diagnostic"
import type { LocalRow } from "../../rows/types"
import type { SendQueueOptions } from "./types"

export function currentLocalPublishDiagnostic(row: LocalRow) {
  return row.diagnostic?.revision === row.rev ? row.diagnostic : undefined
}

/** Current local producer, shared by final result and local validation boundaries. */
export async function captureLocalPublishDiagnostic(
  options: SendQueueOptions, rowId: string, expectedRev: number, problems: readonly PublishProblem[],
): Promise<void> {
  const row = options.rows.get(rowId)
  if (!options.current() || !options.rows.writable || !row || row.rev !== expectedRev) return
  const inputs = problems.map((problem) => normalizePublishDiagnostic(problem)).filter((input) => input !== null)
  if (!inputs.length) return
  const eventKey = JSON.stringify([rowId, expectedRev, inputs.map((input) => [input.platform, input.stage, input.code, input.field])])
  if (currentLocalPublishDiagnostic(row)?.eventKey === eventKey) return
  const reference = { eventKey, revision: expectedRev }
  if (!options.rows.attachDiagnostic(rowId, expectedRev, reference)) return
  for (const problem of problems) {
    const detail = await capturePublishDiagnostic(problem)
    if (!detail?.event || !options.current() || !options.rows.writable) continue
    const current = options.rows.get(rowId)
    if (current?.rev !== expectedRev || current.diagnostic?.eventKey !== eventKey) return
    options.rows.attachDiagnostic(rowId, expectedRev, { ...reference, diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id })
    break
  }
}

/** One logical scheduler action, kept in its owner, never persisted or reminted on Continue. */
export function createPublishDiagnosticAction(actionId: string, current: () => boolean, restored = false) {
  const action: DiagnosticPublishAction | null = restored ? null : createDiagnosticPublishAction(actionId)
  const stop = new AbortController()
  let attempted = false
  let window: DiagnosticPublishWindow | null = null
  const context: PublishDiagnosticDispatch = { action, current,
    onDispatch() {
      if (attempted || !current()) return
      attempted = true
      if (action) window = openDiagnosticPublishWindow(action, stop.signal)
    },
  }
  return { context, close() { stop.abort(); window?.close(); closeDiagnosticPublishWindow() } }
}

/** Request-local exact bytes, released after normalization. No transport-side classifier. */
export function createPublishDiagnosticOperation(context?: PublishDiagnosticDispatch) {
  let evidence: RequestEvidence | undefined
  let dispatched = false
  return {
    onDispatch: () => { dispatched = true; context?.onDispatch() },
    wasDispatched: () => dispatched,
    onEvidence: (value: RequestEvidence) => { evidence = value },
    capture: (problem: PublishProblem | PublishRemediation) => {
      if (context && !context.current()) return Promise.resolve(null)
      return capturePublishDiagnostic(problem, {
        publishAction: context?.action,
        traceEvidence: { requestHeaderTraceId: evidence?.traceId },
        exactOperation: evidence?.jsonText == null ? null : { provenance: "submitted_http_body", jsonText: evidence.jsonText },
      }).then((detail) => !context || context.current() ? detail : null)
    },
    clear() { evidence = undefined },
  }
}
