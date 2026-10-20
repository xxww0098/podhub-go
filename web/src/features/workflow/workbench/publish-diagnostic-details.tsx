import { useContext, useReducer, useState } from "react"
import { Button } from "@/components/ui/button"
import { getDiagnosticCopyData, getDiagnosticDetail } from "@/lib/error-telemetry"
import type { DiagnosticDetail, OriginalUnavailableReason } from "@/lib/diagnostic-memory"
import { notifyCommandError } from "@/lib/notify"
import { PublishDiagnosticReporterContext, type PublishDiagnosticReporter } from "../submit/use-publish-diagnostics"

/** Two read-only ports let bounded-memory tests exercise the real UI handler. */
export type PublishDiagnosticReadPorts = Readonly<{
  getDiagnosticDetail: typeof getDiagnosticDetail
  getDiagnosticCopyData: typeof getDiagnosticCopyData
}>
export type PublishDiagnosticDetailsProps = {
  diagnosticId?: string
  traceId?: string
  readPorts?: PublishDiagnosticReadPorts
  /** A real active-route binding; absence leaves this component read-only. */
  onReportDiagnostic?: PublishDiagnosticReporter
}
const reads: PublishDiagnosticReadPorts = { getDiagnosticDetail, getDiagnosticCopyData }
const unavailableCopy = {
  no_exact_payload: "本次没有取得确切 payload，未保留原文；只能复制批准的诊断元数据。",
  oversize: "确切 payload 超过单条 8 MiB 的本机保留上限；只能复制元数据与已有的完整哈希。",
  expired: "原文已超过 30 分钟的本机保留期限；只能复制元数据与已有的完整哈希。",
  byte_limit: "本机诊断内存达到保留上限，原文已释放；只能复制元数据与已有的完整哈希。",
  not_retained: "该诊断记录已不在当前账户的本机内存中；不能读取或复制先前的原文。",
} satisfies Record<OriginalUnavailableReason, string>
const copyFailure = "诊断信息未复制；请允许浏览器访问剪贴板后重试，或手动复制详情中的编号与哈希"

export function safeDiagnosticIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined
}

function sameRecord(id: string, detail: DiagnosticDetail): DiagnosticDetail {
  if (detail.diagnosticId === id && (!detail.event || detail.event.diagnostic_id === id)
    && (detail.event || !detail.hasOriginal)) return detail
  return { diagnosticId: id, event: null, hasOriginal: false, originalUnavailableReason: "not_retained" }
}

/** Never reads or caches an original during render. Opening the containing
 * remediation rerenders this read-only view; copy takes a new identity read. */
export function PublishDiagnosticDetails({ diagnosticId, traceId, readPorts = reads, onReportDiagnostic }: PublishDiagnosticDetailsProps) {
  const [, refresh] = useReducer((version: number) => version + 1, 0)
  const reporter = useContext(PublishDiagnosticReporterContext)
  const report = onReportDiagnostic ?? reporter
  const [reporting, setReporting] = useState(false)
  const id = safeDiagnosticIdentifier(diagnosticId)
  const trace = safeDiagnosticIdentifier(traceId)
  if (!id && !trace) return null
  const detail = id ? sameRecord(id, readPorts.getDiagnosticDetail(id)) : null
  const event = detail?.event
  const originalStatus = detail?.hasOriginal
    ? "原文仅在本机内存中保留；明确复制时才带出，不在页面显示。"
    : unavailableCopy[detail?.originalUnavailableReason ?? "not_retained"]

  return (
    <div data-slot="publish-diagnostic-details" className="mt-1 flex flex-col gap-1"
      onClick={(gesture) => gesture.stopPropagation()}>
      <dl className="flex flex-col gap-1 leading-4">
        {id ? <div><dt className="text-muted-foreground">诊断编号</dt>
          <dd className="break-words font-mono">{id}</dd></div> : null}
        <div><dt className="text-muted-foreground">请求追踪编号</dt>
          <dd className="break-words font-mono">{id ? event?.trace_id ?? "当前记录不可用" : trace}</dd></div>
        {detail ? <>
          <div><dt className="text-muted-foreground">完整 payload SHA-256</dt>
            <dd className="break-words font-mono">{event?.payload_sha256 ?? (event
              ? "本次未取得确切 payload，没有完整哈希。" : "当前诊断记录不可用，无法读取完整哈希。")}</dd></div>
          {event ? <>
            <div><dt className="text-muted-foreground">诊断位置</dt>
              <dd className="break-words">{event.platform} / {event.stage} / {event.code}{event.field ? ` / ${event.field}` : ""}</dd></div>
            <div><dt className="text-muted-foreground">发生时间</dt><dd>{event.occurred_at}</dd></div>
            <div><dt className="text-muted-foreground">批准的字段摘要</dt><dd>
              {event.summary.length ? <ul className="flex flex-col gap-1">
                {event.summary.map((field) => <li key={field.field} className="break-words">
                  {field.field}：类型 {field.value_type}；长度 {field.length ?? "不适用"}
                  {field.field_id !== null ? `；字段编号 ${field.field_id}` : ""}
                  {field.enum_value !== null ? `；枚举 ${field.enum_value}` : ""}
                </li>)}
              </ul> : "本次没有可展示的批准字段摘要。"}
            </dd></div>
          </> : null}
          <div><dt className="text-muted-foreground">本机原文</dt><dd className="break-words">{originalStatus}</dd></div>
        </> : null}
      </dl>
      <div><Button type="button" size="xs" variant="outline" onClick={(gesture) => {
        gesture.stopPropagation()
        try {
          // Read and initiate the write in this gesture's stack. Never await a
          // hash, permission check, fetch or deferred callback with an original.
          const current = id ? readPorts.getDiagnosticCopyData(id) : null
          const fresh = current && id ? sameRecord(id, current.detail) : null
          const source = fresh?.event
          const retained = !!source && fresh?.hasOriginal === true && typeof current?.originalJson === "string"
            && (current?.provenance === "native_freeze" || current?.provenance === "submitted_http_body")
          const text = JSON.stringify(fresh ? {
            diagnosticId: fresh.diagnosticId, traceId: source?.trace_id ?? null,
            platform: source?.platform ?? null, stage: source?.stage ?? null, field: source?.field ?? null,
            code: source?.code ?? null, occurredAt: source?.occurred_at ?? null,
            payloadSha256: source?.payload_sha256 ?? null,
            summary: source?.summary.map((field) => ({ field: field.field, fieldId: field.field_id,
              valueType: field.value_type, length: field.length, enumValue: field.enum_value })) ?? [],
            hasOriginal: retained, originalUnavailableReason: retained ? null : fresh.originalUnavailableReason ?? "not_retained",
            provenance: source ? current?.provenance ?? null : null,
            originalJson: retained ? current?.originalJson ?? null : null,
          } : { traceId: trace })
          void navigator.clipboard.writeText(text).catch(() => notifyCommandError(undefined, copyFailure))
        } catch {
          notifyCommandError(undefined, copyFailure)
        }
        refresh()
      }}>复制诊断信息</Button></div>
      {id && event && report ? <div><Button type="button" size="xs" variant="outline" disabled={reporting}
        onClick={(gesture) => {
          gesture.stopPropagation()
          // The route binding synchronously rechecks identity and claims its bounded window.
          setReporting(true)
          void report(id).catch(() => notifyCommandError(undefined, "诊断上报未完成；请保持联网，在当前工作台明确重试上报"))
            .finally(() => { setReporting(false); refresh() })
        }}>上报诊断信息</Button></div> : null}
    </div>
  )
}
