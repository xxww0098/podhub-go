import type { Dispatch, RefObject, SetStateAction } from "react"
import type { ListingCardSummary, WorkflowDraftView } from "@/bindings/commands"
import { cardCategorySchema, cardDraftView, cardQueueRunning, queueStateView, readListingCard } from "@/bindings/http-listing"
import { cardPayload } from "@/bindings/listing-projection"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import { renderOpfs } from "@/bindings/render-opfs"
import { refuse } from "@/bindings/refusal"
import { closeCardSession, openCardSession, peekCardSession, primeCardSession } from "./card/card-session"
import { loadStoreRoster, forgetStoreRoster } from "@/features/stores/store-roster-cache"
import { loadListingCardList } from "./listing-card-list-cache"
import { setCardContext } from "./prepare/execution-context"
import { preparationTracksForCard } from "./prepare/preparation-tracks"
import { patchListingWorkbench, resetListingWorkbench } from "./workbench/listing-workbench-store"
import { DEFAULT_AI_PROMPT, cardSummaryFromDraft, savedFormTitle, upsertSavedForm } from "./workflow-shared"
import { resolveRunnerEntry } from "./product-instances"
import { humanValidationMessage } from "./workflow-draft"
import { replaceAddress } from "@/lib/address"
import { writeWorkflowCardId } from "./workflow-navigation"
import { clearLive, notifyCommandError, notifyError, notifyLive } from "@/lib/notify"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { LISTABILITY_EXPLAIN, listabilityFromRefusal } from "@/features/supply-chain/listability-copy"
import type { usePublishQueue } from "./submit/use-publish-queue"
import { TEMPLATE_NOTICE_ID, type WorkflowScreenState } from "./workflow-screen-state"

/**
 * 「进入上架」失败的统一收尾：队列保持暂停（不自动重试、不轮询），
 * 通知走拒绝分类 fallback：`cloud_supplier_not_listable` 的 denial 归两类
 * 卖家可读文案（listability-copy.ts），后端 message 仍优先（error-message
 * 契约——渲染方不改写自己不拥有的规则）。
 */
export function runnerOpenRefused(reason: unknown): void {
  patchListingWorkbench({ queuePaused: true })
  const cls = listabilityFromRefusal(reason)
  notifyCommandError(
    reason,
    cls ? LISTABILITY_EXPLAIN[cls] : "无法进入上架执行，请稍后重试。",
  )
}

