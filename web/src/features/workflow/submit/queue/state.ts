import type { LocalRow, PublishBlock, PublishQueueState } from "../../rows/types"
import type { PlatformIssue } from "../../platforms/core"
import type { PreparedRow, SendFact, SendQueueOptions } from "./types"
import { captureLocalPublishDiagnostic } from "./diagnostics"
import type { PublishDiagnosticReference } from "../../model/publish-diagnostic"

export function queueIssue(platform: string, code: string, message: string, remediation: string): PlatformIssue {
  return { platform, stage: "build", field: null, code, message, remediation }
}

export function rejectLocal(options: SendQueueOptions, queue: PublishQueueState, block: PublishBlock, row: LocalRow, code: string, issues?: readonly PlatformIssue[], diagnostic?: PublishDiagnosticReference): void {
  if (!options.current()) return
  const updated = options.rows.update(row.id, (current) => ({ ...current,
    diagnostic: diagnostic ? { ...diagnostic, revision: row.rev + 1 } : undefined, submission: {
    platform: block.platform, storeId: block.destination, logicalBlockId: block.id, sendActionId: queue.actionId,
    state: "rejected", receipt: { state: "rejected", canResume: true, code, issues },
  } }), { expectRev: row.rev })
  if (updated) {
    queue.evidence.push({ blockId: block.id, rowId: row.id, state: "rejected" })
    if (!diagnostic && issues?.length) void captureLocalPublishDiagnostic(options, row.id, row.rev + 1, issues)
  }
}

export function applyFact(options: SendQueueOptions, queue: PublishQueueState, block: PublishBlock, item: PreparedRow, expectedRev: number, fact: SendFact): void {
  queue.evidence.push({ blockId: block.id, rowId: item.rowId, intentId: fact.intentId, serverOperationId: fact.serverOperationId, state: fact.state })
  const lock = queue.locks.find((entry) => entry.platform === block.platform && entry.destination === block.destination && entry.rowId === item.rowId && entry.offerId === item.offerId)
  if (fact.state === "rejected") {
    queue.locks = queue.locks.filter((entry) => entry !== lock)
  } else if (lock) {
    lock.state = fact.state === "accepted" ? "accepted" : fact.state === "pending" ? "pending" : "unknown"
    lock.intentId = fact.intentId
    lock.serverOperationId = fact.serverOperationId
  }
  // A late response remains in the original card journal, not a new row revision/session.
  if (!options.current()) return
  const updated = options.rows.update(item.rowId, (row) => ({ ...row,
    diagnostic: fact.diagnostic ? { ...fact.diagnostic, revision: expectedRev + 1 } : undefined, submission: {
    platform: block.platform, storeId: block.destination, logicalBlockId: block.id, sendActionId: queue.actionId,
    offerId: item.offerId, digest: item.digest, intentId: fact.intentId,
    clientOperationId: fact.serverOperationId, serverRevision: fact.serverRevision, taskId: fact.taskId,
    state: fact.state === "pending" ? "queued" : fact.state === "unknown" ? "unconfirmed" : fact.state,
    receipt: fact,
  } }), { expectRev: expectedRev })
  if (updated && !fact.diagnostic && !fact.diagnosticClassified && fact.state === "unknown") void captureLocalPublishDiagnostic(options, item.rowId, expectedRev + 1,
    [{ platform: block.platform, stage: "submit", family: "control", code: "result_unconfirmed" }])
}
