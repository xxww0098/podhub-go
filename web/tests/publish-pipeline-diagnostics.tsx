/** Route identity and read-only UI observation; diagnostics are produced by production owners. */
import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { currentLocalPublishDiagnostic } from "@/features/workflow/submit/queue/diagnostics"
import { PublishDiagnosticReporterContext, usePublishDiagnostics } from "@/features/workflow/submit/use-publish-diagnostics"
import { PublishRemediation } from "@/features/workflow/workbench/publish-remediation"
import { resolvePublishRemediation } from "@/features/workflow/model/publish-remediation"
import type { LocalRow } from "@/features/workflow/rows/types"
import { requestEvidenceRemediation, type PublishRequestEvidence } from "@/features/workflow/model/publish-request-evidence"
import { getDiagnosticDetail } from "@/lib/error-telemetry"
import { beginAction, endAction, recordNative } from "./publish-pipeline-metrics"
import type { createDiagnosticMocks } from "./publish-pipeline-diagnostic-mocks"

export function PipelineDiagnosticRoute({ current, children, mocks }: {
  current: boolean; children: ReactNode; mocks: ReturnType<typeof createDiagnosticMocks>
}) {
  const [active, setActive] = useState(true)
  const [offline, setOffline] = useState(false)
  const route = usePublishDiagnostics(current && active, () => current)
  useEffect(() => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    const original = clipboard.writeText.bind(clipboard)
    const observed: typeof clipboard.writeText = (text) => {
      const measured = beginAction("diagnostic-copy")
      // Initiate the actual write synchronously in the component's gesture stack.
      const write = original(text)
      let proof: { diagnosticId?: string; traceId?: string; payloadSha256?: string; hasOriginal?: boolean; provenance?: string; exactSubmittedBytes: boolean }
      try {
        const copy = JSON.parse(text) as Record<string, unknown>
        proof = { diagnosticId: typeof copy.diagnosticId === "string" ? copy.diagnosticId : undefined,
          traceId: typeof copy.traceId === "string" ? copy.traceId : undefined,
          payloadSha256: typeof copy.payloadSha256 === "string" ? copy.payloadSha256 : undefined,
          hasOriginal: copy.hasOriginal === true, provenance: typeof copy.provenance === "string" ? copy.provenance : undefined,
          exactSubmittedBytes: mocks.copyMatches(copy.originalJson, copy.payloadSha256) }
      } catch { proof = { exactSubmittedBytes: false } }
      return write.then(() => { recordNative("clipboard", { ...proof, writeSucceeded: true }); mocks.forgetOriginal(); void endAction(measured) },
        (reason: unknown) => { recordNative("clipboard", { ...proof, writeSucceeded: false }); void endAction(measured, false); throw reason })
    }
    clipboard.writeText = observed
    return () => { clipboard.writeText = original; mocks.forgetOriginal() }
  }, [mocks])
  useEffect(() => () => {
    if (offline) { delete (navigator as unknown as { onLine?: boolean }).onLine; window.dispatchEvent(new Event("online")) }
  }, [offline])
  const changeRoute = (next: boolean) => {
    const measured = beginAction("diagnostic-route")
    setActive(next)
    void endAction(measured)
  }
  return <PublishDiagnosticReporterContext.Provider value={async (id) => {
    const measured = beginAction("diagnostic-report")
    try {
      const admitted = await route.report(id)
      recordNative("diagnostic-report-window", { diagnosticId: id, admitted })
      // Resolve to the real component before the paint observation, including its busy-state cleanup.
      void endAction(measured, admitted)
      return admitted
    } catch (reason) { void endAction(measured, false); throw reason }
  }}>
    <section aria-label="诊断路由" className="flex flex-col gap-2">
      <p role="status">诊断路由{active && current ? "已进入" : "已离开"}；{offline ? "离线，投递暂停" : "在线"}。窗口准入与 Cloud accepted 回执分别计量。</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!active} onClick={() => changeRoute(false)}>离开诊断路由</Button>
        <Button variant="outline" disabled={active || !current} onClick={() => changeRoute(true)}>进入诊断路由</Button>
        <Button variant="outline" onClick={() => {
          const measured = beginAction("diagnostic-offline")
          const next = !offline
          if (next) Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
          else delete (navigator as unknown as { onLine?: boolean }).onLine
          setOffline(next); window.dispatchEvent(new Event(next ? "offline" : "online")); void endAction(measured)
        }}>{offline ? "恢复在线" : "模拟离线"}</Button>
        <Button variant="outline" onClick={() => { const measured = beginAction("diagnostic-select"); mocks.failNext(); recordNative("inbox-next", { failOnce: true }); void endAction(measured) }}>下次 inbox 拒绝一次</Button>
      </div>
    </section>
    {children}
  </PublishDiagnosticReporterContext.Provider>
}

export function PipelineRowDiagnostic({ rows, requestEvidence }: { rows: readonly LocalRow[]; requestEvidence(row: LocalRow): PublishRequestEvidence | undefined }) {
  const [selected, select] = useState<string>()
  const failures = rows.filter((row) => row.submission?.state === "unconfirmed" || row.submission?.state === "rejected")
  const row = failures.find((entry) => entry.id === selected) ?? failures[0]
  if (!row) return null
  const reference = currentLocalPublishDiagnostic(row)
  const receipt = row.submission?.receipt as { code?: string } | undefined
  const problem = row.submission?.state === "unconfirmed"
    ? { platform: "ozon", stage: "submit", family: "control" as const, code: "result_unconfirmed" }
    : { platform: "ozon", stage: "submit", family: "draft_skip" as const, code: receipt?.code ?? "blocked" }
  const resolved = resolvePublishRemediation({ ...problem, traceId: reference?.traceId })
  const remediation = resolved && { ...resolved, diagnosticId: reference?.diagnosticId, traceId: reference?.traceId }
  const evidence = requestEvidence(row)
  return <section aria-label="实际失败行诊断" data-row-id={row.id} data-row-position={row.position}
    data-diagnostic-id={reference?.diagnosticId} data-trace-id={reference?.traceId} className="flex flex-col gap-2"
    onClickCapture={(event) => {
      if ((event.target as HTMLElement).closest("summary")) {
        const measured = beginAction("diagnostic-details")
        const detail = reference?.diagnosticId ? getDiagnosticDetail(reference.diagnosticId) : null
        recordNative("diagnostic-details", { rowId: row.id, revision: row.rev, position: row.position,
          diagnosticId: reference?.diagnosticId, traceId: reference?.traceId, payloadSha256: detail?.event?.payload_sha256,
          hasOriginal: detail?.hasOriginal ?? false, summary: detail?.event?.summary })
        void endAction(measured)
      }
    }}>
    <label>选择实际失败商品<select value={row.id} onChange={(event) => {
      const measured = beginAction("diagnostic-select"); select(event.target.value); void endAction(measured)
    }}>{failures.map((entry) => <option key={entry.id} value={entry.id}>第 {entry.position + 1} 行 · {entry.storeId}</option>)}</select></label>
    {remediation && <PublishRemediation remediation={remediation} />}
    {evidence && <div data-request-cause={evidence.requestCause?.kind} data-request-status={evidence.requestCause?.status}
      data-request-trace={evidence.requestCause?.traceId}><PublishRemediation remediation={requestEvidenceRemediation(evidence)} /></div>}
  </section>
}
