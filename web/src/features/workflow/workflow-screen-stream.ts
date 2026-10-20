import type { Dispatch, SetStateAction } from "react"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import { renderOpfs } from "@/bindings/render-opfs"
import { listingRowDraftView } from "./workflow-actions"
import { connectListingCardStream } from "./listing-card-stream"
import { countStoreQuotas, parseStoreIds } from "./store-quota"
import { listingWorkbenchScope, listingScopeCurrent, patchListingWorkbench, peekListingWorkbench, projectListingRows, receiveListingProducts, resetListingWorkbench } from "./workbench/listing-workbench-store"
import { replaceAddress } from "@/lib/address"
import { clearLive, notifyCommandError, notifyError } from "@/lib/notify"
import { writeWorkflowCardId } from "./workflow-navigation"
import { TEMPLATE_NOTICE_ID, type WorkflowScreenState } from "./workflow-screen-state"

export function useWorkflowScreenStream({ state, forgetRows, resetRowAutosaves, setCustomStoreQuotas }: {
  state: WorkflowScreenState
  forgetRows: (ids: Iterable<string>) => void
  resetRowAutosaves: () => void
  setCustomStoreQuotas: Dispatch<SetStateAction<Record<string, number>>>
}) {
  const { runnerGeneration, stopCardStream, setStreamHealthy, setMode } = state
  function restoreProductInstances(card: WorkflowDraftView, generation: number) {
    const scope = listingWorkbenchScope()
    let snapshotMembers = new Set<string>()
    const hydratedSources = new Map<string, string | undefined>()
    // Card-level invalidations re-read the authoritative
    // rows: a template change does not bump row view_revision, so no local
    // comparison can tell a pre-change row from a post-change one.
    const mediaRefetchEpoch = { current: 0 }
    async function refetchRowsAfterInvalidation() {
      const epoch = ++mediaRefetchEpoch.current
      // Mark the invalidation applied before anything else: save requests
      // issued from here on settle normally, ones issued earlier are dropped
      // by `settleListingProductEdit`.
      patchListingWorkbench((current) => ({ mediaEpoch: current.mediaEpoch + 1 }), scope)
      for (let attempt = 0; ; attempt += 1) {
        try {
          const snapshot = await api.get<{ rows: ListingRowView[] }>(
            route("listingCardsByIdSnapshot", { id: card.draft_id }),
          )
          if (generation !== runnerGeneration.current || !listingScopeCurrent(scope) || epoch !== mediaRefetchEpoch.current) return
          apply(snapshot.rows)
          return
        } catch (reason) {
          if (epoch !== mediaRefetchEpoch.current || generation !== runnerGeneration.current || !listingScopeCurrent(scope)) return
          if (attempt > 0) {
            notifyCommandError(reason, "商品媒体状态未能刷新，将在下次卡片更新时重试。")
            return
          }
          await new Promise((done) => setTimeout(done, 3000))
        }
      }
    }
    function apply(rows: ListingRowView[], removed = new Set<string>()) {
      if (generation !== runnerGeneration.current || !listingScopeCurrent(scope)) return
      const instances = rows.map((row) => ({ product: listingRowDraftView(row, card), readiness: row.projection.readiness }))
      receiveListingProducts(instances, removed, scope)
      forgetRows(removed)
      for (const id of removed) hydratedSources.delete(id)
      const current = peekListingWorkbench()
      setCustomStoreQuotas(countStoreQuotas(Object.values(current.productBases).map((product) => product.target_store_id), parseStoreIds(card.target_store_id)))
      const sources = instances.filter(({ product }) => current.productBases[product.draft_id]?.lifecycle.view_revision === product.lifecycle.view_revision &&
        (!hydratedSources.has(product.draft_id) || hydratedSources.get(product.draft_id) !== product.lifecycle.source_asset_handle))
        .map(({ product }) => {
          const handle = product.lifecycle.source_asset_handle
          hydratedSources.set(product.draft_id, handle)
          return { draft_id: product.draft_id, handle: handle ?? "" }
        })
      if (!sources.length) return
      void renderOpfs.workflowRestoreProductInstances(sources).then((restored) => {
        if (generation !== runnerGeneration.current || !listingScopeCurrent(scope)) return
        const byId = new Map(restored.map((item) => [item.draft_id, item]))
        const requested = new Map(sources.map((item) => [item.draft_id, item.handle]))
        projectListingRows((current) => current.map((row) => {
          const hit = byId.get(row.draftId)
          const base = peekListingWorkbench().productBases[row.draftId]
          if (!hit || !base || (base.lifecycle.source_asset_handle ?? "") !== requested.get(row.draftId)) return row
          // A miss read before a re-import restored this same handle must not clear it.
          if (!hit.source && row.source?.handle === requested.get(row.draftId)) return row
          return { ...row, source: hit.source, log: hit.source
            ? `已恢复 · ${base.lifecycle.stage}`
            : "本地源图不可用；已上传媒体仍可发送，重新识别或切片需重新导入" }
        }), scope)
      }).catch((reason) => {
        for (const source of sources) hydratedSources.delete(source.draft_id)
        if (listingScopeCurrent(scope)) notifyCommandError(reason, "无法恢复本地源图")
      })
    }
    stopCardStream.current = connectListingCardStream(card.draft_id, {
      snapshotStarting: () => {
        setStreamHealthy(false)
        snapshotMembers = new Set(Object.keys(peekListingWorkbench().productBases))
      },
      snapshot: (snapshot) => {
        const present = new Set(snapshot.rows.map((row) => row.id))
        // A row created by HTTP after this snapshot started is kept until its
        // ordered event arrives. An older snapshot cannot tombstone that row.
        apply(snapshot.rows, new Set([...snapshotMembers].filter((id) => !present.has(id))))
      },
      upsertBatch: (rows, removed) => apply(rows, new Set(removed)),
      invalidate: () => { void refetchRowsAfterInvalidation() },
      permissionLost: () => {
        if (generation !== runnerGeneration.current) return
        runnerGeneration.current++
        clearLive(TEMPLATE_NOTICE_ID)
        resetListingWorkbench()
        resetRowAutosaves()
        setMode("library")
        replaceAddress(writeWorkflowCardId(window.location.href))
        notifyError("上架方案已不可访问，请重新选择。")
      },
      error: (reason) => { if (listingScopeCurrent(scope)) notifyCommandError(reason, "卡片更新中断，正在恢复") },
      health: (healthy) => { if (generation === runnerGeneration.current) setStreamHealthy(healthy) },
    })
  }

  return { restoreProductInstances }
}
