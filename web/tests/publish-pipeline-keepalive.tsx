/** Same mounted screen and card across ScreenPane hide/return; no fixture revocation. */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { ScreenPane, useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { notifyError } from "@/lib/notify"
import type { ListingCoreClient } from "@/listing-core/client"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import { peekCardSession } from "@/features/workflow/card/card-session"
import { preparationRunning } from "@/features/workflow/prepare/preparation-tracks"
import { useWorkflowScreenState } from "@/features/workflow/workflow-screen-state"
import { useWorkflowScreenLifecycle } from "@/features/workflow/workflow-screen-lifecycle"
import { useWorkflowPublishCapabilities } from "@/features/workflow/use-workflow-publish-capabilities"
import { createWorkflowPublishNative } from "@/features/workflow/workflow-publish-native"
import { listingWorkbenchScope, peekListingWorkbench, subscribeListingWorkbench } from "@/features/workflow/workbench/listing-workbench-store"
import { WorkbenchActions } from "./publish-pipeline-workbench-actions"
import { seedWorkbench, workbenchData, workbenchIds } from "./publish-pipeline-workbench-fixtures"
import type { createWorkbenchMocks } from "./publish-pipeline-workbench-mocks"
import { beginAction, endAction, recordNative, type ActionName } from "./publish-pipeline-metrics"

type Props = { core: ListingCoreClient; mocks: ReturnType<typeof createWorkbenchMocks> }
type Capabilities = NonNullable<ReturnType<typeof useWorkflowPublishCapabilities>>
export type KeepaliveStateEvidence = {
  componentId: string; active: boolean; workspaceId: number; addressCardId: string; cardId: string | undefined
  mode: string; storeId: string; storeConfigured: boolean; canManage: boolean
  generation: number; dispatchedGeneration: number; handledCardId: string | undefined; controlVersion: number
  scope: number; mediaEpoch: number; rowId: string | undefined; revision: number | undefined; viewRevision: number | undefined
  stage: string | undefined; locked: boolean; ready: boolean; nativeTagsCleared: boolean
  openRunnerCalls: number; leaveRunnerCalls: number; refreshSavedFormsCalls: number; reloadOzonStoresCalls: number
  setups: number; cleanups: number; retiredDistinct: boolean; ownerSameAsSeeded: boolean
  mountSetups: number; mountCleanups: number
  retiredBrandAvailable: boolean | null; liveBrandAvailable: boolean | null
  unknownCandidate: { intentId: string; rowId: string; storeId: string; revision: number; operationId: string } | null
}

export function PublishPipelineKeepalive(props: Props) {
  const [active, setActive] = useState(true)
  return <section aria-label="真实屏幕保活夹具" className="flex flex-col gap-3">
    <h2 className="text-lg font-semibold">同一卡片隐藏与返回</h2>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => {
        const measured = beginAction("workbench-scope")
        // This is the entire navigation control: no owner disposal, key or fence change.
        setActive((value) => !value); void endAction(measured)
      }}>{active ? "隐藏保活屏幕" : "返回同一卡片保活屏幕"}</Button>
      <Button variant="outline" onClick={() => {
        const measured = beginAction("mock-release"); props.mocks.release(); void endAction(measured)
      }}>释放保活原生编辑等待</Button>
    </div>
    <ScreenPane active={active}><ResidentKeepalive key="keepalive-workspace-1" {...props} /></ScreenPane>
  </section>
}

