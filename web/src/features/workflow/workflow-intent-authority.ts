import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { peekStoreRoster } from "@/features/stores/store-roster-cache"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import { readListingIntents, type ListingIntent } from "@/bindings/http-listing-intents"
import { listingScopeCurrent, listingWorkbenchScope, peekListingWorkbench } from "./workbench/listing-workbench-store"
import { refuse } from "@/bindings/refusal"
import { preparationRunning } from "./prepare/preparation-tracks"

/** Server-projected management permission and visible Store, never canResume or a role guess. */
export function captureWorkflowAccess(workspaceId: number | undefined, storeId: string): { current: () => boolean } | undefined {
  const account = peekAccountOverview()
  const actor = account?.accounts?.find((item) => item.active)?.uuid
  const workspace = account?.active_workspace
  const session = rowCacheScope()
  const allowed = () => {
    const now = peekAccountOverview()
    const stores = peekStoreRoster(workspaceId)?.overview.stores ?? []
    const store = stores.find((item) => item.id === storeId || item.cloud_store_uuid === storeId)
    return session.current() && !!actor && !!workspace && workspace.id === workspaceId
      && now?.session.authenticated === true && now.accounts?.find((item) => item.active)?.uuid === actor
      && now.active_workspace?.uuid === workspace.uuid && now.active_workspace?.id === workspaceId
      && store?.permissions?.manage_store === true && store.can_manage === true
  }
  return allowed() ? { current: allowed } : undefined
}

export type UnknownIntentInspection = { intents: readonly ListingIntent[]; message: string; current: () => boolean }
const UNKNOWN_AUTHORITY_MISSING = "已读回原店铺 Intent，但当前接口未提供 reconcile claim 与活动 Job 证据；保持锁定，请管理员核对，不能仅凭 unknown 状态释放或重发。"

/** E: one explicit latest-per-row GET, one Store, <=100 rows, no paging/retry. */
export async function inspectWorkflowIntents(workspaceId: number | undefined, ids: readonly string[], current: () => boolean): Promise<UnknownIntentInspection> {
  const scope = listingWorkbenchScope()
  const state = peekListingWorkbench()
  const rows = [...new Set(ids)].map((id) => state.rows.find((row) => row.id === id))
  const views = rows.map((row) => row && state.productBases[row.draftId])
  const storeId = views[0]?.target_store_id
  if (!rows.length || rows.length > 100 || !storeId || rows.some((row) => !row)
    || views.some((view) => !view || view.target_store_id !== storeId)) {
    throw refuse("workflow_intent_identity_missing", "请每次核对同一店铺最多 100 件现有商品，先确认商品身份和店铺归属")
  }
  const access = captureWorkflowAccess(workspaceId, storeId)
  const pins = rows.map((row, index) => ({ id: row!.id, draftId: row!.draftId, revision: views[index]!.lifecycle.revision, viewRevision: views[index]!.lifecycle.view_revision }))
  const stillCurrent = () => current() && listingScopeCurrent(scope) && access?.current() === true
    && peekListingWorkbench().mediaEpoch === state.mediaEpoch
    && !peekListingWorkbench().queueRunning && !peekListingWorkbench().queuePaused
    && !preparationRunning(peekListingWorkbench().activity) && !peekListingWorkbench().guidedPreparation.active
    && pins.every((pin) => {
      const now = peekListingWorkbench()
      const row = now.rows.find((item) => item.id === pin.id)
      const view = now.productBases[pin.draftId]
      return row?.draftId === pin.draftId && view?.target_store_id === storeId && view.lifecycle.revision === pin.revision
        && view.lifecycle.view_revision === pin.viewRevision
        && !["queued", "submitting", "accepted", "operator_attested"].includes(view.lifecycle.stage)
        && (view.lifecycle.stage === "outcome_unknown" || row.publishUnconfirmed === true)
        && !now.dirtyProducts[pin.draftId] && !now.pendingRemovalIds.has(pin.draftId) && !now.removedProducts.has(pin.draftId)
        && !["dirty", "saving", "error"].includes(now.rowSaveStates[pin.draftId] ?? "idle")
    })
  if (!stillCurrent()) throw refuse("workflow_intent_permission_missing", "当前账号没有原店铺管理权限，或商品状态已变化；请重新核对")
  const page = await readListingIntents(storeId, { rowIds: pins.map((pin) => pin.draftId) })
  if (!stillCurrent()) throw refuse("workflow_intent_authority_stale", "账号、店铺或商品已变化，本次核对结果已作废；保持锁定")
  if (page.next_cursor || page.items.length !== pins.length || pins.some((pin) => {
    const matches = page.items.filter((intent) => intent.listing_row_id === pin.draftId)
    const intent = matches[0]
    return matches.length !== 1 || !intent || intent.store_id !== storeId || intent.row_revision !== pin.revision
      || !intent.id || !intent.client_operation_id || intent.state !== "unknown"
  })) throw refuse("workflow_intent_identity_unproven", "未取得每行当前未确认操作的唯一证据；保持锁定，请核对原店铺记录")
  return { intents: page.items, current: stillCurrent,
    message: page.items.every(releaseReadFactsClear)
      ? "已核对原店铺的确切未确认 Intent，当前没有 reconcile claim 或活动 Job；请先核对卖家后台，再明确确认释放。释放不会发送。"
      : page.items.some((intent) => intent.has_live_reconcile_claim === true || intent.has_unfinished_dispatch_job === true)
        ? "原店铺 Intent 仍有活动 reconcile claim 或未完成派发 Job；保持锁定，请等待原操作结束后再明确核对，不释放或重新发送。"
      : UNKNOWN_AUTHORITY_MISSING }
}

/** Absent/null facts never mean false; only GET read evidence grants candidacy. */
export function releaseReadFactsClear(intent: ListingIntent): boolean {
  return intent.has_live_reconcile_claim === false && intent.has_unfinished_dispatch_job === false
}
