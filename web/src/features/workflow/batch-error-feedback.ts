import { createErrorFeedback, errorTransportContext, reportFeedback, type ErrorFeedback } from "@/lib/error-feedback"
import { listingMediaSummary } from "@/lib/error-report-environment"
import { refusalPair } from "@/lib/listing-refusal"
import type { ListingRow } from "./model/listing-row"
import { peekListingWorkbench } from "./workbench/listing-workbench-store"

/** One receipt per image and operation, shared by streamed and returned results. */
export function batchErrorFeedback(
  patchRow: (id: string, patch: Partial<ListingRow>) => void,
  context: { stage?: string; cardId?: string },
) {
  const receipts = new Map<string, ErrorFeedback | undefined>()
  return {
    has: (row: ListingRow) => receipts.has(row.draftId),
    settle(row: ListingRow, failed: boolean, reason: unknown, fallback: string) {
      if (receipts.has(row.draftId)) return receipts.get(row.draftId)
      const feedback = failed ? createErrorFeedback(reason ?? { message: fallback }, "图片处理失败，请查看处理建议。") : undefined
      receipts.set(row.draftId, feedback)
      patchRow(row.id, { errorFeedback: feedback })
      if (feedback) {
        const pair = refusalPair(reason)
        const workbench = peekListingWorkbench()
        const media = listingMediaSummary(workbench.productBases[row.draftId]?.lifecycle)
        reportFeedback(feedback, {
          ...errorTransportContext(reason),
          ...context,
          rowId: row.draftId,
          ...(pair ? { refusalReason: pair.refusal } : {}),
          ...(media ? { media } : {}),
        })
      }
      return feedback
    },
  }
}
