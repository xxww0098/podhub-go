import { resolvePublishSolution } from "../model/publish-solutions"
import type { WorkflowDraftView } from "@/bindings/commands"
import { cardPayload } from "@/bindings/listing-projection"
import { peekCardSession } from "../card/card-session"
import { associationStoreConflicts, parseStoreIds, sendStoreAssignments } from "../store-quota"
import { associatedImportedRow } from "../workbench/workbench-model"
import type { ListingRow } from "../model/listing-row"
import { composeBlockedBySignedOut } from "../product-instances"
import {
  rowPreparing,
  type GuidedPreparation,
  type PreparationActivity,
} from "../prepare/preparation-tracks"
import type { ListingWorkbenchRuntime } from "../workbench/listing-workbench-store"

/**
 * A batch item the Cloud skipped without creating an intent, in the row log's
 * own words. `blocked` refusals carry their blockers through blockedLogs; the
 * plain skip codes need this mapping to be readable in the 发布状态 cell.
 */
export function publishSkipMessage(reason: string): string {
  const control = reason === "cancelled" || reason === "result_unconfirmed"
  const solution = resolvePublishSolution({ platform: "ozon", stage: "submit", code: reason,
    family: control ? "control" : "legacy_skip" })
  return `${solution.reason}；${solution.steps.join("；")}`
}

export function offerIdFromView(view: WorkflowDraftView | undefined, imageName = ""): string {
  const value = view?.draft.values.offer_id
  if (value && value.kind === "text" && value.value.trim()) return value.value.trim()
  // Cloud injects the source stem at send (`inject_source_identity`). The grid
  // does not persist offer_id, so the preflight must use the same stem.
  const stem = imageName.replace(/\.[^.]+$/, "").trim()
  return stem
}

/**
 * Rows the selection cannot send yet: any row still inside a preparation verb,
 * or a running guided batch's planned rows (it re-renders them when their turn
 * comes). `undefined` selection is the queue's own continuation and answers for
 * every row the card lists.
 */
export function preparationBlockedRows(
  rows: readonly { id: string }[],
  selection: ReadonlySet<string> | undefined,
  activity: PreparationActivity,
  guided: GuidedPreparation,
): string[] {
  const targets = selection ? rows.filter((row) => selection.has(row.id)) : rows
  const planned = guided.active && guided.rowIds.length > 0 ? new Set(guided.rowIds) : undefined
  const plannedAll = guided.active && guided.rowIds.length === 0
  return targets
    .filter(
      (row) => rowPreparing(activity, row.id) || plannedAll || (planned?.has(row.id) ?? false),
    )
    .map((row) => row.id)
}

export type PublishRefusal = { ok: false; message: string; focusRowId?: string }

export type PublishPreflight =
  | { ok: true; draftIds: string[]; rows: ListingRow[] }
  | PublishRefusal

/** The Card's current target Stores — the list a send may choose from. */
export function publishStoreTargets(
  workbench: Pick<ListingWorkbenchRuntime, "cardId">,
): readonly string[] {
  const card = workbench.cardId ? peekCardSession(workbench.cardId)?.card() : undefined
  return card ? parseStoreIds(cardPayload(card).targetStoreId) : []
}

/** One row's send target: its Draft id, its current Store and its association. */
function publishCohort(workbench: Pick<ListingWorkbenchRuntime, "rows" | "productDrafts">) {
  return workbench.rows.map((row) => [
    row.draftId,
    workbench.productDrafts[row.draftId]?.target_store_id,
    // One design's specs share one Store; a per-card quota must not re-home
    // a spec to a second one.
    associatedImportedRow(workbench.productDrafts[row.draftId]?.draft, row.id) ? "association" : "",
  ] as const)
}

/**
 * Associated rows whose Store is no longer among this Card's targets. A send
 * must not silently move one spec of a design to another Store: the operator
 * re-assigns explicitly, and attempts that already left keep their Store.
 */
export function publishAssociationStoreConflicts(
  workbench: Pick<ListingWorkbenchRuntime, "cardId" | "rows" | "productDrafts">,
): string[] {
  return associationStoreConflicts(publishStoreTargets(workbench), publishCohort(workbench))
}

