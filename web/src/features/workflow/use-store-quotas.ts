import { useCallback, useMemo, useState, type RefObject } from "react"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { lifecycleSealed } from "./model/listing-row-lifecycle"
import { isProductEditConflict } from "./model/product-edit"
import { commitProductStatus } from "./workbench/product-status"
import {
  listingWorkbenchScope,
  listingScopeCurrent,
  peekListingWorkbench,
  projectListingProducts,
} from "./workbench/listing-workbench-store"
import { createPreparationTracks, preparationRunning } from "./prepare/preparation-tracks"
import { persistProductDraft as saveProductDraft } from "./product-instances"
import {
  adjustStoreQuota,
  assignStoreIdByRowIndex,
  calculateEvenStoreQuotas,
  calculateSequentialStoreSlices,
  countStoreQuotas,
  parseStoreIds,
} from "./store-quota"
import { mapLimit } from "./source-batch"

type UseStoreQuotasInput = {
  targetStoreId: string
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  guidedPreparationLock: RefObject<boolean>
}

/** Per-store row quotas for a multi-store card, persisted onto each instance. */
export function useStoreQuotas({
  targetStoreId,
  preparationTracks,
  guidedPreparationLock,
}: UseStoreQuotasInput) {
  const boundStoreIds = useMemo(() => parseStoreIds(targetStoreId), [targetStoreId])
  const [customStoreQuotas, setCustomStoreQuotas] = useState<Record<string, number>>({})

  const persistStoreQuotaAssignments = useCallback(
    async (nextQuotas: Record<string, number>) => {
      const scope = listingWorkbenchScope()
      const visibleRows = peekListingWorkbench().rows
      const productDrafts = peekListingWorkbench().productBases
      const nextSlices = calculateSequentialStoreSlices(
        visibleRows.length,
        boundStoreIds,
        nextQuotas,
      )
      const changes = visibleRows.flatMap((row, index) => {
        const assignedStore = assignStoreIdByRowIndex(index, nextSlices)
        const existingProduct = productDrafts[row.draftId]
        return existingProduct && existingProduct.target_store_id !== assignedStore
          ? [{ row, baseline: existingProduct, updated: { ...existingProduct, target_store_id: assignedStore } }]
          : []
      })
      const sealedConflict = changes.find(({ updated }) =>
        lifecycleSealed(updated.lifecycle),
      )
      if (sealedConflict) {
        notifyError(
          `已上架商品 ${sealedConflict.row.imageName} 的店铺已锁定，请保留其当前分配。`,
        )
        return
      }

      const settled = await mapLimit(changes, 4, async ({ updated, baseline }) => {
        try {
          return { status: "fulfilled" as const, value: await saveProductDraft(updated, baseline) }
        } catch (reason) {
          return { status: "rejected" as const, reason }
        }
      })
      if (!listingScopeCurrent(scope)) return
      // A field conflict carries the row just read by the CAS command. Show that
      // actual assignment before asking the operator to choose their quotas again.
      const observed = settled.flatMap((result) => result.status === "fulfilled"
        ? [result.value]
        : isProductEditConflict(result.reason) && result.reason.current ? [result.reason.current] : [],
      )
      if (observed.length) {
        projectListingProducts((current) => ({
          ...current,
          ...Object.fromEntries(observed.map(({ saved }) => [saved.draft_id, saved])),
        }), scope)
        for (const { saved, status } of observed) commitProductStatus(saved.draft_id, status, scope)
      }
      setCustomStoreQuotas(
        countStoreQuotas(
          visibleRows.map((row) =>
            peekListingWorkbench().productDrafts[row.draftId]?.target_store_id,
          ),
          boundStoreIds,
        ),
      )
      const rejected = settled.filter((result) => result.status === "rejected")
      if (rejected.length) {
        if (rejected.every((result) => isProductEditConflict(result.reason))) {
          notifyError(`${rejected.length} 件商品的店铺分配发生冲突；已显示当前实际分配，请核对后重新调整额度。`)
        } else {
          notifyCommandError(rejected[0]!.reason, `${rejected.length} 件商品未能确认店铺变更；请刷新上架方案后重试。`)
        }
      }
    },
    [boundStoreIds],
  )

  const handleQuotaChange = useCallback(
    (storeId: string, newQuota: number) => {
      if (preparationRunning(preparationTracks.current.snapshot())) {
        notifyError("识别、切片或上传期间不能修改店铺额度。")
        return
      }
      return persistStoreQuotaAssignments(
        adjustStoreQuota(
          customStoreQuotas,
          storeId,
          newQuota,
          peekListingWorkbench().rows.length,
          boundStoreIds,
        ),
      )
    },
    [customStoreQuotas, boundStoreIds, persistStoreQuotaAssignments],
  )

  const handleEvenSplitQuotas = useCallback(() => {
    if (
      guidedPreparationLock.current ||
      preparationRunning(preparationTracks.current.snapshot())
    ) {
      notifyError("识别、切片或上传期间不能修改店铺额度。")
      return
    }
    return persistStoreQuotaAssignments(
      calculateEvenStoreQuotas(peekListingWorkbench().rows.length, boundStoreIds),
    )
  }, [boundStoreIds, persistStoreQuotaAssignments])

  return {
    boundStoreIds,
    customStoreQuotas,
    setCustomStoreQuotas,
    handleQuotaChange,
    handleEvenSplitQuotas,
  }
}
