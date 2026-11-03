import type { WorkflowProductLifecycle } from "@/bindings/commands"

export type AcceptedPublishCopy = { label: string; detail: string; failed: boolean }

type AcceptedFailureFacts = Partial<Pick<WorkflowProductLifecycle, "revision" | "last_error_code" | "submission_issue">>

/** A current asynchronous import failure does not undo the accepted receipt. */
export function acceptedFailureIssue(lifecycle: AcceptedFailureFacts) {
  const issue = lifecycle.submission_issue
  return lifecycle.revision !== undefined && Number.isSafeInteger(lifecycle.revision) && lifecycle.revision >= 0
    && lifecycle.last_error_code === "OZON_ROW_REJECTED" && issue?.code === "OZON_ROW_REJECTED"
    && issue.phase === "submit" && issue.resolved_at_ms == null && issue.input_revision === lifecycle.revision
    ? issue : undefined
}

const ACCEPTED: AcceptedPublishCopy = {
  label: "已受理",
  detail: "Ozon 已受理，后续审核与可售以卖家后台为准。",
  failed: false,
}

const CREATED_FROM_MIRROR: AcceptedPublishCopy = {
  label: "商品已创建",
  detail: "商品镜像已有该货号的 SKU，可售状态仍需核对。",
  failed: false,
}

/**
 * What the workbench shows after Ozon has accepted the import.
 * A missing follow-up keeps the previous sentences. Import and moderation
 * failures stay on this accepted row; they do not open another send.
 */
export function acceptedPublishCopy(
  lifecycle: Pick<WorkflowProductLifecycle, "ozon_sku" | "importFollowup"> & AcceptedFailureFacts,
): AcceptedPublishCopy {
  const issue = acceptedFailureIssue(lifecycle)
  if (issue) return { label: "受理后未通过", detail: issue.summary.trim() || "请到卖家后台核对处理，勿重复发送。", failed: true }
  const follow = lifecycle.importFollowup
  const detail = follow?.detail?.trim()
  if (follow && detail) {
    switch (follow.phase) {
      case "import_failed":
        return { label: "导入未通过", detail, failed: true }
      case "moderation_failed":
        return { label: "审核未通过", detail, failed: true }
      case "created":
        return { label: "商品已创建", detail, failed: false }
      case "moderating":
      case "pending":
      case "skipped":
        // A positive SKU from the product mirror is the later observation.
        // A recorded import or moderation failure stays visible instead.
        if ((lifecycle.ozon_sku ?? 0) > 0) return CREATED_FROM_MIRROR
        if (follow.phase === "moderating") return { label: "审核中", detail, failed: false }
        if (follow.phase === "skipped") return { label: "未更新", detail, failed: false }
        return { label: "导入处理中", detail, failed: false }
      default:
        break
    }
  }
  if ((lifecycle.ozon_sku ?? 0) > 0) return CREATED_FROM_MIRROR
  return ACCEPTED
}
