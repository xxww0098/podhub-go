import { useEffect, type RefObject } from "react"
import type { CategorySchemaView, WorkflowDraftView } from "@/bindings/commands"
import { workflowActions } from "./workflow-actions"
import { clearLive, notifyError, notifyCommandError, notifyInfo, notifyLive, notifySuccess } from "@/lib/notify"
import type { ListingRow } from "./model/listing-row"
import {
  listingWorkbenchScope,
  listingScopeCurrent,
  patchListingWorkbench,
  peekListingWorkbench,
} from "./workbench/listing-workbench-store"
import { createPreparationTracks, preparationRunning } from "./prepare/preparation-tracks"
import {
  attachCardSchema,
  createImportPaintScheduler,
  importSourcePaths,
  upsertImportedListingRow,
  type SourceImportItemOutcome,
  type SourceImportResult,
} from "./product-instances"
import { MAX_SOURCE_BATCH } from "./source-batch"
import {
  assignStoreIdByRowIndex,
  calculateSequentialStoreSlices,
  type StoreQuotaSlice,
} from "./store-quota"
import { commandCode } from "./workflow-shared"

/**
 * Importing a source image files a row and nothing else. AI requests, PSD
 * slicing and S3 upload all cost money and a render slot, so they start only
 * when the operator confirms with a batch verb of their own.
 */
const IMPORTED_AWAITING_CONFIRMATION = "已导入，等待确认后开始准备"
const LIVE_IMPORT = "live:import"

type UseSourceImportInput = {
  cardTemplateId: string | undefined
  schema: CategorySchemaView | undefined
  boundStoreIds: string[]
  customStoreQuotas: Record<string, number>
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  flushAutosave: () => Promise<boolean>
  setBusy: (busy: boolean) => void
}

/**
 * Import is the only gesture that creates rows, and it creates nothing else.
 * An empty `paths` list opens the browser source picker.
 */
