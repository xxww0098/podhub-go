import type { ErrorFeedback } from "@/lib/error-feedback"

/** Shared compact receipt; technical codes and request IDs belong in diagnostics. */
export function ErrorFeedbackDescription({ feedback, description }: { feedback: ErrorFeedback; description?: string }) {
  return (
    <dl className="flex flex-col gap-1 text-meta">
      {description ? <div className="flex gap-2"><dt className="shrink-0">详情</dt><dd className="min-w-0 break-words">{description}</dd></div> : null}
      {feedback.action ? <div className="flex gap-2"><dt className="shrink-0">建议</dt><dd className="min-w-0 break-words">{feedback.action}</dd></div> : null}
      <div className="flex gap-2"><dt className="shrink-0">错误编号</dt><dd className="min-w-0 select-text break-all font-mono">{feedback.errorId}</dd></div>
    </dl>
  )
}
