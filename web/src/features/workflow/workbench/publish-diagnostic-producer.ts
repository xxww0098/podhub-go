import { rowCacheScope } from "@/bindings/listing-row-cache"
import { captureDiagnostic } from "@/lib/error-telemetry"
import { safeDiagnosticTrace } from "@/lib/diagnostic-context"
import { createErrorFeedback, reportFeedback } from "@/lib/error-feedback"
import type { ListingRow } from "../model/listing-row"
import type { PublishProblem } from "../model/publish-problem"
import { normalizePublishDiagnostic, type PublishDiagnosticReference } from "../model/publish-diagnostic"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { nativeSolution } from "../model/publish-solutions-native"
import { currentPublishRequestEvidence, type PublishRequestIdentity } from "../model/publish-request-evidence"
import { createSliceBudget } from "../platforms/core"
import { publishStoreAssignments } from "../submit/publish-policy"
import { listingWorkbenchScope, patchListingWorkbench, peekListingWorkbench, type ListingWorkbenchRuntime } from "./listing-workbench-store"

function identityOf(state: ListingWorkbenchRuntime, row: ListingRow, targets = publishStoreAssignments(state)): PublishRequestIdentity | undefined {
  const product = state.productBases[row.draftId]
  if (!state.cardId || !product || state.dirtyProducts[row.draftId] || state.removedProducts.has(row.draftId)
    || state.pendingRemovalIds.has(row.draftId) || state.rowSaveStates[row.draftId] === "saving") return undefined
  return { scope: state.scope, mediaEpoch: state.mediaEpoch, cardId: state.cardId, rowId: row.draftId,
    storeId: targets.get(row.draftId) ?? product.target_store_id,
    revision: product.lifecycle.revision, viewRevision: product.lifecycle.view_revision }
}

/** Read-only currentness for the existing workbench presenter. */
export function currentWorkbenchDiagnostic(row: ListingRow, state = peekListingWorkbench(), targets = publishStoreAssignments(state)) {
  const identity = identityOf(state, row, targets)
  const ref = row.publishDiagnostic
  if (!identity || !ref) return undefined
  const before = ref.identity
  return Object.entries(identity).every(([key, value]) => Object.entries(before).some(([k, v]) => k === key && v === value)) ? ref : undefined
}

/** A failed explicit native action, independent of polling and business-state mutation. */
export async function captureWorkbenchPublishProblem(rowId: string, revision: number, problem: PublishProblem, current: () => boolean) {
  const input = normalizePublishDiagnostic(problem)
  if (!input || !current()) return null
  const session = rowCacheScope().current
  const state = peekListingWorkbench(), row = state.rows.find((item) => item.draftId === rowId)
  const identity = row && identityOf(state, row)
  const solution = resolvePublishRemediation(problem)
  const errorFeedback = solution ? createErrorFeedback({ code: solution.cause, message: solution.reason,
    remediation: solution.steps[0], traceId: safeDiagnosticTrace(problem.traceId) }, "商品处理失败") : undefined
  const reference = identity && identity.revision === revision ? { eventKey: crypto.randomUUID(), identity, errorFeedback } : undefined
  if (row && reference) patchListingWorkbench({ rows: state.rows.map((item) => item === row ? { ...item, publishDiagnostic: reference } : item) }, state.scope)
  if (reference?.errorFeedback) reportFeedback(reference.errorFeedback, { stage: problem.stage, rowId, cardId: identity!.cardId })
  const detail = await captureDiagnostic(input)
  if (!detail?.event || !session() || !current()) return null
  const latest = peekListingWorkbench(), candidate = latest.rows.find((item) => item.draftId === rowId)
  if (reference && candidate && currentWorkbenchDiagnostic(candidate, latest) === reference) {
    patchListingWorkbench({ rows: latest.rows.map((item) => item === candidate ? { ...item,
      publishDiagnostic: { ...reference, diagnosticId: detail.diagnosticId, traceId: detail.event!.trace_id },
    } : item) }, state.scope)
  }
  return detail
}