export function useWorkflowScreenLibrary({ state, workspaceId, skipNextAutosave, setCustomStoreQuotas, resetRowAutosaves, projectQueueState, restoreProductInstances, leaveRunner }: {
  state: WorkflowScreenState
  workspaceId?: number
  skipNextAutosave: RefObject<boolean>
  setCustomStoreQuotas: Dispatch<SetStateAction<Record<string, number>>>
  resetRowAutosaves: () => void
  projectQueueState: ReturnType<typeof usePublishQueue>["projectQueueState"]
  restoreProductInstances: (card: WorkflowDraftView, generation: number) => void
  leaveRunner: () => Promise<void>
}) {
  const { cardTemplateId, runnerOpenLock, stopCardStream, runnerGeneration, dispatchedRunnerGeneration,
    handledAddressCardId, preparationTracks, guidedPreparationLock, psdAssetTemplateIdRef,
    setLibraryBusy, setSavedForms, setBusy, setSchema, setDraft, setDraftId, setSupplierProductId,
    setCardTemplateId, setFormName, setIssues, setAiPromptId, setAiPrompt, setAiPromptFileName,
    setPsdTemplateAssetId, setPsdTemplateFileName, setPsdAsset, setTargetStoreId,
    setAiAllowedFieldKeys, setCardFieldOrigins, setMode, setRestoringCard } = state
  async function refreshSavedForms() {
    setLibraryBusy(true)
    try {
      setSavedForms(await loadListingCardList())
    } catch (reason) {
      notifyCommandError(reason, "无法读取已保存的上架方案，请稍后重试。")
    } finally {
      setLibraryBusy(false)
    }
  }

  async function reloadOzonStores(options?: { soft?: boolean }) {
    try {
      await loadStoreRoster({ workspaceId, force: !options?.soft })
    } catch {
      // A revisit is a soft refresh: keep the last useful roster if Cloud is
      // temporarily unavailable. Initial load still fails closed.
      if (!options?.soft) {
        forgetStoreRoster(workspaceId)
      }
    }
  }

  async function openRunner(saved: ListingCardSummary | WorkflowDraftView | string) {
    runnerOpenLock.current = true
    stopCardStream.current?.()
    // Leaving the previously open card: forget its session so a later revisit
    // re-GETs instead of trusting a possibly stale cached revision.
    if (cardTemplateId) closeCardSession(cardTemplateId)
    clearLive(TEMPLATE_NOTICE_ID)
    const generation = ++runnerGeneration.current
    const scope = rowCacheScope()
    const current = () => generation === runnerGeneration.current && scope.current()
    dispatchedRunnerGeneration.current = generation
    const recoveringFromUrl = typeof saved === "string"
    setBusy(true)
    setLibraryBusy(true)
    try {
      const entry = typeof saved !== "string" && "schema" in saved ? resolveRunnerEntry(saved) : undefined
      const cardId = typeof saved === "string" ? saved : saved.draft_id
      // A projected Draft cannot seed a session: use the original Cloud Card,
      // either already resident (e.g. just saved) or this normal entry's GET.
      const previousSession = peekCardSession(cardId), previousCard = previousSession?.card()
      const resident = entry && previousSession
      const raw = resident ? resident.card() : await readListingCard(cardId)
      if (!current()) return
      if (raw.id !== cardId) throw refuse("workflow_card_identity_mismatch", "读取的方案身份与所选方案不一致，请重新打开原方案")
      const schema = entry?.schema ?? await cardCategorySchema(cardPayload(raw))
      if (!current()) return
      if (peekCardSession(cardId) !== previousSession || previousSession?.card() !== previousCard) {
        throw refuse("workflow_card_session_changed", "载入期间方案已在本页更新，请重新打开当前方案后再操作")
      }
      if (!resident) primeCardSession(raw)
      const card = entry ?? cardDraftView(raw, schema)
      if (!current()) return
      handledAddressCardId.current = card.draft_id
      replaceAddress(writeWorkflowCardId(window.location.href, card.draft_id))
      skipNextAutosave.current = true
      setSchema(card.schema)
      setDraft(card.draft)
      setDraftId(card.draft_id)
      setSupplierProductId(card.supplier_product_id)
      setCardTemplateId(card.draft_id)
      resetListingWorkbench()
      preparationTracks.current = preparationTracksForCard(card.draft_id)
      patchListingWorkbench({
        cardId: card.draft_id,
        activity: preparationTracks.current.snapshot(),
      })
      setFormName(card.display_name || savedFormTitle(card))
      setIssues(card.issues)
      if (card.issues.length) {
        notifyError(`有 ${card.issues.length} 个字段问题，请修正后再发送。`, {
          description: card.issues
            .slice(0, 3)
            .map((issue) => `${issue.field_key}：${humanValidationMessage(issue)}`)
            .join("；"),
        })
      }
      setAiPromptId(card.ai_prompt_id)
      setAiPrompt(card.ai_prompt || DEFAULT_AI_PROMPT)
      setAiPromptFileName(card.ai_prompt_file_name)
      setPsdTemplateAssetId(card.psd_template_asset_id)
      setPsdTemplateFileName(card.psd_template_file_name)
      // The template digest supports pre-flight checks; each Job carries its prompt.
      setCardContext({
        psdTemplateSha256: card.psd_template_asset_id,
      })
      setPsdAsset(undefined)
      psdAssetTemplateIdRef.current = ""
      setTargetStoreId(card.target_store_id)
      setAiAllowedFieldKeys(card.ai_field_policy.allowed_field_keys)
      setCustomStoreQuotas({})
      guidedPreparationLock.current = false
      setCardFieldOrigins([])
      resetRowAutosaves()
      const [, queueState] = await Promise.all([
        restoreTemplatePsd(
          card.psd_template_asset_id,
          card.psd_template_file_name,
          generation,
          card.supplier_product_id,
          card.draft_id,
        ),
        cardQueueRunning(raw.id, cardPayload(raw).queue.frozenRowIds)
          .then((running) => queueStateView(raw, running)),
      ])
      if (!current()) return
      // Persisted cohort identifiers are Product Instance draft IDs, not
      // ephemeral table row IDs, so a restart can rebuild the same cohort.
      projectQueueState({
        paused: Boolean(queueState?.paused),
        running: Boolean(queueState?.running),
        frozen_row_ids: queueState?.frozen_row_ids ?? [],
        next_position: queueState?.next_position ?? 0,
        stop_after_current: Boolean(queueState?.stop_after_current),
        halt_reason: queueState?.halt_reason,
      })
      setSavedForms((current) =>
        upsertSavedForm(
          current,
          cardSummaryFromDraft(card),
        ),
      )
      setMode("runner")
      restoreProductInstances(card, generation)
    } catch (reason) {
      if (!current()) return
      clearLive(TEMPLATE_NOTICE_ID)
      if (recoveringFromUrl) {
        replaceAddress(writeWorkflowCardId(window.location.href))
      }
      runnerOpenRefused(reason)
    } finally {
      if (generation === runnerGeneration.current) {
        setBusy(false)
        runnerOpenLock.current = false
        setLibraryBusy(false)
        setRestoringCard(false)
      }
    }
  }

  async function restoreTemplatePsd(
    assetId: string,
    savedFileName = "",
    generation = runnerGeneration.current,
    productId?: string,
    cardId?: string,
  ): Promise<boolean> {
    const scope = rowCacheScope()
    const current = () => generation === runnerGeneration.current && scope.current()
    try {
      let currentId = assetId
      let fileName = savedFileName.trim()
      if (!currentId && productId && cardId) {
        const session = await openCardSession(cardId)
        const media = await session.verifySupplierOnce()
        if (!current()) return false
        if (media) {
          currentId = media.psd_sha256
          fileName ||= media.psd_file_name
        }
      }
      if (!currentId) {
        throw refuse("workflow_template_missing", "上架方案没有可用的 PSD 模板")
      }
      const managed = await renderOpfs.workflowRestoreTemplatePsd(currentId, productId, cardId)
      if (!current() || managed.asset_id !== currentId) return false
      fileName ||= managed.asset.file_name
      setPsdAsset({ ...managed.asset, file_name: fileName })
      psdAssetTemplateIdRef.current = currentId
      setCardContext({ psdTemplateSha256: currentId })
      clearLive(TEMPLATE_NOTICE_ID)
      return true
    } catch (reason) {
      if (!current()) return false
      setPsdAsset(undefined)
      psdAssetTemplateIdRef.current = ""
      const missing = commandErrorCode(reason) === "workflow_template_missing"
      notifyLive({
        id: TEMPLATE_NOTICE_ID,
        type: "error",
        title: errorMessage(reason, "PSD 模板暂时无法恢复"),
        reason,
        description: missing
          ? "请返回上架方案重新绑定 PSD。AI 识别仍可用；新切片暂不可用，已完成媒体的商品仍可发送。"
          : "请重试检查。AI 识别仍可用；新切片暂不可用，已完成媒体的商品仍可发送。",
        action: missing
          ? { label: "返回方案", onClick: () => void leaveRunner() }
          : { label: "重试检查", onClick: () => void restoreTemplatePsd(assetId, savedFileName, generation, productId, cardId) },
      })
      return false
    }
  }

  return { refreshSavedForms, reloadOzonStores, openRunner }
}
