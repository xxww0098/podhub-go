/** Small resident workbench beside S16; it never starts a send or replaces the queue. */
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { notifyError } from "@/lib/notify"
import type { ListingCoreClient } from "@/listing-core/client"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import { peekCardSession } from "@/features/workflow/card/card-session"
import type { WorkflowPublishContext } from "@/features/workflow/workflow-publish-capabilities"
import { useWorkflowPublishCapabilities } from "@/features/workflow/use-workflow-publish-capabilities"
import { createWorkflowPublishNative } from "@/features/workflow/workflow-publish-native"
import { peekListingWorkbench, subscribeListingWorkbench, patchListingWorkbench } from "@/features/workflow/workbench/listing-workbench-store"
import { beginAction, endAction, recordNative, type ActionName } from "./publish-pipeline-metrics"
import { WorkbenchActions } from "./publish-pipeline-workbench-actions"
import { seedWorkbench, workbenchData, workbenchIds, type WorkbenchMode } from "./publish-pipeline-workbench-fixtures"
import type { createWorkbenchMocks } from "./publish-pipeline-workbench-mocks"

const modes = {
  brand: "品牌词已确认拒绝", "brand-no-action": "未允许编辑行", "brand-stale-revision": "拒绝记录版本已过期",
  unknown: "原 Intent 未确认", "unknown-missing-id": "释放回执缺失原 ID", "unknown-readback-failed": "释放后读回断网", "unknown-no-resident": "缺少驻留方案",
} satisfies Partial<Record<WorkbenchMode, string>>
type WorkbenchProps = { core: ListingCoreClient; mocks: ReturnType<typeof createWorkbenchMocks> }
type Capabilities = NonNullable<ReturnType<typeof useWorkflowPublishCapabilities>>
export function PublishPipelineWorkbench(props: WorkbenchProps) {
  return <StrictMode><ResidentWorkbench {...props} /></StrictMode>
}
function ResidentWorkbench({ core, mocks }: WorkbenchProps) {
  const [mode, setMode] = useState<WorkbenchMode>("brand")
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false)
  const [, refresh] = useState(0)
  const context = useRef<WorkflowPublishContext>({ workspaceId: 1, cardId: workbenchIds.card, generation: 1, controlVersion: 0, active: true, blocked: false })
  const [native] = useState(() => createWorkflowPublishNative(() => core))
  // Retain just the most recently cleaned-up owner to prove real replay after
  // explicit seeding makes the same current row available to the fresh owner.
  const lifecycle = useRef<{ setups: number; cleanups: number; retired?: Capabilities }>({ setups: 0, cleanups: 0 })
  const capabilities = useWorkflowPublishCapabilities(() => context.current, native, peekCardSession, (phase, owner) => {
    if (phase === "setup") lifecycle.current.setups++
    else { lifecycle.current.cleanups++; lifecycle.current.retired = owner }
    recordNative("workbench-capability-lifecycle", { phase, setups: lifecycle.current.setups, cleanups: lifecycle.current.cleanups,
      distinctFromRetired: lifecycle.current.retired ? lifecycle.current.retired !== owner : null })
  })
  const state = useSyncExternalStore((changed) => subscribeListingWorkbench(changed), peekListingWorkbench)
  const capture = () => {
    const current = peekListingWorkbench(), row = current.rows[0], view = row && current.productBases[row.draftId]
    const raw = row && cachedListingRow(row.draftId)
    const replayed = lifecycle.current.setups >= 2 && lifecycle.current.cleanups >= 1
      && !!lifecycle.current.retired && lifecycle.current.retired !== capabilities
    const retiredBrandAvailable = !!row && !!view && !!lifecycle.current.retired?.brandRepair.current(row, view.lifecycle.revision)
    const liveBrandAvailable = !!row && !!view && !!capabilities?.brandRepair.current(row, view.lifecycle.revision)
    recordNative("workbench-capability-current", { replayed, setups: lifecycle.current.setups, cleanups: lifecycle.current.cleanups,
      retiredBrandAvailable, liveBrandAvailable })
    recordNative("workbench-state", { mode, loaded, active: context.current.active, blocked: context.current.blocked,
      rowId: row?.draftId, stage: view?.lifecycle.stage, revision: view?.lifecycle.revision, viewRevision: view?.lifecycle.view_revision,
      locked: row?.publishUnconfirmed ?? false, nativeTagsCleared: raw?.draft.cleared?.includes("native_search_tags") ?? false,
      ready: row?.readiness?.ready_to_publish ?? false })
    return replayed && !retiredBrandAvailable && liveBrandAvailable === (mode === "brand")
  }
  const outcome = (name: ActionName) => {
    const current = peekListingWorkbench(), row = current.rows[0], product = row && current.productBases[row.draftId]
    if (!row || !product) return false
    if (name === "brand-repair") return context.current.blocked || !context.current.active
      ? product.lifecycle.revision === 1 && product.lifecycle.stage === "publish_rejected"
      : product.lifecycle.revision === 2 && product.lifecycle.stage === "ready_to_publish"
        && cachedListingRow(row.draftId)?.draft.cleared?.includes("native_search_tags") === true
    if (name === "unknown-inspect") return mode === "unknown-no-resident"
      ? capabilities?.unknownRelease.capture(row.id) === undefined
      : capabilities?.unknownRelease.capture(row.id) !== undefined
    if (name === "unknown-release") return mode === "unknown-missing-id" || mode === "unknown-readback-failed"
      ? row.publishUnconfirmed === true && product.lifecycle.stage === "outcome_unknown"
      : !row.publishUnconfirmed && product.lifecycle.stage === "ready_to_publish" && product.lifecycle.view_revision === 2
    return true
  }
  useEffect(() => { if (loaded) capture() }, [state, loaded])
  useEffect(() => {
    const edit = core.editRow.bind(core), revalidate = core.revalidate.bind(core)
    // Observe actual op2/op7 outputs; these wrappers never replace or invent a native result.
    core.editRow = async (...args) => {
      const result = await edit(...args)
      if (args[1].row.draft.values.offer_id?.value === workbenchIds.row) await mocks.observeEdit(result)
      return result
    }
    core.revalidate = async (...args) => {
      const result = await revalidate(...args)
      if (args[1].row.draft.values.offer_id?.value === workbenchIds.row) recordNative("workbench-native-validation", {
        fact: result.fact, cleared: result.row.draft.cleared ?? [], handEditedKeys: result.row.handEditedKeys })
      return result
    }
    // The production hook owns synchronous capability disposal. This observer
    // only restores native methods; replay must not overwrite user context.
    return () => { mocks.release(); core.editRow = edit; core.revalidate = revalidate }
  }, [core, mocks])
  return <section aria-label="生产工作台动作" aria-busy={loading} className="flex flex-col gap-3">
    <h2 className="text-lg font-semibold">生产工作台修复与原 Intent 核对</h2>
    <p className="text-muted-foreground">旧工作台明确保存使用一笔行 PATCH 与新 GET；新 S16 的本地导入、编辑、校验保持零业务调用。此处没有发送按钮。</p>
    <label>工作台外部事实<select disabled={loaded || loading} value={mode} onChange={(event) => {
      const measured = beginAction("workbench-configure"); setMode(event.target.value as WorkbenchMode); void endAction(measured)
    }}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label><input type="checkbox" disabled={loading} onChange={(event) => {
      const measured = beginAction("workbench-configure"); mocks.hold(event.target.checked); void endAction(measured)
    }} />保持原生标签编辑后的等待</label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={loaded || loading} onClick={() => {
        const measured = beginAction("workbench-load"); setLoading(true)
        const data = workbenchData(mode); mocks.select(data)
        void seedWorkbench(data).then(() => {
          if (!capture()) {
            setLoading(false)
            notifyError("工作台发布能力的真实 StrictMode 重放未通过；请检查新 owner 与已释放 owner 的只读证据。")
            return endAction(measured, false)
          }
          setLoaded(true); setLoading(false); capture(); return endAction(measured)
        }, async () => { setLoading(false); notifyError("工作台夹具未载入；请检查显式类目读取与驻留数据后重新打开夹具"); await endAction(measured, false) })
      }}>明确载入工作台夹具</Button>
      <Button variant="outline" disabled={!loaded || context.current.blocked} onClick={() => {
        const measured = beginAction("workbench-stop"); context.current.controlVersion++; context.current.blocked = true
        capabilities?.dispose(); patchListingWorkbench({ queuePaused: true }); capture(); refresh((value) => value + 1); void endAction(measured)
      }}>停止工作台动作</Button>
      <Button variant="outline" disabled={!loaded} onClick={() => {
        const measured = beginAction("workbench-scope"); context.current.active = !context.current.active; context.current.generation++
        capabilities?.dispose(); capture(); refresh((value) => value + 1); void endAction(measured)
      }}>{context.current.active ? "离开工作台作用域" : "返回工作台作用域"}</Button>
      <Button variant="outline" onClick={() => { const measured = beginAction("mock-release"); mocks.release(); void endAction(measured) }}>释放原生编辑等待</Button>
    </div>
    {!loaded ? <p role="status">{loading ? "正在显式读取类目并载入驻留方案" : "尚无工作台商品"}</p>
      : capabilities && <WorkbenchActions capabilities={capabilities}
        blocked={!context.current.active || context.current.blocked} capture={capture} outcome={outcome} />}
  </section>
}