/** Called after a successful business commit, never inside a React/store projector. */
export async function captureWorkbenchPublishDiagnostics(
  draftIds: readonly string[], scope = listingWorkbenchScope(),
  supplied: ReadonlyMap<string, PublishDiagnosticReference> = new Map(),
): Promise<void> {
  const session = rowCacheScope().current
  const state = peekListingWorkbench()
  if (state.scope !== scope || !session()) return
  const indexedRows = new Map(state.rows.map((row) => [row.draftId, row]))
  const targets = publishStoreAssignments(state)
  const changes = new Map<string, ListingRow["publishDiagnostic"]>()
  const pending: Array<{ draftId: string; reference: NonNullable<ListingRow["publishDiagnostic"]>;
    input: NonNullable<ReturnType<typeof normalizePublishDiagnostic>> }> = []
  for (const draftId of new Set(draftIds)) {
    const row = indexedRows.get(draftId)
    const identity = row && identityOf(state, row, targets)
    const product = state.productBases[draftId]
    if (!row || !identity || !product) continue
    const request = currentPublishRequestEvidence(row.publishRequestEvidence, identity)
    const solution = resolvePublishRemediation({ lifecycle: product.lifecycle, readiness: row.readiness,
      rowLog: row.publishRequestEvidence && !request ? "" : row.log, localUnconfirmed: row.publishUnconfirmed,
      tracks: row, psdTemplateFailure: row.psdTemplateFailure, hasSource: !!row.source, imageName: row.imageName,
      requestEvidence: request, requestIdentity: identity })
    const issue = product.lifecycle.submission_issue
    const input = solution && normalizePublishDiagnostic(solution, { traceEvidence: {
      listingIssueTraceId: issue && issue.resolved_at_ms == null && issue.input_revision === product.lifecycle.revision ? issue.trace_id : undefined,
    } })
    // Only closed, safe coordinates identify a problem. Raw summaries/reasons are not retained here.
    const existing = currentWorkbenchDiagnostic(row, state, targets)
    const provided = supplied.get(draftId) ?? (existing?.eventKey === existing?.diagnosticId ? existing : undefined)
    const eventKey = solution ? JSON.stringify([identity, input?.code ?? null, solution.cause,
      issue?.phase === "submit" || issue?.phase === "pre_dispatch" ? issue.phase : null,
      issue && nativeSolution(input?.platform ?? "", issue.phase, issue.code) ? issue.code : null,
      safeDiagnosticTrace(issue?.intent_id) ?? null,
      typeof issue?.created_at_ms === "number" ? issue.created_at_ms : null,
      input?.traceEvidence?.listingIssueTraceId ?? null]) : undefined
    const current = currentWorkbenchDiagnostic(row, state, targets)
    if (current && current.eventKey === eventKey && (!provided || current.diagnosticId === provided.diagnosticId)) continue
    const errorFeedback = eventKey && solution && (input || provided)
      ? current?.eventKey === eventKey && current.errorFeedback ? current.errorFeedback
        : createErrorFeedback({ code: solution.cause, message: solution.reason, remediation: solution.steps[0],
          traceId: input?.traceEvidence?.listingIssueTraceId ?? solution.traceId }, "商品处理失败")
      : undefined
    const reference = eventKey && (input || provided) ? { ...(provided ?? { eventKey }), eventKey, identity, errorFeedback } : undefined
    if (!reference && !row.publishDiagnostic) continue
    changes.set(draftId, reference)
    if (!input || !reference || provided?.diagnosticId) continue
    pending.push({ draftId, reference, input })
  }
  if (!changes.size) return
  // Reserve the entire normalized batch synchronously before any capture yields.
  patchListingWorkbench({ rows: state.rows.map((row) => changes.has(row.draftId)
    ? { ...row, publishDiagnostic: changes.get(row.draftId) } : row) }, scope)
  for (const [rowId, reference] of changes) {
    if (reference?.errorFeedback) reportFeedback(reference.errorFeedback, { stage: "submit", rowId, cardId: reference.identity.cardId })
  }
  const completed = new Map<string, { reference: NonNullable<ListingRow["publishDiagnostic"]>;
    detail: Awaited<ReturnType<typeof captureDiagnostic>> }>()
  const yieldSlice = createSliceBudget()
  for (const entry of pending) {
    if (!session() || peekListingWorkbench().scope !== scope) return
    completed.set(entry.draftId, { reference: entry.reference, detail: await captureDiagnostic(entry.input) })
    await yieldSlice()
  }
  if (!completed.size || !session()) return
  // One completion commit, with each row's current identity still authoritative.
  patchListingWorkbench((latest) => {
    let attached = false
    const targets = publishStoreAssignments(latest)
    const rows = latest.rows.map((row) => {
      const result = completed.get(row.draftId)
      if (!result?.detail?.event || currentWorkbenchDiagnostic(row, latest, targets) !== result.reference) return row
      attached = true
      return { ...row, publishDiagnostic: { ...result.reference,
        diagnosticId: result.detail.diagnosticId, traceId: result.detail.event.trace_id } }
    })
    return attached ? { rows } : {}
  }, scope)
}