export function useSourceImport({
  cardTemplateId,
  schema,
  boundStoreIds,
  customStoreQuotas,
  preparationTracks,
  flushAutosave,
  setBusy,
}: UseSourceImportInput) {
  useEffect(() => () => clearLive(LIVE_IMPORT), [])

  /**
   * New rows only: the gates run after every re-picked source is restored, so
   * restoring one never waits on the queue, a preparation, the row cap or an
   * autosave flush — and a batch with nothing new makes no request at all.
   */
  async function admitNewSources(count: number, scope: number): Promise<{ admitted: number, held: string }> {
    if (peekListingWorkbench().queuePaused || peekListingWorkbench().queueRunning) {
      return { admitted: 0, held: "队列运行或暂停期间不能导入新图片" }
    }
    // Import drains every pending row autosave first, and a running batch is
    // writing those same Drafts.
    if (preparationRunning(preparationTracks.current.snapshot())) {
      return { admitted: 0, held: "识别、切片或上传仍在进行，请完成后再导入新图片" }
    }
    const full = `一个上架方案最多 ${MAX_SOURCE_BATCH} 行，请先发送或删除已有商品`
    if (peekListingWorkbench().rows.length >= MAX_SOURCE_BATCH) return { admitted: 0, held: full }
    if (!(await flushAutosave())) {
      return { admitted: 0, held: "仍有字段没有保存到云端，请重试保存后再导入图片" }
    }
    if (!listingScopeCurrent(scope)) return { admitted: 0, held: "" }
    const remaining = Math.max(0, MAX_SOURCE_BATCH - peekListingWorkbench().rows.length)
    return { admitted: Math.min(count, remaining), held: count > remaining ? full : "" }
  }

  async function importSourceSelection(paths: string[]): Promise<boolean> {
    const scope = listingWorkbenchScope()
    if (!cardTemplateId || !schema) {
      notifyError("请先打开一个上架方案，再导入图片。")
      return false
    }
    setBusy(true)
    try {
      let pickerFailures: string[] = []
      let result: SourceImportResult
      let prefixDraftIds = new Set<string>()
      let storeSlices: StoreQuotaSlice[] = []
      let storeOffset = 0
      let heldReason = ""
      const queueByDraft = new Map<string, number>()
      const painted = new Set<string>()
      const progress = { settled: 0, total: 0 }
      let stopping = false
      const showImportLive = () => {
        notifyLive({
          id: LIVE_IMPORT,
          type: "loading",
          title: stopping ? "正在停止导入源图" : "正在导入源图",
          description: `${progress.settled}/${progress.total}${stopping ? " · 当前图片完成后停止" : ""}`,
          action: {
            label: stopping ? "停止中" : "停止导入",
            disabled: stopping,
            onClick: stopImport,
          },
        })
      }
      const stopImport = async () => {
        if (stopping) return
        stopping = true
        showImportLive()
        try {
          await workflowActions.workflowImportSourceAssetsStop()
        } catch (reason) {
          stopping = false
          showImportLive()
          notifyCommandError(reason, "无法停止导入，请稍后重试。")
        }
      }
      const cardSchema = schema
      const paintBatch = (batch: SourceImportItemOutcome[]) => {
        if (!listingScopeCurrent(scope)) return
        const productsToAdd: Record<string, WorkflowDraftView> = {}
        const rowsToAdd: ListingRow[] = []
        const selectedIds: string[] = []
        for (const mapped of batch) {
          progress.settled += 1
          if (!mapped.row || !mapped.product || painted.has(mapped.row.draftId)) continue
          painted.add(mapped.row.draftId)
          const product = attachCardSchema(mapped.product, cardSchema)
          const position = product.lifecycle.queue_position
          if (position != null) queueByDraft.set(mapped.row.draftId, position)
          productsToAdd[product.draft_id] = product
          rowsToAdd.push(mapped.row)
          selectedIds.push(mapped.row.id)
        }
        showImportLive()
        if (!rowsToAdd.length) return
        patchListingWorkbench((current) => {
          let rows = current.rows
          for (const row of rowsToAdd) {
            rows = upsertImportedListingRow(rows, prefixDraftIds, row, queueByDraft)
          }
          const selected = new Set(current.selectedIds)
          for (const id of selectedIds) selected.add(id)
          return {
            productDrafts: { ...current.productBases, ...productsToAdd },
            rows,
            selectedIds: [...selected],
          }
        })
      }
      const painter = createImportPaintScheduler(paintBatch)
      const picked = await workflowActions.workflowPickSourceAssets({
        paths,
        // A re-picked source takes no new row, so the pick is not capped by the
        // Card's remaining rows; `admitNewSources` caps the new files alone.
        selection_limit: MAX_SOURCE_BATCH,
      })
      if (!listingScopeCurrent(scope)) return false
      const validPickedPaths = picked.flatMap((entry) => (entry.error ? [] : [entry.path]))
      progress.total = validPickedPaths.length
      if (progress.total) {
        showImportLive()
      }
      result = await importSourcePaths({
        paths: validPickedPaths,
        cardTemplateId,
        importedLog: IMPORTED_AWAITING_CONFIRMATION,
        storeResolver: (batchIndex) => assignStoreIdByRowIndex(storeOffset + batchIndex, storeSlices),
        onItem: painter.push,
        admitNew: async (count) => {
          const { admitted, held } = await admitNewSources(count, scope)
          heldReason = held
          const rows = peekListingWorkbench().rows
          prefixDraftIds = new Set(rows.map((row) => row.draftId))
          storeOffset = rows.length
          storeSlices = calculateSequentialStoreSlices(storeOffset + admitted, boundStoreIds, customStoreQuotas)
          return admitted
        },
      })
      pickerFailures = picked.flatMap((entry) =>
        entry.error ? [`${entry.file_name}：${entry.error}`] : [],
      )
      painter.flush()
      if (!listingScopeCurrent(scope)) return false
      paintBatch(result.rows.flatMap((row) => {
        if (painted.has(row.draftId)) return []
        const product = result.products[row.draftId]
        return product ? [{ inputIndex: -1, row, product }] : []
      }))
      // Restored rows are told apart from new ones, and neither starts work.
      const recovery = [
        result.restoredRows ? `已恢复 ${result.restoredRows} 个商品的本地源图，未自动开始准备` : "",
        result.presentFiles ? `${result.presentFiles} 张图片的本地源图已在本方案中，未新增商品` : "",
      ].filter(Boolean).join("；")
      if (stopping || result.cancelled) {
        notifySuccess([
          result.rows.length
            ? `已停止导入，已保留 ${result.rows.length} 张源图`
            : "已停止导入，没有新增源图",
          recovery,
        ].filter(Boolean).join("；"))
      } else if (result.rows.length) {
        // Pre-ticked, so confirming is one click — but it is still a click. An
        // AI request and a render slot only ever start on the operator's word.
        notifySuccess([
          result.rows.length === 1
            ? `已导入 ${result.rows[0]!.imageName}，勾选后开始识别或切片`
            : `已导入 ${result.rows.length} 张源图，勾选后开始识别或切片`,
          recovery,
        ].filter(Boolean).join("；"))
      } else if (result.restoredRows) {
        notifySuccess(recovery)
      } else if (recovery) {
        notifyInfo(recovery)
      }
      if (result.heldFiles && heldReason) {
        notifyError(`${result.heldFiles} 张新图片未导入 · ${heldReason}`)
      }
      const failures = [...pickerFailures, ...result.failures]
      if (failures.length) {
        notifyError(`${failures.length} 张图片未导入 · ${failures[0]}`)
      }
      return result.rows.length > 0 || result.restoredRows > 0
    } catch (reason) {
      if (commandCode(reason) !== "workflow_asset_cancelled") {
        notifyCommandError(
          reason,
          "无法导入所选图片，请稍后重试。",
        )
      }
      return false
    } finally {
      clearLive(LIVE_IMPORT)
      setBusy(false)
    }
  }

  return { importSourceSelection }
}
