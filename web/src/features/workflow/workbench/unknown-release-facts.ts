import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { offerIdFromView } from "../submit/publish-policy"

/** How many rows the strip names before it summarizes the rest. */
export const UNKNOWN_RELEASE_FACT_LIMIT = 8

export type UnknownEvidenceGap = "intent" | "store" | "permission"

export type UnknownReleaseFact = {
  id: string
  offerId: string
  taskId?: string
  intentId?: string
  storeLabel?: string
  missing: UnknownEvidenceGap[]
}

const GAP_COPY: Record<UnknownEvidenceGap, string> = {
  intent: "Intent",
  store: "店铺",
  permission: "释放权限",
}

/**
 * What the strip can say from the row the workbench already has.
 * `available` is the existing release gate; this does not decide it.
 */
export function unknownReleaseFacts(
  rows: readonly ListingRow[],
  drafts: Record<string, WorkflowDraftView | undefined>,
  stores: Record<string, { label?: string } | undefined>,
  available: boolean,
): UnknownReleaseFact[] {
  return rows.map((row) => {
    const draft = drafts[row.draftId]
    const lifecycle = draft?.lifecycle
    const offerId = offerIdFromView(draft, row.imageName)
    const taskId = lifecycle?.taskId?.trim() || undefined
    const intentId = lifecycle?.run_id?.trim() || lifecycle?.submission_issue?.intent_id?.trim() || undefined
    const storeId = draft?.target_store_id?.trim() || ""
    const storeLabel = storeId ? (stores[storeId]?.label?.trim() || storeId) : undefined
    const missing: UnknownEvidenceGap[] = []
    if (!intentId) missing.push("intent")
    if (!storeId) missing.push("store")
    if (!available) missing.push("permission")
    return { id: row.id, offerId, taskId, intentId, storeLabel, missing }
  })
}

/** One row of the strip: 货号, 任务号 when present, then the missing evidence. */
export function unknownReleaseFactLine(fact: UnknownReleaseFact): string {
  const offer = fact.offerId ? `货号「${fact.offerId}」` : "货号未记录"
  const task = fact.taskId ? `，任务号 ${fact.taskId}` : ""
  const store = fact.storeLabel ? `，店铺「${fact.storeLabel}」` : ""
  const intent = fact.intentId ? `，Intent ${fact.intentId}` : ""
  const gaps = fact.missing.map((gap) => GAP_COPY[gap]).join("、")
  return gaps ? `${offer}${task}${store}${intent}。缺少${gaps}` : `${offer}${task}${store}${intent}`
}
