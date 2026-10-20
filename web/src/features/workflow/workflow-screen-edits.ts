import type { RefObject } from "react"
import type { FieldValueOriginKind, WorkflowDraftValue, SkuImportPreview, SkuImportCandidate, WorkflowClearGeneratedContentItemResult } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import { workflowActions } from "./workflow-actions"
import { writeWorkflowValue, isCategoryDraftBlank, applySkuImportCandidates, type WorkflowValueLocation } from "./workflow-draft"
import { notifyError, notifySuccess } from "@/lib/notify"
import { preparationRunning, rowPreparing } from "./prepare/preparation-tracks"
import { listingWorkbenchScope, listingScopeCurrent, peekListingWorkbench } from "./workbench/listing-workbench-store"
import { chunkItems, MUTATION_BATCH } from "./source-batch"
import { commitProductStatus } from "./workbench/product-status"
import { commandError } from "./workflow-shared"
import type { WorkflowScreenState } from "./workflow-screen-state"

export function useWorkflowScreenEdits({ state, pendingValueOriginRef, flushAutosave, flushRowsFor }: {
  state: WorkflowScreenState
  pendingValueOriginRef: RefObject<{ kind: FieldValueOriginKind; sourceRef?: string }>
  flushAutosave: () => Promise<boolean>
  flushRowsFor: (ids: readonly string[]) => Promise<boolean>
}) {
  const { supplierBound, preparationTracks, setDraft, setIssues, schema, runnerGeneration,
    targetStoreId, setSchema, draft, draftId, rowClearLock, setBusy } = state
  function updateValue(
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
    origin: FieldValueOriginKind = "manual",
  ) {
    if (supplierBound) return
    // Send reads card defaults per row. Recognition and slicing do not —
    // they write the instance, and inheritance waits for the next prepare or
    // send. Queue lock is the only fence that would split a cohort mid-dispatch.
    if (peekListingWorkbench().queueRunning) {
      notifyError("发送队列进行中不能修改类目字段。")
      return
    }
    if (origin !== "card_default" && preparationRunning(preparationTracks.current.snapshot())) {
      notifyError("商品准备期间不能修改类目字段。")
      return
    }
    pendingValueOriginRef.current = { kind: origin }
    setDraft((current) =>
      current ? writeWorkflowValue(current, fieldKey, value, location) : current,
    )
    setIssues([])
  }

  async function refreshCategorySchema() {
    if (!schema) throw new Error("当前上架方案没有类目坐标")
    const generation = runnerGeneration.current
    const next = await listingHttp.listingCardLoadCategorySchema({
      description_category_id: schema.description_category_id,
      type_id: schema.type_id,
      language: schema.language ?? "zh_hans",
      target_store_id: targetStoreId.split(",")[0]?.trim() || undefined,
    })
    if (generation === runnerGeneration.current) setSchema(next)
  }

  async function previewSkuImport(sku: string): Promise<SkuImportPreview> {
    if (!schema || !draft || !draftId) throw new Error("当前上架方案草稿尚未就绪")
    if (!isCategoryDraftBlank(schema, draft)) {
      throw new Error("只有类目字段全部空白的草稿才能从 SKU 导入")
    }
    if (!(await flushAutosave())) {
      throw new Error("请先完成当前草稿的保存")
    }
    return listingHttp.listingCardPreviewSkuImport({ draft_id: draftId, sku })
  }

  function applySkuImport(candidates: SkuImportCandidate[], sourceSku: number) {
    if (!schema || !draft || !isCategoryDraftBlank(schema, draft)) {
      notifyError("草稿已不再是空白状态，已取消 SKU 导入。")
      return
    }
    pendingValueOriginRef.current = {
      kind: "seller_sku",
      sourceRef: `sku:${sourceSku}`,
    }
    setDraft(applySkuImportCandidates(draft, candidates))
    setIssues([])
  }

  async function clearGeneratedRows(ids: string[]) {
    const scope = listingWorkbenchScope()
    if (rowClearLock.current) return
    if (peekListingWorkbench().queuePaused || peekListingWorkbench().queueRunning) {
      notifyError("队列运行或暂停期间不能清空生成内容。")
      return
    }
    const live = preparationTracks.current.snapshot()
    if (ids.some((id) => rowPreparing(live, id))) {
      notifyError("所选商品仍在识别、切片或上传，请完成后再清空。")
      return
    }

    rowClearLock.current = true
    setBusy(true)
    try {
      const wanted = new Set(ids)
      const targets = peekListingWorkbench().rows.filter((row) => wanted.has(row.id))
      if (!targets.length) return
      if (!(await flushRowsFor(targets.map((target) => target.draftId)))) {
        notifyError("有逐行修改尚未保存，已取消清空。请先重试保存。")
        return
      }

      const results: WorkflowClearGeneratedContentItemResult[] = []
      for (const slice of chunkItems(targets, MUTATION_BATCH)) {
        results.push(
          ...(await workflowActions.workflowClearGeneratedContent({
            draft_ids: slice.map((target) => target.draftId),
          })),
        )
      }
      if (!listingScopeCurrent(scope)) return
      const successful = results.filter(
        (result) => result.row && result.status && !result.error,
      )
      const byDraftId = new Map(
        successful.map((result) => [
          result.draft_id,
          { row: result.row!, status: result.status! },
        ]),
      )
      if (byDraftId.size) {
        for (const [draftId, result] of byDraftId) {
          commitProductStatus(draftId, result.status, scope, "生成内容已清空，可重新识别和切片")
        }
        notifySuccess(`已清空 ${byDraftId.size} 件商品的生成内容`)
      }
      const failed = results.filter((result) => result.error || !result.row)
      if (failed.length) {
        notifyError(
          `${failed.length} 件商品未能清空：${commandError(
            failed[0]?.error,
            "请稍后重试",
          )}`,
        )
      }
    } finally {
      rowClearLock.current = false
      setBusy(false)
    }
  }

  return { updateValue, refreshCategorySchema, previewSkuImport, applySkuImport, clearGeneratedRows }
}
