import { notifyError, notifyInfo } from "@/lib/notify"
import { deleteProductInstances, type ProductInstanceDeleteResult } from "../product-instances"
import { peekListingWorkbench, patchListingWorkbench, receiveListingProducts } from "./listing-workbench-store"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { commandError } from "../workflow-shared"
import { refreshProductStatus } from "./product-status"
import { mapLimit } from "../source-batch"

/** Keep editable data until DELETE succeeds; only the table hides optimistically. */
export async function removeWorkbenchRows(ids: string[], saves: {
  flushRowsFor: (draftIds: string[]) => Promise<boolean>
  forgetRows: (draftIds: Iterable<string>) => void
}) {
  const before = peekListingWorkbench()
  const wanted = new Set(ids)
  const targets = before.rows.filter((row) => wanted.has(row.id))
  if (!targets.length) return
  const draftIds = targets.map((row) => row.draftId)
  patchListingWorkbench({
    pendingRemovalIds: new Set([...before.pendingRemovalIds, ...draftIds]),
    rows: before.rows,
    selectedIds: before.selectedIds.filter((id) => !wanted.has(id)),
    activeProductId: draftIds.includes(before.activeProductId ?? "") ? undefined : before.activeProductId,
  })
  notifyInfo(`已从表格移除 ${targets.length} 件商品，正在后台删除。`)

  let result: ProductInstanceDeleteResult
  try {
    await saves.flushRowsFor(draftIds)
    // Captured targets keep deletion running after leaving the table.
    result = await deleteProductInstances(targets, targets.map((row) => row.id))
  } catch (reason) {
    result = { deletedRowIds: [], deletedDraftIds: [], failures: targets.map((row) => ({ rowId: row.id, draftId: row.draftId, reason })) }
  }
  const deleted = new Set(result.deletedDraftIds)
  saves.forgetRows(deleted)
  receiveListingProducts([], deleted, peekListingWorkbench().scope)
  const refreshIds = new Set<string>()
  patchListingWorkbench((current) => {
    const pendingRemovalIds = new Set(current.pendingRemovalIds)
    for (const id of draftIds) pendingRemovalIds.delete(id)
    const failures = new Map(result.failures.map((failure) => [failure.rowId, failure.reason]))
    const restored = targets.flatMap((row) => {
      const product = current.productDrafts[row.draftId]
      if (!failures.has(row.id) || !product || current.removedProducts.has(row.draftId)) return []
      const changed = before.scope !== current.scope || product.lifecycle.view_revision !== before.productBases[row.draftId]?.lifecycle.view_revision
      if (changed) refreshIds.add(row.draftId)
      return [{ ...projectListingRowLifecycle({ ...row, readiness: changed ? undefined : row.readiness }, product.lifecycle),
        log: `删除失败：${commandError(failures.get(row.id), "请重试")}` }]
    })
    const order = new Map(before.rows.map((row, index) => [row.id, index]))
    const rows = [...current.rows, ...restored].sort((a, b) =>
      (current.productBases[a.draftId]?.lifecycle.queue_position ?? order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (current.productBases[b.draftId]?.lifecycle.queue_position ?? order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    return {
      pendingRemovalIds, rows,
      selectedIds: [...new Set([...current.selectedIds, ...restored.filter((row) =>
        before.scope === current.scope && before.selectedIds.includes(row.id)).map((row) => row.id)])],
      rowSaveStates: Object.fromEntries(Object.entries(current.rowSaveStates).filter(([id]) => !deleted.has(id))),
    }
  })
  if (result.failures.length) notifyError(`${result.failures.length} 件商品未能删除，请在原方案中重试：${commandError(result.failures[0]?.reason, "删除失败")}`)
  const current = peekListingWorkbench()
  await mapLimit(current.rows.filter((row) => refreshIds.has(row.draftId)), 3,
    (row) => refreshProductStatus(row, row.log, current.scope))
}
