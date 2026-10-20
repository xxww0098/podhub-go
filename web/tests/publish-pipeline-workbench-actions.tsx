/** Real hook callbacks bound to the production remediation and exact-Intent strip. */
import { useRef } from "react"
import { useRepairPublish } from "@/features/workflow/submit/use-repair-publish"
import { useUnknownRelease } from "@/features/workflow/submit/use-unknown-release"
import { createPreparationTracks } from "@/features/workflow/prepare/preparation-tracks"
import { peekListingWorkbench } from "@/features/workflow/workbench/listing-workbench-store"
import { currentWorkbenchDiagnostic } from "@/features/workflow/workbench/publish-diagnostic-producer"
import { PublishRemediation } from "@/features/workflow/workbench/publish-remediation"
import { UnknownReleaseStrip } from "@/features/workflow/workbench/unknown-release-strip"
import { resolvePublishRemediation } from "@/features/workflow/model/publish-remediation"
import type { createWorkflowPublishCapabilities } from "@/features/workflow/workflow-publish-capabilities"
import { beginAction, endAction, recordNative, type ActionName } from "./publish-pipeline-metrics"

export function WorkbenchActions({ capabilities, blocked, capture, outcome }: {
  capabilities: ReturnType<typeof createWorkflowPublishCapabilities>; blocked: boolean; capture(): void; outcome(name: ActionName): boolean
}) {
  const preparationTracks = useRef(createPreparationTracks())
  const repair = useRepairPublish({ busy: blocked, preparationTracks, capability: capabilities.brandRepair,
    // This isolated resident fixture has no autosave queue. Check the real save owner before proceeding.
    flushAutosavesFor: async (ids) => ids.every((id) => !peekListingWorkbench().dirtyProducts[id]
      && !["dirty", "saving", "error"].includes(peekListingWorkbench().rowSaveStates[id] ?? "idle")) })
  const release = useUnknownRelease(blocked, capabilities.unknownRelease, capabilities.inspectUnknownRows)
  const state = peekListingWorkbench(), row = state.rows[0], product = row && state.productBases[row.draftId]
  const invoke = (name: ActionName, work: () => Promise<unknown>) => {
    const measured = beginAction(name)
    void work().then(() => { capture(); return endAction(measured, outcome(name)) }, async () => { capture(); await endAction(measured, false) })
  }
  if (!row || !product) return <p>尚无工作台商品，请从夹具入口明确载入。</p>
  const revision = product.lifecycle.revision
  const repairable = !blocked && !repair.repairInFlight && capabilities.brandRepair.current(row, revision)
  const reference = currentWorkbenchDiagnostic(row, state)
  const resolved = resolvePublishRemediation({ lifecycle: product.lifecycle, readiness: row.readiness, rowLog: row.log,
    localUnconfirmed: row.publishUnconfirmed, brandRepairable: repairable, platform: "ozon" })
  const remediation = resolved && { ...resolved, diagnosticId: reference?.diagnosticId, traceId: reference?.traceId ?? resolved.traceId }
  const ids = row.publishUnconfirmed || product.lifecycle.stage === "outcome_unknown" ? [row.id] : []
  return <div data-workbench-stage={product.lifecycle.stage} data-workbench-revision={revision}
    data-workbench-view-revision={product.lifecycle.view_revision} data-workbench-locked={!!row.publishUnconfirmed}
    aria-busy={repair.repairInFlight || release.releaseInFlight} className="flex flex-col gap-2"
    onClickCapture={(event) => {
      const button = (event.target as HTMLElement).closest("button")
      if (button?.getAttribute("aria-label")?.startsWith("核对后释放") || button?.textContent === "取消") {
        const measured = beginAction("unknown-confirm"); void endAction(measured)
      }
      if ((event.target as HTMLElement).closest("summary")) { const measured = beginAction("diagnostic-details"); void endAction(measured) }
    }}>
    <p role="status">{repair.repairInFlight ? "原生修复和保存中" : release.releaseInFlight ? "确切 Intent 核对或释放中"
      : product.lifecycle.stage === "ready_to_publish" ? "已读回并校验，尚未发送" : "保留当前业务状态，等待明确处理"}</p>
    {remediation && <PublishRemediation remediation={remediation}
      onRepairBrand={repairable ? () => invoke("brand-repair", () => repair.repairRows([row.id])) : undefined} />}
    <UnknownReleaseStrip rowIds={ids} releasing={release.releaseInFlight} disabled={blocked}
      available={release.canReleaseUnknownRows(ids)}
      onInspect={(selected) => invoke("unknown-inspect", async () => {
        await release.inspectUnknownRows(selected)
        recordNative("unknown-availability", { available: release.canReleaseUnknownRows(selected), rowIds: selected })
      })}
      onRelease={(selected) => invoke("unknown-release", () => release.releaseUnknownRows(selected))} />
  </div>
}
