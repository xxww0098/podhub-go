import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ErrorFeedback } from "@/lib/error-feedback"
import { formatErrorId } from "@/lib/error-id"

/**
 * Shared error receipt for every error toast: what happened, what to do, and a
 * copyable diagnostic number. Technical codes and request IDs belong in
 * diagnostics, never here.
 */
export function ErrorFeedbackDescription({ feedback, description }: { feedback: ErrorFeedback; description?: string }) {
  const id = formatErrorId(feedback.errorId)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <dl className="mt-1.5 flex flex-col gap-1.5 text-meta">
      {description ? <div className="flex gap-2"><dt className="w-14 shrink-0 text-faint-foreground">详情</dt><dd className="min-w-0 break-words">{description}</dd></div> : null}
      {feedback.action ? <div className="flex gap-2"><dt className="w-14 shrink-0 text-faint-foreground">建议</dt><dd className="min-w-0 break-words">{feedback.action}</dd></div> : null}
      <div className="flex items-center gap-2 rounded-lg bg-muted/70 py-0.5 pr-0.5 pl-2.5">
        <dt className="shrink-0 text-faint-foreground">诊断编号</dt>
        <dd className="min-w-0 flex-1 select-text break-all font-mono">{id}</dd>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "已复制诊断编号" : "复制诊断编号"}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
    </dl>
  )
}
