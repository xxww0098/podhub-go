import type { ErrorFeedback } from "@/lib/error-feedback"

/** Receipts are created by operations, never by this read-only view. */
export function RowErrorFeedback({ feedback, unknownOutcome }: { feedback: ErrorFeedback; unknownOutcome: boolean }) {
  return (
    <details className="max-w-full text-meta" onClick={(event) => event.stopPropagation()}>
      <summary className="cursor-pointer font-medium">错误详情</summary>
      <dl className="mt-1 flex flex-col gap-1 leading-4">
        <div><dt className="text-muted-foreground">原因</dt><dd className="break-words">{feedback.summary}</dd></div>
        <div><dt className="text-muted-foreground">建议</dt>
          <dd className="break-words">{unknownOutcome || feedback.outcome === "unknown" ? "刷新核对结果，请勿重复提交。" : feedback.action ?? "请核对图片与配置；仍有问题时提供编号。"}</dd></div>
        <div><dt className="text-muted-foreground">编号</dt><dd className="break-words font-mono">{feedback.errorId}</dd></div>
      </dl>
    </details>
  )
}
