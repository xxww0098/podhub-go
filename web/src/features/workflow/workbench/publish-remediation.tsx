import type { ErrorFeedback } from "@/lib/error-feedback"
import { useReducer } from "react"
import { Button } from "@/components/ui/button"
import type { PreparationVerb } from "../prepare/preparation-tracks"
import type { PublishRemediation as PublishRemediationModel } from "../model/publish-remediation"
import { PublishDiagnosticDetails, safeDiagnosticIdentifier } from "./publish-diagnostic-details"

/** What the details block shows: plain words plus at most one safe action. */
export type RemediationView = {
  traceId?: string
  diagnosticId?: string
  reason: string
  scope: string
  steps: readonly string[]
  feedback?: ErrorFeedback
  action?: { label: string; run: () => void }
}

/**
 * One collapsed block: 原因 / 影响范围 / 处理步骤. It knows nothing about any
 * platform or error code — the resolver owns the words, the caller owns the
 * action — and it never fetches. Clicks stay inside the cell so the row does
 * not take them as a focus or selection gesture.
 */
export function RemediationDetails({
  view,
  summary = "解决此行发布问题",
}: {
  view: RemediationView
  summary?: string
}) {
  const action = view.feedback?.outcome === "unknown" ? undefined : view.action
  const [, refreshDiagnostic] = useReducer((version: number) => version + 1, 0)
  return (
    <details
      className="max-w-full text-meta"
      data-slot="publish-remediation"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => { if (event.currentTarget.open && view.diagnosticId) refreshDiagnostic() }}
    >
      <summary className="cursor-pointer font-medium text-foreground">{summary}</summary>
      <dl className="mt-1 flex flex-col gap-1 leading-4">
        <div>
          <dt className="text-muted-foreground">原因</dt>
          <dd className="break-words text-foreground">{view.feedback?.summary ?? view.reason}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">影响范围</dt>
          <dd className="break-words text-foreground">{view.scope}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{view.feedback ? "建议" : "处理步骤"}</dt>
          <dd>
            <ol className="list-decimal pl-4 text-foreground">
              {(view.feedback?.outcome === "unknown" ? ["刷新核对结果，请勿重复提交。"] : view.steps).map((step) => <li key={step} className="break-words">{step}</li>)}
            </ol>
          </dd>
        </div>
        {view.feedback ? <div><dt className="text-muted-foreground">编号</dt>
          <dd className="break-words font-mono">{view.feedback.errorId}</dd></div> : null}
      </dl>
      {view.diagnosticId || view.traceId ? <details>
        <summary className="cursor-pointer text-muted-foreground">技术详情</summary>
        <PublishDiagnosticDetails diagnosticId={view.diagnosticId} traceId={view.traceId} />
      </details> : null}
      {action ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="mt-1"
          onClick={(event) => {
            event.stopPropagation()
            action.run()
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </details>
  )
}

/** The row's existing callbacks; an absent one means that action is not offered. */
export type RemediationHandlers = {
  onRepairBrand?: () => void
  onRetryStage?: (verb: PreparationVerb) => void
  onReviewCandidates?: () => void
}

/**
 * Bind a resolved remediation to the row's own callbacks. The action survives
 * only when its callback exists, so a policy the caller did not wire can never
 * surface as a button.
 */
export function remediationView(
  remediation: PublishRemediationModel,
  handlers: RemediationHandlers,
): RemediationView {
  const { reason, scope, steps, action, traceId, diagnosticId } = remediation
  const view: RemediationView = { reason, scope, steps, traceId, diagnosticId: safeDiagnosticIdentifier(diagnosticId) }
  if (!action) return view
  switch (action.kind) {
    case "repair_brand": {
      const run = handlers.onRepairBrand
      return run ? { ...view, action: { label: action.label, run } } : view
    }
    case "retry_stage": {
      const retry = handlers.onRetryStage
      return retry ? { ...view, action: { label: action.label, run: () => retry(action.verb) } } : view
    }
    case "review_candidates": {
      const run = handlers.onReviewCandidates
      return run ? { ...view, action: { label: action.label, run } } : view
    }
  }
}

export function PublishRemediation({
  remediation,
  feedback,
  ...handlers
}: RemediationHandlers & { remediation: PublishRemediationModel; feedback?: ErrorFeedback }) {
  return <RemediationDetails view={{ ...remediationView(remediation, handlers), feedback }} />
}
