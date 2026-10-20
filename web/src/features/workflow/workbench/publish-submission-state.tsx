import { useState } from "react"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { probeListingIntent } from "@/bindings/http-listing-intents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { notifyCommandError } from "@/lib/notify"
import { acceptedPublishCopy } from "../model/accepted-status"
import { UNKNOWN_PUBLISH_FALLBACK } from "../model/workflow-readiness"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { reconcilePhase, reconcileScheduleText } from "./reconcile-filter"
import { PublishRemediation } from "./publish-remediation"

export function submissionStateCopy(lifecycle: WorkflowProductLifecycle): {
  label: string
  detail: string
  failed?: boolean
} {
  switch (lifecycle.stage) {
    case "publish_rejected":
      return { label: "发布失败", detail: "请查看失败原因，处理后再提交。", failed: true }
    case "outcome_unknown": {
      const recorded = lifecycle.last_error_detail?.trim()
      return {
        label: reconcilePhase(lifecycle) === "needs_manual" ? "需人工核对" : "核对中",
        detail: recorded?.includes("自动核对") ? recorded : UNKNOWN_PUBLISH_FALLBACK,
      }
    }
    case "operator_attested":
      return { label: "待核对", detail: "已人工封存，尚未确认商品可售。" }
    case "accepted":
      return acceptedPublishCopy(lifecycle)
    case "queued":
      return { label: "等待发送", detail: "已加入发送队列，尚未提交给 Ozon。" }
    case "submitting":
      return { label: "正在发送", detail: "正在提交给 Ozon，等待受理结果。" }
    default:
      return { label: "待核对", detail: "已有提交记录，请核对最新商品状态。" }
  }
}

export function PublishSubmissionState({ lifecycle, rowLog, ownsRemediation = true }: {
  lifecycle: WorkflowProductLifecycle
  rowLog?: string
  /**
   * Standalone, a rejected or unresolved submission carries its own
   * 解决此行发布问题 guidance (no actions: it holds no row callbacks). A parent
   * that renders the row's remediation itself passes `false`, so the cell
   * never shows the same guidance twice.
   */
  ownsRemediation?: boolean
}) {
  const state = submissionStateCopy(lifecycle)
  const schedule = lifecycle.stage === "outcome_unknown"
    ? reconcileScheduleText(lifecycle.importProbe)
    : undefined
  const scheduleLine = schedule && state.detail.includes("已核对")
    ? schedule.replace(/^已核对 \d+ 次(?:，)?/, "")
    : schedule
  const canProbe = reconcilePhase(lifecycle) === "needs_manual" && Boolean(lifecycle.run_id)
  const [probing, setProbing] = useState(false)
  const probeAgain = async () => {
    if (!lifecycle.run_id || probing) return
    setProbing(true)
    try {
      await probeListingIntent(lifecycle.run_id)
    } catch (reason) {
      notifyCommandError(reason, "按货号核对失败，请重试")
    } finally {
      setProbing(false)
    }
  }
  const remediation = ownsRemediation
    ? resolvePublishRemediation({ lifecycle, rowLog: rowLog ?? "" })
    : undefined
  const receipt = lifecycle.submissionReceipt
  const copyResponse = async () => {
    try {
      await navigator.clipboard.writeText(receipt?.response_body ?? "")
    } catch (reason) {
      notifyCommandError(reason, "复制响应失败，请重试")
    }
  }
  const failure = state.failed ? remediation?.reason : undefined
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
      <Badge variant={state.failed ? "destructive" : "outline"}>{state.label}</Badge>
      <p className="text-meta text-muted-foreground">{state.detail}</p>
      {scheduleLine ? <p className="text-meta text-muted-foreground">{scheduleLine}</p> : null}
      {canProbe ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={probing}
          aria-busy={probing}
          aria-label="按货号再核对一次，只查询不重发"
          onClick={(event) => {
            event.stopPropagation()
            void probeAgain()
          }}
        >
          {probing ? "正在查询" : "按货号再核对"}
        </Button>
      ) : null}
      {remediation ? <PublishRemediation remediation={remediation} /> : null}
      <details className="max-w-full text-meta" onClick={(event) => event.stopPropagation()}>
        <summary className="cursor-pointer text-muted-foreground">{state.failed ? "查看失败详情" : "查看提交详情"}</summary>
        <div className="mt-2 flex flex-col gap-1">
          {failure ? <p>{failure}</p> : null}
          {remediation?.traceId ? <p>请求追踪编号：{remediation.traceId}</p> : null}
          {lifecycle.taskId ? <p>平台任务：{lifecycle.taskId}</p> : null}
          {(lifecycle.ozon_sku ?? 0) > 0 ? <p>商品 SKU：{lifecycle.ozon_sku}</p> : null}
          {receipt ? <>
            <p>提交批次：{receipt.batch_id} · {receipt.item_count} 件</p>
            <p>接口响应：HTTP {receipt.http_status ?? "未知"}（不代表商品已可售）</p>
            <pre className="max-h-28 max-w-full overflow-auto whitespace-pre-wrap font-mono text-xs" aria-label="平台响应文本">{receipt.response_body === "" ? "（响应正文为空）" : receipt.response_body ?? "未取得响应"}</pre>
            {receipt.response_body ? <Button type="button" size="xs" variant="outline" onClick={() => void copyResponse()}>复制响应</Button> : null}
          </> : null}
        </div>
      </details>
    </div>
  )
}
