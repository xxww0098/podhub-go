/**
 * Paid OCR receipt recovery. The purchase ledger stays on the server.
 * What to do with a receipt the browser already fetched is `planOcr`.
 */
import { isBusyRefusal } from "@/api/busy-retry"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { ListingRowView } from "@/bindings/listing-projection"
import type { OcrFacts } from "@/listing-core/types"
import { planOcr } from "./stage-plan"
import {
  STATUS_TIMEOUT_MS,
  stopAwareSleep,
  type BrowserExecution,
  type PreparationJob,
} from "./execution-context"

type Once = { requestId: string; listingRow?: ListingRowView }
type Attempt = NonNullable<ListingRowView["ocr_recovery"]>["attempts"][number]

export type OcrRecoveryDeps = {
  row: ListingRowView
  job: PreparationJob
  execution: BrowserExecution
  recognize: (key: string) => Promise<Once>
  settle: (requestId: string) => Promise<ListingRowView>
  shouldRecover: (reason: unknown) => boolean
  contractUnusable: (reason: unknown) => boolean
  shouldRetryContract: (reason: unknown) => boolean
  writebackPending: (reason: unknown) => boolean
  purchaseId: (reason: unknown) => string | undefined
  originalKey: string
  retryKey: string
}

function attemptOf(
  recovery: ListingRowView["ocr_recovery"] | undefined,
  attempt: "original" | "contract_retry",
): Attempt | undefined {
  return recovery?.attempts.find(item => item.attempt === attempt)
}

function hasDisplayText(view: ListingRowView): boolean {
  const ai = view.ai as { candidates?: unknown[] } | null
  if (Array.isArray(ai?.candidates) && ai.candidates.length > 0) return true
  return Object.keys(view.draft?.values ?? {}).length > 0
}

function factsOf(view: ListingRowView, original: Attempt | undefined, retry: Attempt | undefined): OcrFacts {
  return {
    hasRecovery: true,
    hasDisplayText: hasDisplayText(view),
    originalStatus: original?.status ?? "",
    originalUsable: original?.result_usable ?? undefined,
    originalRequestId: original?.request_id ?? "",
    retryStatus: retry?.status ?? "",
    retryUsable: retry?.result_usable ?? undefined,
    retryRequestId: retry?.request_id ?? "",
  }
}

const UNUSABLE = "AI 识别未通过：已计费，结果未写入商品。请联系管理员更新系统提示词后重新准备。"
/** Guarded billing (`CLOUD_OCR_BILLING_GUARD`): both refusals released their holds. */
const UNUSABLE_RELEASED = "AI 识别未通过：本次未计费（预占已释放），结果未写入商品。请联系管理员更新系统提示词后重新准备。"

/** Copy follows the money fact: only a settled attempt was charged. */
export function unusableMessage(original: Attempt | undefined, retry: Attempt | undefined): string {
  return original?.status === "settled" || retry?.status === "settled" ? UNUSABLE : UNUSABLE_RELEASED
}

export async function recoverPaidOcr(deps: OcrRecoveryDeps): Promise<ListingRowView | "paused" | undefined> {
  const { row, job, execution } = deps
  const deadline = performance.now() + 60_000
  let delayMs = 1_000
  const { originalKey, retryKey } = deps
  const wait = async () => {
    const ms = delayMs
    delayMs = Math.min(delayMs * 2, 10_000)
    await stopAwareSleep(ms, execution.stopped)
  }
  while (performance.now() < deadline) {
    if (execution.stopped()) return undefined
    execution.assertCurrent()
    execution.feedback?.("waiting", "正在核对已付费识图结果")
    const search = new URLSearchParams({ include: "ocrRecovery", jobId: job.id })
    let view: ListingRowView
    try {
      view = await api.get<ListingRowView>(
        `${route("listingRowsById", { id: row.id })}?${search}`,
        STATUS_TIMEOUT_MS,
      )
    } catch (reason) {
      if (deps.shouldRecover(reason) || isBusyRefusal(reason)) {
        await wait()
        continue
      }
      throw reason
    }
    if (!view.ocr_recovery) {
      await wait()
      continue
    }
    const original = attemptOf(view.ocr_recovery, "original")
    const retry = attemptOf(view.ocr_recovery, "contract_retry")
    const plan = await planOcr(factsOf(view, original, retry))
    execution.feedback?.(
      "waiting",
      plan.display === "show_local" ? "识图结果已在本机，正在核对购买记录" : "正在核对已付费识图结果",
    )
    if (plan.step === "settle" && plan.requestId) return deps.settle(plan.requestId)
    if (plan.step === "unusable") {
      throw Object.assign(new Error(unusableMessage(original, retry)), { code: "workflow_ai_result_unusable" })
    }
    if (plan.step === "simple_retry") {
      try {
        const once = await deps.recognize(retryKey)
        if (once.listingRow) return once.listingRow
        return deps.settle(once.requestId)
      } catch (reason) {
        if (deps.contractUnusable(reason)) throw reason
        if (deps.shouldRecover(reason) || isBusyRefusal(reason)) {
          await wait()
          continue
        }
        throw reason
      }
    }
    if (plan.step === "pause") return "paused"
    if (plan.step === "purchase_original") {
      try {
        const once = await deps.recognize(originalKey)
        if (once.listingRow) return once.listingRow
        return deps.settle(once.requestId)
      } catch (reason) {
        if (deps.writebackPending(reason)) {
          const pendingId = deps.purchaseId(reason)
          if (pendingId) return deps.settle(pendingId)
        }
        if (deps.contractUnusable(reason) && deps.shouldRetryContract(reason) && (!retry || retry.status === "absent")) {
          const once = await deps.recognize(retryKey)
          if (once.listingRow) return once.listingRow
          return deps.settle(once.requestId)
        }
        if (deps.shouldRecover(reason) || isBusyRefusal(reason)) {
          await wait()
          continue
        }
        throw reason
      }
    }
    await wait()
  }
  return "paused"
}
