/**
 * What the send rail refuses before any request: facts this tab already
 * holds (the click's pins, the workbench's unsaved/removing rows, a resident
 * row's own stage and native fields). Every refusal says what to do next in
 * Chinese. These are business refusals: nothing here is logged or reported.
 */
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import type { LeanRow } from "@/listing-core/types"
import { isRecord, positiveId } from "@/lib/utils"
import type { ListingWorkbenchRuntime } from "../workbench/listing-workbench-store"

export type RowPin = { revision: number, store_id?: string | null }

export function blocked(rowId: string, code: string, message: string, remediation: string, extra: Partial<WorkflowOperationRowResult> = {}): WorkflowOperationRowResult {
  return { row_id: rowId, outcome: "blocked", blockers: [], error: { code, message, remediation }, ...extra }
}

export function cancelledResult(rowId: string): WorkflowOperationRowResult {
  return { row_id: rowId, outcome: "noop", blockers: [], noop_reason: "cancelled" }
}

export function revisionMismatch(rowId: string): WorkflowOperationRowResult {
  return blocked(rowId, "workflow_revision_mismatch", "商品已在本次点击后更新，未发送", "刷新后确认最新内容再发送", { noop_reason: "revision_mismatch" })
}

const UNSENDABLE_STAGES: Record<string, [string, string, string]> = {
  outcome_unknown: ["workflow_outcome_unknown", "上次发送结果尚未确认", "先核对云端记录；确认未提交前不要重复发送"],
  fields_invalid: ["workflow_fields_invalid", "字段校验未通过", "按字段提示修改该商品后再发送"],
  candidates_pending: ["workflow_candidates_unresolved", "仍有未确认的 AI 候选", "在候选审阅中确认或拒绝 AI 候选值后再发送"],
}

function stageRefusal(rowId: string, stage: unknown): WorkflowOperationRowResult | undefined {
  const refusal = typeof stage === "string" ? UNSENDABLE_STAGES[stage] : undefined
  return refusal && blocked(rowId, ...refusal)
}

/** The click's pin and the workbench's own state for this row. */
export function localRefusal(
  rowId: string,
  pin: RowPin | undefined,
  workbench: Pick<ListingWorkbenchRuntime, "dirtyProducts" | "rowSaveStates" | "pendingRemovalIds" | "productDrafts" | "rows">,
): WorkflowOperationRowResult | undefined {
  if (!pin || !Number.isSafeInteger(pin.revision) || pin.revision < 0) {
    return blocked(rowId, "workflow_revision_missing", "商品版本缺失，请刷新后重试发送", "刷新页面后重新选择要发送的商品")
  }
  if (workbench.pendingRemovalIds.has(rowId)) {
    return blocked(rowId, "workflow_row_removing", "该商品正在删除，未发送", "等待删除完成，或刷新后重新选择")
  }
  if (workbench.dirtyProducts[rowId] || ["dirty", "saving", "error"].includes(workbench.rowSaveStates[rowId] ?? "idle")) {
    return blocked(rowId, "workflow_row_unsaved", "该商品还有未保存到云端的修改，未发送", "等待保存完成（或重试保存）后再发送")
  }
  const listed = workbench.rows.find((row) => row.draftId === rowId)
  if (listed?.candidates?.some((candidate) => candidate.state === "proposed" || candidate.state === "unresolved")) {
    return blocked(rowId, ...UNSENDABLE_STAGES.candidates_pending!)
  }
  return stageRefusal(rowId, workbench.productDrafts[rowId]?.lifecycle.stage)
}

/**
 * The resident row's payload as op 11's `LeanRow` (`ListingRowView.payload` is
 * `RowPayload` minus `schemaSnapshot`). Only the fields this rail routes on are
 * checked; the native decoder refuses anything else it cannot read.
 */
export function nativeRow(row: ListingRowView): { row: LeanRow } | { refusal: WorkflowOperationRowResult } {
  const stage = stageRefusal(row.id, (row.projection as { stage?: unknown } | undefined)?.stage)
  if (stage) return { refusal: stage }
  const payload = row.payload as Partial<LeanRow> | undefined
  if (
    !row.card_id || !isRecord(payload) || !positiveId(payload.descriptionCategoryId) || !positiveId(payload.typeId) ||
    typeof payload.schemaRevision !== "string" || !payload.schemaRevision.trim() ||
    typeof payload.language !== "string" || !isRecord(payload.draft)
  ) {
    return {
      refusal: blocked(row.id, "workflow_row_payload_invalid", "商品缺少类目或字段版本，无法在本地生成发送内容", "刷新页面重新载入该商品；仍失败请重新生成该商品"),
    }
  }
  return { row: payload as LeanRow }
}