/** Preparation rows use current Card bindings; an existing send keeps its Store. */
export function publishStoreAssignments(workbench: Pick<ListingWorkbenchRuntime, "cardId" | "rows" | "productDrafts">): Map<string, string> {
  const cohort = publishCohort(workbench)
  const storeIds = publishStoreTargets(workbench)
  const targets = storeIds.length ? sendStoreAssignments(storeIds, cohort)
    : new Map(cohort.map(([id, store]) => [id, store ?? ""]))
  for (const [id, store] of cohort) {
    if (["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(workbench.productDrafts[id]?.lifecycle?.stage ?? "")) {
      targets.set(id, store ?? "")
    }
  }
  return targets
}

/**
 * What the tab alone can say about a send before any autosave flush or Cloud
 * request: whether the shell's cached account standing allows it (Cloud still
 * authenticates the submit itself), which Product Instances it covers, and
 * whether an unconfirmed AI candidate or a missing/duplicate offer ID already
 * rules it out. An explicit selection (even an empty one) answers for its own
 * rows only; `undefined` is the queue's continuation over `queueFrozenIds`,
 * kept in queue order but limited to Product Instances the table still lists:
 * a frozen id whose row is gone targets nothing.
 */
export function publishPreflight(
  workbench: Pick<ListingWorkbenchRuntime, "cardId" | "rows" | "productDrafts" | "queueFrozenIds">,
  selection: ReadonlySet<string> | undefined,
  account: { session: { authenticated: boolean } } | null,
): PublishPreflight {
  if (!account) return { ok: false, message: "账户状态尚未载入，请完成登录后再发送。" }
  if (composeBlockedBySignedOut(account)) return { ok: false, message: "尚未登录，请先登录后再发送。" }
  const listed = new Set(workbench.rows.map((row) => row.draftId))
  const draftIds = (selection
    ? workbench.rows.filter((row) => selection.has(row.id)).map((row) => row.draftId)
    : [...new Set(workbench.queueFrozenIds)].filter((id) => listed.has(id))
  ).filter(Boolean)
  if (!draftIds.length) return { ok: false, message: "没有可发送的商品。" }
  const wanted = new Set(draftIds)
  const rows = workbench.rows.filter((row) => wanted.has(row.draftId))
  const fenced = rows.find((row) => {
    const lifecycle = workbench.productDrafts[row.draftId]?.lifecycle
    return row.publishUnconfirmed === true || ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(row.stage ?? "")
      || ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(lifecycle?.stage ?? "")
      || row.readiness?.blockers.some((code) => code === "outcome_unknown" || code === "operator_attested")
  })
  if (fenced) return { ok: false, focusRowId: fenced.id,
    message: `图片 ${fenced.imageName} 已有在途、受理或未确认的发送；请核对原店铺 Intent，不要重复发送。` }
  const unresolved = rows.find((row) =>
    (row.candidates ?? []).some(
      (candidate) => candidate.state === "proposed" || candidate.state === "unresolved",
    ),
  )
  if (unresolved) {
    return {
      ok: false,
      message: `图片 ${unresolved.imageName} 仍有未确认的 AI 候选，队列未启动。`,
      focusRowId: unresolved.id,
    }
  }
  // The common Store of a same-design association, before any Seller call: a
  // spec that would be re-homed is refused here and re-assigned explicitly,
  // never quietly moved. Cloud re-checks the same rule on its own side.
  const movedSpecs = publishAssociationStoreConflicts(workbench).filter((id) => wanted.has(id))
  if (movedSpecs.length) {
    const moved = rows.find((row) => movedSpecs.includes(row.draftId))
    return {
      ok: false,
      focusRowId: moved?.id,
      message: `同源多规格导入的 ${movedSpecs.length} 行已不在本卡的目标店铺里；一个设计的规格必须使用同一店铺，请先显式重新指定目标店铺。`,
    }
  }
  const targets = publishStoreAssignments(workbench)
  const offers = new Set<string>()
  for (const row of rows) {
    const product = workbench.productDrafts[row.draftId]
    const offer = offerIdFromView(product, row.imageName)
    const key = JSON.stringify([targets.get(row.draftId), offer])
    if (!offer || offers.has(key)) {
      return { ok: false, message: `队列存在重复或缺失货号（${offer || row.imageName}），请先修正。` }
    }
    offers.add(key)
  }
  return { ok: true, draftIds, rows }
}
