/** Cloud planning adapter: schema recovery, command replay and automation proof, never OCR purchase. */
import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { withListingSchemaSync } from "@/bindings/http-listing"
import { cancelledError } from "@/lib/error-message"
import { CONTROL_PLANE_TIMEOUT_MS, errorFields, PREPARATION_BUSY_RETRY, type AutomationExecutionScope, type PreparationPlan, type PreparationVerb } from "../execution-context"
import type { OcrModelRouting } from "../ocr-model-routing"
import { RENDERER_CONTRACT_VERSION } from "../media-job"
import { planStage } from "./capacity"

/** Same unlimited budget as `PREPARATION_BUSY_RETRY`, plus growth for short hints. */
export const PREPARE_BUSY_RETRY = { ...PREPARATION_BUSY_RETRY, paceShortHints: true } as const

/** Enqueue refusal bought no work. Give this known error the local busy-wait delay. */
export function queueBusy(reason: unknown): boolean {
  return errorFields(reason).code === "cloud_queue_busy"
}

export async function planRow(rowId: string, operation: PreparationVerb, shouldStop: () => boolean, commandId: string, feedback?: { onWait?: () => void, onReady?: (waitedMs: number) => void }, automationScope?: AutomationExecutionScope, modelRouting?: OcrModelRouting): Promise<PreparationPlan> {
  return planStage(async () => {
    try {
      return await withListingSchemaSync(rowId, () => {
        if (shouldStop()) throw cancelledError()
        // The automation scope proof is a header, not a body field: operation
        // + runtime + claim epoch fence the paid boundary while `commandId`
        // still owns plan idempotency.
        const scopeHeaders: Record<string, string> = {}
        if (automationScope) {
          scopeHeaders["X-Automation-Operation"] = automationScope.operationId
          scopeHeaders["X-Automation-Runtime"] = automationScope.runtimeId
          scopeHeaders["X-Automation-Claim-Epoch"] = String(automationScope.claimEpoch)
        }
        return request<PreparationPlan>("POST", route("listingRowsByIdPrepare", { id: rowId }), {
          operation, renderer_contract_version: RENDERER_CONTRACT_VERSION, command_id: commandId,
          ...((operation === "prepare" || operation === "recognize") && modelRouting ? { model_routing: modelRouting } : {}),
        } satisfies components["schemas"]["PrepareListingRowRequest"], scopeHeaders, CONTROL_PLANE_TIMEOUT_MS)
      })
    } catch (reason) {
      if (queueBusy(reason)) {
        const refusal = reason as { retryAfterMs?: number }
        refusal.retryAfterMs ??= 5_000
      }
      throw reason
    }
  }, feedback)
}