function ResidentKeepalive({ core, mocks }: Props) {
  const active = useScreenActive(), componentId = useId()
  // The real state hook subscribes to the already seeded roster; it does not load it.
  const screen = useWorkflowScreenState(undefined, 1, active)
  const [mode, setMode] = useState<"brand" | "unknown">("brand")
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false)
  const controlVersion = useRef(0), edits = useRef(0)
  const mounts = useRef({ setups: 0, cleanups: 0 })
  const ports = useRef({ openRunner: 0, leaveRunner: 0, refreshSavedForms: 0, reloadOzonStores: 0 })
  const [native] = useState(() => createWorkflowPublishNative(() => core))
  const owners = useRef<{ setups: number; cleanups: number; retired?: Capabilities; seeded?: Capabilities }>({ setups: 0, cleanups: 0 })
  const capabilities = useWorkflowPublishCapabilities(() => ({
    workspaceId: 1, cardId: screen.cardTemplateId, generation: screen.runnerGeneration.current, controlVersion: controlVersion.current,
    active: active && screen.mode === "runner",
    blocked: screen.busy || screen.runnerOpenLock.current || screen.rowClearLock.current
      || preparationRunning(screen.preparationTracks.current.snapshot()),
  }), native, peekCardSession, (phase, owner) => {
    if (phase === "setup") owners.current.setups++
    else { owners.current.cleanups++; owners.current.retired = owner }
    recordNative("keepalive-capability-lifecycle", { componentId, phase, setups: owners.current.setups, cleanups: owners.current.cleanups,
      distinctFromRetired: owners.current.retired ? owners.current.retired !== owner : null })
  })
  const resident = useRef({ active, screen, capabilities })
  resident.current = { active, screen, capabilities }
  const state = useSyncExternalStore((changed) => subscribeListingWorkbench(changed), peekListingWorkbench)
  // These exact non-publish ports isolate library/entry/autosave IO. The actual
  // lifecycle still decides whether to call them, including its same-card guard.
  useWorkflowScreenLifecycle({ state: screen, active, addressCardId: workbenchIds.card,
    flushCardAutosave: async () => true, flushRowAutosavesNow: () => {}, hasPendingCardChanges: () => false, pendingRowEdits: () => false,
    refreshSavedForms: async () => { ports.current.refreshSavedForms++; recordNative("keepalive-lifecycle-port", { port: "refreshSavedForms", active }) },
    reloadOzonStores: async (options) => { ports.current.reloadOzonStores++; recordNative("keepalive-lifecycle-port", { port: "reloadOzonStores", active, soft: !!options?.soft }) },
    openRunner: async (saved) => {
      if (saved !== workbenchIds.card) throw new Error("Keepalive entry changed the original card")
      ports.current.openRunner++
      screen.dispatchedRunnerGeneration.current = screen.runnerGeneration.current
      recordNative("keepalive-lifecycle-port", { port: "openRunner", cardId: saved, generation: screen.runnerGeneration.current })
    },
    leaveRunner: async () => { ports.current.leaveRunner++; throw new Error("Same-card return unexpectedly left the runner") },
  })

  const capture = () => {
    // An old in-flight action may finish after return; record the current resident,
    // retaining the retired owner's identity without probing authority while hidden.
    const { active, screen, capabilities } = resident.current
    const current = peekListingWorkbench(), row = current.rows[0], view = row && current.productBases[row.draftId]
    const raw = row && cachedListingRow(row.draftId)
    // Do not probe a hidden pin: unknown.current() itself remembers invalidity.
    // Hidden evidence is limited to the screen/store facts, leaving real UI policy in control.
    const candidate = active && row ? capabilities?.unknownRelease.capture(row.id) : undefined
    const value: KeepaliveStateEvidence = {
      componentId, active, workspaceId: 1, addressCardId: workbenchIds.card, cardId: screen.cardTemplateId,
      mode: screen.mode, storeId: screen.targetStoreId, storeConfigured: screen.storeConfigured,
      canManage: screen.ozonStores.find((store) => store.id === screen.targetStoreId)?.can_manage === true,
      generation: screen.runnerGeneration.current, dispatchedGeneration: screen.dispatchedRunnerGeneration.current,
      handledCardId: screen.handledAddressCardId.current, controlVersion: controlVersion.current,
      scope: listingWorkbenchScope(), mediaEpoch: current.mediaEpoch, rowId: row?.draftId,
      revision: view?.lifecycle.revision, viewRevision: view?.lifecycle.view_revision, stage: view?.lifecycle.stage,
      locked: row?.publishUnconfirmed ?? false, ready: row?.readiness?.ready_to_publish ?? false,
      nativeTagsCleared: raw?.draft.cleared?.includes("native_search_tags") ?? false,
      openRunnerCalls: ports.current.openRunner, leaveRunnerCalls: ports.current.leaveRunner,
      refreshSavedFormsCalls: ports.current.refreshSavedForms, reloadOzonStoresCalls: ports.current.reloadOzonStores,
      setups: owners.current.setups, cleanups: owners.current.cleanups,
      mountSetups: mounts.current.setups, mountCleanups: mounts.current.cleanups,
      retiredDistinct: !!owners.current.retired && owners.current.retired !== capabilities,
      ownerSameAsSeeded: !!capabilities && owners.current.seeded === capabilities,
      retiredBrandAvailable: active && row && view ? !!owners.current.retired?.brandRepair.current(row, view.lifecycle.revision) : null,
      liveBrandAvailable: active && row && view ? !!capabilities?.brandRepair.current(row, view.lifecycle.revision) : null,
      unknownCandidate: candidate ? { intentId: candidate.intent.id, rowId: candidate.intent.listing_row_id,
        storeId: candidate.intent.store_id, revision: candidate.intent.row_revision, operationId: candidate.intent.client_operation_id } : null,
    }
    recordNative("keepalive-state", value)
  }
  const outcome = (name: ActionName) => {
    const current = peekListingWorkbench(), row = current.rows[0], view = row && current.productBases[row.draftId]
    if (!row || !view) return false
    if (name === "brand-repair") return edits.current === 1
      ? view.lifecycle.revision === 1 && view.lifecycle.stage === "publish_rejected"
      : view.lifecycle.revision === 2 && view.lifecycle.stage === "ready_to_publish"
    if (name === "unknown-inspect") return capabilities?.unknownRelease.capture(row.id) !== undefined
    if (name === "unknown-release") return !row.publishUnconfirmed && view.lifecycle.stage === "ready_to_publish" && view.lifecycle.view_revision === 2
    return true
  }
  useEffect(() => { capture() }, [active, state, loaded, capabilities, screen.mode, screen.cardTemplateId, screen.targetStoreId])
  useEffect(() => {
    mounts.current.setups++
    recordNative("keepalive-resident-lifecycle", { componentId, phase: "setup", ...mounts.current })
    return () => {
      mounts.current.cleanups++
      recordNative("keepalive-resident-lifecycle", { componentId, phase: "cleanup", ...mounts.current })
    }
  }, [])
  useEffect(() => {
    const edit = core.editRow.bind(core), revalidate = core.revalidate.bind(core)
    core.editRow = async (...args) => {
      const result = await edit(...args)
      if (args[1].row.draft.values.offer_id?.value === workbenchIds.row) { edits.current++; await mocks.observeEdit(result) }
      return result
    }
    core.revalidate = async (...args) => {
      const result = await revalidate(...args)
      if (args[1].row.draft.values.offer_id?.value === workbenchIds.row) recordNative("keepalive-native-validation", {
        fact: result.fact, cleared: result.row.draft.cleared ?? [], handEditedKeys: result.row.handEditedKeys })
      return result
    }
    return () => { mocks.release(); core.editRow = edit; core.revalidate = revalidate }
  }, [core, mocks])
  return <section aria-label="保活屏幕生产动作" data-keepalive-instance={componentId} data-keepalive-active={active} aria-busy={loading} className="flex flex-col gap-3">
    <label>保活外部事实<select disabled={loaded || loading} value={mode} onChange={(event) => {
      const next = event.target.value
      if (next !== "brand" && next !== "unknown") return
      const measured = beginAction("workbench-configure"); setMode(next); void endAction(measured)
    }}><option value="brand">品牌词已确认拒绝</option><option value="unknown">原 Intent 未确认</option></select></label>
    <label><input type="checkbox" onChange={(event) => {
      const measured = beginAction("workbench-configure"); mocks.hold(event.target.checked); void endAction(measured)
    }} />保持保活原生编辑后的等待</label>
    <Button disabled={loaded || loading || !capabilities} onClick={() => {
      const measured = beginAction("workbench-load"); setLoading(true)
      const data = workbenchData(mode); mocks.select(data); owners.current.seeded = capabilities
      void seedWorkbench(data).then(() => {
        const product = peekListingWorkbench().productBases[data.raw.id]
        if (!product) throw new Error("Explicit seed omitted the real workbench product")
        screen.setSchema(product.schema); screen.setDraft(product.draft); screen.setDraftId(data.card.id)
        screen.setCardTemplateId(data.card.id); screen.setTargetStoreId(product.target_store_id)
        screen.setFormName(data.card.title); screen.setMode("runner")
        setLoaded(true); setLoading(false); return endAction(measured)
      }).catch(async () => {
        setLoading(false); notifyError("保活夹具未载入；请检查显式类目读取和驻留商品，再重新打开夹具")
        await endAction(measured, false)
      })
    }}>明确载入保活工作台夹具</Button>
    {!loaded ? <p role="status">{loading ? "正在明确载入" : "尚无保活工作台商品"}</p>
      : capabilities && <WorkbenchActions capabilities={capabilities} blocked={!active || screen.busy} capture={capture} outcome={outcome} />}
  </section>
}
