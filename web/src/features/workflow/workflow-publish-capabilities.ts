import { cachedListingRow, readListingRowFresh } from "@/bindings/listing-row-cache"
import { patchListingRow } from "@/bindings/http-listing"
import { cachedMaterial } from "@/bindings/listing-material-cache"
import { refuse } from "@/bindings/refusal"
import { openCardSession, type CardSession } from "./card/card-session"
import { brandRepairEligible, brandRepairIssueCurrent } from "./brand-repair"
import { nativeRow } from "./submit/send-local"
import { rowStatusView } from "./model/row-state"
import type { ListingRow } from "./model/listing-row"
import type { BrandRepairCapability } from "./submit/use-repair-publish"
import { preparationRunning } from "./prepare/preparation-tracks"
import { listingScopeCurrent, listingWorkbenchScope, peekListingWorkbench } from "./workbench/listing-workbench-store"
import { captureWorkflowAccess } from "./workflow-intent-authority"
import { createWorkflowReleaseCapability } from "./workflow-release-capability"
import { createWorkflowPublishNative, type WorkflowPublishNative } from "./workflow-publish-native"

export type WorkflowPublishContext = {
  workspaceId?: number
  cardId?: string
  generation: number
  controlVersion: number
  active: boolean
  blocked: boolean
}

/** Current Cloud workbench wiring. It neither creates a queue nor submits a row. */
export function createWorkflowPublishCapabilities(context: () => WorkflowPublishContext, native: WorkflowPublishNative = createWorkflowPublishNative(),
  residentSession?: (cardId: string) => CardSession | undefined) {
  let disposed = false
  function capture(row: ListingRow, revision: number) {
    if (disposed) return undefined
    const screen = { ...context() }
    const state = peekListingWorkbench()
    const raw = cachedListingRow(row.draftId)
    const view = state.productBases[row.draftId]
    const access = view && captureWorkflowAccess(screen.workspaceId, view.target_store_id)
    const scope = listingWorkbenchScope()
    if (!raw || !view || !access || !screen.cardId || raw.card_id !== screen.cardId
      || raw.id !== row.draftId || raw.store_id !== view.target_store_id || raw.revision !== revision
      || raw.view_revision !== view.lifecycle.view_revision || view.lifecycle.revision !== revision) return undefined
    const parsed = nativeRow(raw)
    if ("refusal" in parsed) return undefined
    const payload = parsed.row
    const material = cachedMaterial({ descriptionCategoryId: payload.descriptionCategoryId, typeId: payload.typeId, language: payload.language })
    if (!material || material.input.snapshot.schema_revision !== payload.schemaRevision) return undefined
    const current = (saved?: { revision: number; view_revision: number }) => {
      if (disposed) return false
      const now = context()
      const stateNow = peekListingWorkbench()
      const target = stateNow.rows.find((item) => item.id === row.id && item.draftId === row.draftId)
      const product = stateNow.productBases[row.draftId]
      const resident = cachedListingRow(row.draftId)
      const version = product?.lifecycle
      const original = version?.revision === revision && version.view_revision === raw.view_revision
      const transitioned = saved && version?.revision === saved.revision && version.view_revision === saved.view_revision
      return listingScopeCurrent(scope) && access.current() && now.active && !now.blocked
        && now.workspaceId === screen.workspaceId && now.cardId === screen.cardId && now.generation === screen.generation && now.controlVersion === screen.controlVersion
        && stateNow.mediaEpoch === state.mediaEpoch && !stateNow.queueRunning && !stateNow.queuePaused
        && !preparationRunning(stateNow.activity) && !!target && !target.publishUnconfirmed
        && !stateNow.dirtyProducts[row.draftId] && !stateNow.pendingRemovalIds.has(row.draftId)
        && !["dirty", "saving", "error"].includes(stateNow.rowSaveStates[row.draftId] ?? "idle")
        && product?.target_store_id === raw.store_id && !!(original || transitioned)
        && resident?.card_id === raw.card_id && resident.store_id === raw.store_id
        && resident.revision === (saved?.revision ?? revision) && resident.view_revision === (saved?.view_revision ?? raw.view_revision)
        && (saved ? !["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(version!.stage)
          : brandRepairIssueCurrent(version, row.draftId, raw.store_id ?? undefined)
            && brandRepairEligible(target, version, target.readiness, stateNow.activity))
    }
    return current() ? { raw, current } : undefined
  }
  const brandRepair: BrandRepairCapability = {
    current: (row, revision) => {
      // Availability is rendered synchronously; malformed resident coordinates
      // must keep the action hidden, not throw through the workbench render.
      try { return !!capture(row, revision) } catch { return false }
    },
    async clearSearchTagsAndRevalidate(row, revision) {
      const pin = capture(row, revision)
      const stale = () => refuse("workflow_repair_stale", "商品、方案、权限或保存版本已变化；修复已停止，请核对当前商品与原 Intent")
      if (!pin) throw stale()
      const session = await openCardSession(pin.raw.card_id)
      if (!pin.current()) throw stale()
      const card = session.card()
      const current = () => pin.current() && session.card() === card
      const edited = await native.clearSearchTags(pin.raw, card, current)
      if (!current()) throw stale()
      // Preserve the native cleared set. The generic editor merge only carries
      // changed values and would otherwise resurrect inherited search tags.
      const saved = await patchListingRow(row.draftId, { baseRevision: revision, draft: edited.row.draft }, async () => {
        // This existing save binding asks its resolver only on schema-sync refusal.
        // A repair cannot replay after an unguarded metadata wait (or Stop).
        // Keep the one CAS write; the next refresh/repair must be explicit.
        if (!current()) throw stale()
        throw refuse("workflow_repair_schema_refresh", "服务端类目版本需要刷新；请从类目入口刷新后重新点击修复，本次未重试保存")
      })
      if (saved.id !== pin.raw.id || saved.card_id !== pin.raw.card_id || saved.store_id !== pin.raw.store_id
        || saved.revision !== revision + 1 || saved.view_revision <= pin.raw.view_revision
        || !pin.current(saved) || session.card() !== card) throw stale()
      const fresh = await readListingRowFresh(row.draftId)
      const savedCurrent = () => pin.current(saved) && session.card() === card
      if (!savedCurrent() || fresh.id !== saved.id || fresh.card_id !== saved.card_id || fresh.store_id !== saved.store_id
        || fresh.revision !== saved.revision || fresh.view_revision !== saved.view_revision) throw stale()
      const validated = await native.revalidate(fresh, card, savedCurrent)
      if (!savedCurrent() || JSON.stringify(validated.row.draft) !== JSON.stringify(edited.row.draft)
        || edited.row.handEditedKeys.some((key) => !validated.row.handEditedKeys.includes(key))) throw stale()
      const status = rowStatusView(fresh)
      if (["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(status.lifecycle.stage)
        || status.lifecycle.fields !== "valid" || !status.readiness.can_start_publish_attempt
        || !status.readiness.allowed_actions.includes("publish")) {
        throw refuse("workflow_repair_not_ready", "搜索标签已保存，但当前服务端商品仍不允许发送；请查看本行校验与原 Intent 状态")
      }
      return { status, current: savedCurrent }
    },
  }
  const release = createWorkflowReleaseCapability(context, native, residentSession)
  const dispose = () => {
    if (disposed) return
    // Returning to a valid scope cannot revive this owner or its async pins.
    disposed = true
    release.dispose()
  }
  return { brandRepair, unknownRelease: release.capability, inspectUnknownRows: release.inspect, dispose }
}
