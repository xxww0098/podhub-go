import { useEffect } from "react"
import type { CategorySchemaView } from "@/bindings/commands"
import { createPreparationTracks } from "./prepare/preparation-tracks"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench, subscribeListingWorkbench } from "./workbench/listing-workbench-store"
import { notifyError } from "@/lib/notify"
import type { WorkflowScreenState } from "./workflow-screen-state"
import type { useWorkflowScreenLibrary } from "./workflow-screen-library"

export function useWorkflowScreenLifecycle({ state, active, addressCardId, initialSchema, flushCardAutosave, flushRowAutosavesNow, hasPendingCardChanges, pendingRowEdits, refreshSavedForms, reloadOzonStores, openRunner, leaveRunner }: {
  state: WorkflowScreenState; active: boolean; addressCardId?: string; initialSchema?: CategorySchemaView
  flushCardAutosave: () => Promise<boolean>; flushRowAutosavesNow: () => void
  hasPendingCardChanges: () => boolean; pendingRowEdits: () => boolean
  refreshSavedForms: ReturnType<typeof useWorkflowScreenLibrary>["refreshSavedForms"]
  reloadOzonStores: ReturnType<typeof useWorkflowScreenLibrary>["reloadOzonStores"]
  openRunner: ReturnType<typeof useWorkflowScreenLibrary>["openRunner"]
  leaveRunner: () => Promise<void>
}) {
  const { runnerGeneration, stopCardStream, preparationTracks, mode, formName,
    handledAddressCardId, dispatchedRunnerGeneration, setRestoringCard, wasActive, schema, draft } = state

  useEffect(() => () => {
    // Fire every pending durable write before the scope bump fences them: each
    // drain invokes its save synchronously, so the PATCHes are admitted while
    // the scope is still current. The reset below only fences bookkeeping.
    void flushCardAutosave()
    flushRowAutosavesNow()
    runnerGeneration.current += 1
    stopCardStream.current?.()
    preparationTracks.current = createPreparationTracks()
    resetListingWorkbench()
  }, [])

  useEffect(() => {
    if (mode !== "runner") { stopCardStream.current?.(); runnerGeneration.current++ }
  }, [mode])

  useEffect(() => {
    patchListingWorkbench({
      cardName: formName.trim() || "上架任务",
    })
  }, [formName])

  // Keep the workbench focus on a live row; drop it when the table empties.
  useEffect(() => {
    const apply = (state: ReturnType<typeof peekListingWorkbench>) => {
      if (!state.rows.length) {
        if (state.activeProductId !== undefined) {
          patchListingWorkbench({ activeProductId: undefined })
        }
        return
      }
      const focused = state.rows.find((row) => row.id === state.activeProductId) ?? state.rows[0]
      if (focused && focused.id !== state.activeProductId) {
        patchListingWorkbench({ activeProductId: focused.id })
      }
    }
    apply(peekListingWorkbench())
    return subscribeListingWorkbench(apply)
  }, [])

  useEffect(() => {
    void refreshSavedForms()
    // Soft joins an in-flight roster read (the shell often just loaded it)
    // instead of forcing a second GET on this mount.
    void reloadOzonStores({ soft: true })
  }, [])

  useEffect(() => {
    if (!active) return
    // openRunner 派发出去后可能被 runnerGeneration 递增作废（StrictMode 二次
    // 挂载、退出 runner）——作废的 run 不会自己收尾，同一 cardId 必须重新派发，
    // 否则「正在恢复上架方案」一直转圈。
    const dispatchedAlive =
      dispatchedRunnerGeneration.current === runnerGeneration.current
    if (addressCardId === handledAddressCardId.current && dispatchedAlive) return
    handledAddressCardId.current = addressCardId
    if (addressCardId) {
      void openRunner(addressCardId)
      return
    }
    if (!initialSchema && mode === "runner") {
      // 壳层换屏已收掉 cardId（离开批量上架或点本屏导航）：回来落在主列表。
      // 与 runner 返回键同一收尾——先冲刷卡片与逐行保存，发送在途时留在原屏。
      void leaveRunner()
    }
    setRestoringCard(false)
  }, [active, addressCardId, initialSchema, mode])

  useEffect(() => {
    const becameActive = active && !wasActive.current
    wasActive.current = active
    // ScreenPane keeps this module mounted. Re-read the roster when returning
    // from 店铺 so newly created/saved Stores appear without signing out; a
    // pane that is still hidden stays quiet, so leaving this screen never
    // costs a round trip.
    if (!becameActive) return
    void refreshSavedForms()
    void reloadOzonStores({ soft: true })
  }, [active])

  useEffect(() => {
    if (mode === "runner" && (!schema || !draft)) {
      notifyError("无法打开上架执行，请稍后重试。")
    }
  }, [mode, schema, draft])


  useEffect(() => {
    const preventCloseWithUnsavedChanges = (event: BeforeUnloadEvent) => {
      if (!hasPendingCardChanges() && !pendingRowEdits() && !peekListingWorkbench().pendingRemovalIds.size) return
      event.preventDefault()
    }
    window.addEventListener("beforeunload", preventCloseWithUnsavedChanges)
    return () => window.removeEventListener("beforeunload", preventCloseWithUnsavedChanges)
  }, [])

}
