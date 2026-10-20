/**
 * Local confirm and OCR plans. The rules live in `listing-core` and reach the
 * browser only through `listing-core-wasm` op 16. This file does not restate them.
 */
import { sharedListingCore } from "@/listing-core/client"
import type {
  ConfirmCandidate,
  ConfirmPlan,
  ConfirmRetryPlan,
  OcrFacts,
  OcrPlan,
} from "@/listing-core/types"

export type { ConfirmCandidate, ConfirmPlan, ConfirmRetryPlan, OcrFacts, OcrPlan }

export function planConfirm(candidates: readonly ConfirmCandidate[]): Promise<ConfirmPlan> {
  return sharedListingCore().planStage({ kind: "confirm", candidates: [...candidates] })
}

export function planConfirmRetry(reason: unknown): Promise<ConfirmRetryPlan> {
  const error = reason as { status?: number; code?: string; outcomeUnknown?: boolean } | null
  return sharedListingCore().planStage({
    kind: "confirmRetry",
    status: typeof error?.status === "number" ? error.status : 0,
    code: typeof error?.code === "string" ? error.code : "",
    outcomeUnknown: error?.outcomeUnknown === true,
  })
}

export function planOcr(facts: OcrFacts): Promise<OcrPlan> {
  return sharedListingCore().planStage({ kind: "ocr", facts })
}
