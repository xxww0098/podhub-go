import { useRef, useState, type RefObject } from "react"
import type { WorkflowProductStatusView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { listingWorkbenchScope, listingScopeCurrent, peekListingWorkbench } from "../workbench/listing-workbench-store"
import { preparationRunning, type PreparationTracks } from "../prepare/preparation-tracks"
import { commitProductStatus } from "../workbench/product-status"
import { brandRepairEligible, brandRepairIssueCurrent } from "../brand-repair"

export type BrandRepairCapability = {
  /** Account, row revision, current issue identity and Stop guard. */
  current: (row: ListingRow, revision: number) => boolean
  /** Native editRow using the schema's search-tag address and Manual provenance,
   * persist the edit, then native revalidate. This callback must never submit. */
  clearSearchTagsAndRevalidate: (row: ListingRow, revision: number) => Promise<BrandRepairResult>
}
/** The save owner certifies the exact old-to-saved transition, including SSE arriving first. */
export type BrandRepairResult = { status: WorkflowProductStatusView; current: () => boolean }
type UseRepairPublishInput = {
  busy: boolean
  preparationTracks: RefObject<PreparationTracks>
  flushAutosavesFor: (draftIds: readonly string[]) => Promise<boolean>
  capability?: BrandRepairCapability
}

/** A repair edits and saves. The publish queue sends those rows on the same click. */
export function useRepairPublish({ busy, preparationTracks, flushAutosavesFor, capability }: UseRepairPublishInput) {
  const [repairInFlight, setRepairInFlight] = useState(false)
  const lock = useRef(false)
  async function repairRows(rowIds: string[]): Promise<string[]> {
    if (lock.current) return []
    const scope = listingWorkbenchScope()
    const current = peekListingWorkbench()
    if (busy || current.queueRunning || current.queuePaused || preparationRunning(preparationTracks.current.snapshot())) {
      notifyError("队列或商品准备正在进行，请完成后再修复搜索标签。")
      return []
    }
    const targets = current.rows.filter((row) => rowIds.includes(row.id)
      && brandRepairEligible(row, current.productDrafts[row.draftId]?.lifecycle, row.readiness, preparationTracks.current.snapshot()))
    if (!targets.length) return []
    if (!capability) {
      notifyInfo("请在本行搜索标签中删除品牌词并保存，重新校验后明确发送；当前工作台未接入一键原生修复。")
      return []
    }
    const eligible = (row: ListingRow, revision: number) => {
      const state = peekListingWorkbench()
      const currentRow = state.rows.find((item) => item.id === row.id && item.draftId === row.draftId)
      const lifecycle = state.productDrafts[row.draftId]?.lifecycle
      return listingScopeCurrent(scope) && !state.queueRunning && !state.queuePaused
        && lifecycle?.revision === revision
        && brandRepairIssueCurrent(lifecycle, row.draftId, state.productDrafts[row.draftId]?.target_store_id)
        && !!currentRow && brandRepairEligible(currentRow, lifecycle, currentRow.readiness, preparationTracks.current.snapshot())
        && capability.current(row, revision)
    }
    const pins = targets.map((row) => ({ row, revision: current.productDrafts[row.draftId]!.lifecycle.revision }))
    if (!pins.every(({ row, revision }) => eligible(row, revision))) {
      notifyInfo("当前拒绝记录、权限或商品版本不允许一键修复；请核对后手动修改搜索标签。")
      return []
    }
    lock.current = true
    setRepairInFlight(true)
    const repairedIds: string[] = []
    try {
      if (!await flushAutosavesFor(targets.map((row) => row.draftId))) {
        notifyError("搜索标签修复前仍有字段未保存；请先完成保存再操作。")
        return []
      }
      for (const { row, revision } of pins) {
        if (!eligible(row, revision)) continue
        const result = await capability.clearSearchTagsAndRevalidate(row, revision)
        const { status } = result
        const latest = peekListingWorkbench()
        const target = latest.rows.find((item) => item.id === row.id && item.draftId === row.draftId)
        if (!listingScopeCurrent(scope) || !result.current() || !target || target.publishUnconfirmed
          || latest.queueRunning || latest.queuePaused || preparationRunning(preparationTracks.current.snapshot())
          || latest.dirtyProducts[row.draftId] || latest.pendingRemovalIds.has(row.draftId)
          || status.target_store_id !== current.productDrafts[row.draftId]?.target_store_id
          || status.lifecycle.revision <= revision) continue
        if (commitProductStatus(row.draftId, status, scope, "搜索标签已修复并重新校验；尚未发送")) repairedIds.push(row.id)
      }
      if (listingScopeCurrent(scope)) {
        if (repairedIds.length) notifySuccess(`已清空 ${repairedIds.length} 件商品的违规搜索标签并重新校验。`)
        else notifyInfo("商品状态已变化，未提交修复结果；请核对当前行与原 Intent。")
      }
    } catch (reason) {
      if (listingScopeCurrent(scope)) notifyCommandError(reason, "搜索标签修复或保存未完成；请核对本行字段与旧 Intent，不要重复发送。")
    } finally {
      lock.current = false
      setRepairInFlight(false)
    }
    return repairedIds
  }
  return { repairRows, repairInFlight, repairPending: () => lock.current }
}
