import { notifyError } from "@/lib/notify"
import type { ErrorReportContext } from "@/lib/error-report-environment"
import { listingMediaSummary } from "@/lib/error-report-environment"
import { refusalPair } from "@/lib/listing-refusal"
import { peekListingWorkbench } from "../workbench/listing-workbench-store"
import { readSendHttpExchange, type SendHttpExchange } from "./send-ozon-transport"

type RefusalRow = {
  row_id: string
  blockers?: readonly unknown[]
  error?: { code?: string }
}

function blockerCode(row: RefusalRow): string {
  return refusalPair(row.error ?? { blockers: row.blockers })?.code ?? "submit_refused"
}

/** The toast's one error number. The summary is the focused row, not the batch body. */
export function sendRefusalNotice(
  row: RefusalRow,
  input: { cardId?: string; blockedRows?: number; lifecycle?: Parameters<typeof listingMediaSummary>[0]; exchange?: SendHttpExchange },
): { reason: unknown; context: ErrorReportContext } {
  const exchange = input.exchange
  const media = listingMediaSummary(input.lifecycle, input.blockedRows)
  const code = blockerCode(row)
  const refusal = refusalPair(row.error ?? { blockers: row.blockers })?.refusal ?? code
  return {
    reason: row.error ?? { code },
    context: {
      stage: "submit",
      rowId: row.row_id,
      refusalReason: refusal,
      ...(input.cardId ? { cardId: input.cardId } : {}),
      ...(exchange?.apiPath ? { apiPath: exchange.apiPath } : {}),
      ...(exchange?.apiStatus !== undefined ? { apiStatus: exchange.apiStatus } : {}),
      ...(exchange?.requestId ? { requestId: exchange.requestId } : {}),
      ...(media ? { media } : {}),
    },
  }
}

export function notifySendRefusal(message: string, row: RefusalRow, cardId: string | undefined, blockedRows: number): void {
  notifyError(message, sendRefusalNotice(row, {
    cardId, blockedRows,
    lifecycle: peekListingWorkbench().productBases[row.row_id]?.lifecycle,
    exchange: readSendHttpExchange(row),
  }))
}
