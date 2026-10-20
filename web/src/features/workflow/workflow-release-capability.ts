import { cachedListingRow, readListingRowFresh } from "@/bindings/listing-row-cache"
import type { ListingRowView } from "@/bindings/listing-projection"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { refuse } from "@/bindings/refusal"
import type { CardSession } from "./card/card-session"
import { sameIntent } from "./model/publish-actions"
import { rowStatusView } from "./model/row-state"
import { preparationRunning } from "./prepare/preparation-tracks"
import type { UnknownReleaseCapability, UnknownReleaseTarget } from "./submit/use-unknown-release"
import { captureWorkflowAccess, inspectWorkflowIntents, releaseReadFactsClear } from "./workflow-intent-authority"
import type { WorkflowPublishContext } from "./workflow-publish-capabilities"
import type { WorkflowPublishNative } from "./workflow-publish-native"
import { listingScopeCurrent, listingWorkbenchScope, peekListingWorkbench, subscribeListingWorkbench } from "./workbench/listing-workbench-store"

/** One mounted screen's explicit inspection, bounded to one Store / 100 rows.
 * These pins are revocable read evidence, never a second queue or send budget. */
export function createWorkflowReleaseCapability(context: () => WorkflowPublishContext, native: WorkflowPublishNative,
  residentSession?: (cardId: string) => CardSession | undefined) {
  type Pin = { target: UnknownReleaseTarget; current: () => boolean; available: () => boolean; begin: () => boolean;
    accept: (receipt: ListingIntent) => boolean; validate: (after: ListingIntent) => ReturnType<UnknownReleaseCapability["revalidate"]> }
  let pins = new Map<string, Pin>()
  let generation = 0
  let unsubscribe: (() => void) | undefined
  const dispose = () => { generation++; pins.clear(); unsubscribe?.(); unsubscribe = undefined }
  const stale = () => refuse("workflow_release_stale", "原 Intent、商品、方案或权限已变化；保持锁定，请重新核对")

  const capability: UnknownReleaseCapability = {
    capture(rowId) {
      const pin = pins.get(rowId)
      return pin?.available() ? structuredClone(pin.target) : undefined
    },
    current(target) {
      const pin = [...pins.values()].find((pin) => sameIntent(pin.target.intent, target.intent))
      return !!pin && pin.current()
    },
    beginRelease(target) {
      const pin = [...pins.values()].find((pin) => sameIntent(pin.target.intent, target.intent))
      return !!pin && pin.begin()
    },
    acceptRelease(target, receipt) {
      const pin = [...pins.values()].find((pin) => sameIntent(pin.target.intent, target.intent))
      return !!pin && pin.accept(receipt)
    },
    async revalidate(target, after) {
      const pin = [...pins.values()].find((pin) => sameIntent(pin.target.intent, target.intent))
      if (!pin || !pin.current()) throw stale()
      return pin.validate(after)
    },
  }

  async function inspect(ids: readonly string[]) {
    dispose()
    const attempt = ++generation
    const screen = { ...context() }, scope = listingWorkbenchScope(), state = peekListingWorkbench()
    const selected = [...new Set(ids)]
    const raws = selected.map((id) => {
      const row = state.rows.find((row) => row.id === id)
      return row && cachedListingRow(row.draftId)
    })
    const baseCurrent = () => {
      const now = context(), workbench = peekListingWorkbench()
      return generation === attempt && listingScopeCurrent(scope) && now.active && !now.blocked
        && now.workspaceId === screen.workspaceId && now.cardId === screen.cardId
        && now.generation === screen.generation && now.controlVersion === screen.controlVersion
        && workbench.cardId === screen.cardId && workbench.mediaEpoch === state.mediaEpoch
        && !workbench.queueRunning && !workbench.queuePaused && !workbench.guidedPreparation.active
        && !preparationRunning(workbench.activity)
    }
    if (!baseCurrent() || !screen.cardId || !selected.length || selected.length > 100
      || raws.some((raw) => !raw || raw.card_id !== screen.cardId)) throw stale()
    const cardId = screen.cardId
    // openCardSession can GET after a reload. Release may only use an existing
    // session, never implicitly hydrate a Card or category. A missing resident
    // accessor or unresolved session leaves inspection manual.
    const session = residentSession?.(cardId)
    const card = session?.card()
    const inspection = await inspectWorkflowIntents(screen.workspaceId, selected,
      () => baseCurrent() && (!session || (residentSession?.(cardId) === session && session.card() === card))
        && raws.every((raw) => raw && cachedListingRow(raw.id) === raw))
    if (!inspection.current()) throw stale()
    if (!session || !card || session.cardId !== screen.cardId || card.id !== screen.cardId) return {
      ...inspection, message: inspection.intents.every(releaseReadFactsClear)
        ? "确切 Intent 已核对，但本页缺少当前驻留 Card 的只读能力；保持锁定，请管理员核对，不释放或重新发送。"
        : inspection.message,
    }
    const next = new Map<string, Pin>()
    for (let index = 0; index < selected.length; index++) {
      const id = selected[index]!, raw = raws[index]!
      const intent = inspection.intents.find((item) => item.listing_row_id === raw.id)
      const view = state.productBases[raw.id]
      const access = captureWorkflowAccess(screen.workspaceId, raw.store_id ?? "")
      if (!intent || !view || !access || !releaseReadFactsClear(intent) || raw.revision !== intent.row_revision
        || raw.store_id !== intent.store_id || raw.view_revision !== view.lifecycle.view_revision) continue
      const target: UnknownReleaseTarget = { platform: "ozon", intent: structuredClone(intent),
        canManage: true, storeVisible: true, claimActive: false, jobsActive: false }
      let receipt: ListingIntent | undefined, fresh: ListingRowView | undefined, revoked = false, pending = false
      const payload = JSON.stringify(raw.payload)
      const unchangedRow = (candidate: ListingRowView) => candidate.id === raw.id && candidate.card_id === raw.card_id
        && candidate.store_id === raw.store_id && candidate.revision === raw.revision
        && JSON.stringify(candidate.payload) === payload
      const current = () => {
        const now = peekListingWorkbench(), row = now.rows.find((row) => row.id === id), product = now.productBases[raw.id]
        const resident = cachedListingRow(raw.id)
        const original = product?.lifecycle.view_revision === raw.view_revision
          && (product.lifecycle.stage === "outcome_unknown" || row?.publishUnconfirmed === true)
        // Release changes submission_state only: same content revision, exactly
        // one view revision. An unrelated write / later SSE cannot piggyback.
        const transitioned = pending && product?.lifecycle.view_revision === raw.view_revision + 1
          && product.lifecycle.stage === "ready_to_publish" && product.lifecycle.fields === "valid"
        const valid = baseCurrent() && access.current() && residentSession?.(cardId) === session && session.card() === card
          && row?.draftId === raw.id && product?.target_store_id === raw.store_id
          && product.lifecycle.revision === raw.revision && (original || transitioned)
          && !["queued", "submitting", "accepted", "operator_attested"].includes(product.lifecycle.stage)
          && !now.dirtyProducts[raw.id] && !now.pendingRemovalIds.has(raw.id) && !now.removedProducts.has(raw.id)
          && !["dirty", "saving", "error"].includes(now.rowSaveStates[raw.id] ?? "idle")
          && !!resident && (fresh ? resident === fresh : resident === raw || (pending
            && resident.view_revision === raw.view_revision + 1 && unchangedRow(resident)))
        if (!valid) revoked = true
        return !revoked
      }
      next.set(id, { target, current, available: () => !pending && current(),
        begin() { if (pending || !current()) return false; pending = true; return true },
        accept(value) {
          if (!pending || receipt || !sameIntent(intent, value) || value.state !== "superseded" || value.updated_at_ms < intent.updated_at_ms) return false
          receipt = value
          return current()
        },
        async validate(after) {
          if (!receipt || !current() || !sameIntent(receipt, after) || after.state !== "superseded"
            || after.updated_at_ms !== receipt.updated_at_ms || !releaseReadFactsClear(after)) throw stale()
          const loaded = await readListingRowFresh(raw.id)
          if (!unchangedRow(loaded) || loaded.view_revision !== raw.view_revision + 1) throw stale()
          // An equal-version SSE keeps its cached object when the GET arrives.
          // Prove that all its facts agree with the fresh HTTP reply, then pin
          // that resident object so any later write still revokes this action.
          const resident = cachedListingRow(raw.id)
          if (!resident || JSON.stringify(resident) !== JSON.stringify(loaded)) throw stale()
          fresh = resident
          if (!current()) throw stale()
          const status = rowStatusView(loaded)
          if (status.lifecycle.stage !== "ready_to_publish" || status.lifecycle.fields !== "valid"
            || !status.readiness.ready_to_publish || !status.readiness.can_start_publish_attempt
            || !status.readiness.allowed_actions.includes("publish")) throw stale()
          await native.revalidate(loaded, card, current)
          if (!current()) throw stale()
          return status
        },
      })
    }
    pins = next
    // Observe transient dirty / queue / removal / SSE changes too, even if a
    // later render returns to the old values before the next async boundary.
    if (pins.size) unsubscribe = subscribeListingWorkbench(() => { for (const pin of pins.values()) pin.current() })
    return inspection
  }
  return { capability, inspect, dispose }
}
