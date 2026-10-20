/**
 * The `ai.recognize` rail: pin-checked input preparation, the paid OCR
 * purchase under the Job's idempotency key, contract validation of the settled
 * answer, paid recovery, and the settle writeback. Runs under a
 * `BrowserExecution` lease from `execution-context.ts`.
 */
import { isBusyRefusal, retryWhenBusy } from "@/api/busy-retry"
import { api, request as apiRequest } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { WorkflowAiCandidate, WorkflowAiResult, WorkflowDraftValue } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { withListingSchemaSync } from "@/bindings/http-listing"
import { elapsedMs } from "@/lib/diag-log"
import { cancelledError } from "@/lib/error-message"
import { sharedListingCore, type OcrRetryClass } from "@/listing-core/client"
import { ListingCoreError } from "@/listing-core/wasm"
import type { RenderBytes } from "@/render/wasm"
import { isOcrImageMissing, prepareOcrImage, stageClaimedOcrImage, type OcrUploadBudget, type PreparedOcrImage } from "./ocr-upload"
import { recoverPaidOcr } from "./ocr-recovery"
export { analyzeImageBody } from "./ocr-upload"
import {
  CONTROL_PLANE_TIMEOUT_MS,
  device,
  errorFields,
  jobPayload,
  logStage,
  PREPARATION_BUSY_RETRY,
  sourceOf,
  STATUS_TIMEOUT_MS,
  type BrowserExecution,
  type PreparationJob,
  type RenderBatch,
} from "./execution-context"

/**
 * The image preprocessing and OCR output contract, checked against the Job.
 * The purchased result carries the actual model selected by Cloud.
 */
export const RECOGNITION_CONTRACT_VERSION = "browser-image-v1:ocr-fixed1-30-ai5-v2"

export const AI_CONCURRENCY = 8

/** Covers Cloud's 75s OCR deadline plus network slack. Abort is wait-only. */
export const OCR_FETCH_TIMEOUT_MS = 90_000

// --- idempotency ------------------------------------------------------------

// Cloud reconstructs the existing Chat Completions template internally after private verification.

/**
 * Exact image-tag count, matching `listing_core::ocr_contract` and `docs/ocr.md`.
 * Invalid counts are refused without padding or truncation.
 */
export const OCR_IMAGE_TAG_COUNT = 5
/** The one retry identity a Job owns beside its original key. */
export const OCR_RETRY_KEY_SUFFIX = ":retry"

export function ocrPurchaseKey(idempotencyKey: string, attempt: number): string {
  // A Job owns at most two purchase identities; every later attempt replays
  // the same retry identity and is answered from the stored fact (`docs/ocr.md`).
  return attempt > 1 ? `${idempotencyKey}${OCR_RETRY_KEY_SUFFIX}` : idempotencyKey
}

function draftValue(value: unknown): WorkflowDraftValue {
  if (typeof value === "string") return { kind: "text", value }
  if (typeof value === "boolean") return { kind: "boolean", value }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { kind: "integer", value }
      : { kind: "decimal", value }
  }
  if (Array.isArray(value)) {
    return { kind: "text_list", value: value.map((item) => JSON.stringify(item)) }
  }
  return { kind: "text", value: JSON.stringify(value) }
}

function candidateOf(raw: Record<string, unknown>): WorkflowAiCandidate {
  const fieldKey = typeof raw.field_key === "string" ? raw.field_key : ""
  const complexId = typeof raw.complex_id === "number" ? raw.complex_id : undefined
  const itemId = typeof raw.item_id === "string" ? raw.item_id : undefined
  return {
    address:
      complexId !== undefined && itemId !== undefined
        ? { kind: "complex", group_key: String(complexId), item_id: itemId, field_key: fieldKey }
        : { kind: "plain", field_key: fieldKey },
    value: draftValue(raw.value),
    source: "ai",
    state: "proposed",
  }
}

export class AiResultUnusable extends Error {
  readonly code = "workflow_ai_result_unusable"
  readonly contractKind: OcrRetryClass
  constructor(reason: string, contractKind: OcrRetryClass = "blind", costMicrofen = 0) {
    const billing = costMicrofen > 0 ? "本次识别已计费" : "本次未计费（预占已释放）"
    super(`AI 识别未通过：${reason}。${billing}，结果未写入商品。请联系管理员更新系统提示词后重新准备。`)
    this.name = "AiResultUnusable"
    this.contractKind = contractKind
  }
}

/**
 * One settled completion → the shared contract, in WASM, before settlement.
 *
 * Cloud runs the same `listing_core::ocr_contract::parse_completion` before
 * charging by default, and again at `ai/settle`. This call only decides the
 * one retry. The shared contract folds Latin
 * lookalikes, rewrites search tags into the required form, and classifies any
 * remaining violation.
 */
export async function parseAiCompletion(
  completion: unknown,
  model: string,
  costMicrofen = 0,
): Promise<WorkflowAiResult> {
  try {
    const parsed = await sharedListingCore().parseOcrAnswer(completion)
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates.map((raw) => candidateOf((raw ?? {}) as Record<string, unknown>))
      : []
    return {
      ru: parsed.ru,
      tags: parsed.tags,
      description: parsed.description,
      model,
      cost_microfen: costMicrofen,
      candidates,
    }
  } catch (error) {
    if (error instanceof ListingCoreError && error.code === "CORE_REFUSED") {
      throw new AiResultUnusable(error.message, error.retryClass, costMicrofen)
    }
    throw error
  }
}

export type PreparedAiInput = {
  jobId: string
  idempotencyKey: string
  prompt: string
  sourceSha256: string
  recognitionContractVersion: string
  body: PreparedOcrImage
  upload?: { uploadTicket: string }
  uploadBudget?: OcrUploadBudget
  release: () => void
}

// --- the recognition rail ---------------------------------------------------

/**
 * One recognition under the pin `prepare` took. Resolves to the row as Cloud
 * holds it after the settle and validation — the Draft with 名称 /
 * 简介 / tags in it — or `undefined` when Stop landed before the purchase.
 */
export async function runAiJob(
  row: ListingRowView,
  job: PreparationJob,
  execution: BrowserExecution,
  preparation: { input: PreparedAiInput } | { error: unknown },
): Promise<ListingRowView | undefined> {
  const jobId = job.id
  const idempotencyKey = job.idempotency_key
  const originalKey = ocrPurchaseKey(idempotencyKey, 1)
  const retryKey = ocrPurchaseKey(idempotencyKey, 2)
  let requestId: string | undefined
  let listingRow: ListingRowView | undefined
  try {
    if ("error" in preparation) throw preparation.error
    const prepared = preparation.input
    const pinned = jobPayload(job)
    if (!pinned.sourceSha256 || sourceOf(row).sha256 !== pinned.sourceSha256) {
      throw Object.assign(new Error("源图已变化，请重新准备该行"), { code: "workflow_source_changed" })
    }
    if (pinned.recognitionContractVersion !== RECOGNITION_CONTRACT_VERSION) {
      throw Object.assign(new Error("识图处理版本已变化，请刷新后重新准备"), { code: "workflow_recognition_contract_changed" })
    }
    if (job.id !== prepared.jobId || idempotencyKey !== prepared.idempotencyKey
      || pinned.sourceSha256 !== prepared.sourceSha256
      || pinned.recognitionContractVersion !== prepared.recognitionContractVersion
      || JSON.stringify((job.payload as { recognition_prompt?: unknown }).recognition_prompt) !== prepared.prompt) {
      throw Object.assign(new Error("领取的识图作业与预处理输入不一致，请重新准备"), { code: "workflow_ai_input_mismatch" })
    }
    execution.assertCurrent()
    if (execution.stopped()) return undefined
    // Local image preparation preceded claim; private staging is authorized only now.
    const uploadHeaders = {
      "X-Listing-Job-Id": jobId,
      "X-Listing-Lease-Owner": execution.lease.owner,
      "X-Listing-Lease-Epoch": String(execution.lease.epoch),
    }
    const budget = prepared.uploadBudget ??= { grants: 0, puts: 0, confirms: 0 }
    let body = prepared.upload ??= await stageClaimedOcrImage(prepared.body, uploadHeaders, execution, budget)
    const ocrStartedAt = performance.now()
    const purchase = async (key: string) => {
      const process = async () => {
        for (let attempt = 1; ; attempt++) {
          try { return await recognizeOnce(body, key, jobId, execution) }
          catch (reason) {
            if (!isOcrImageMissing(reason) || attempt >= 3) throw reason
            execution.assertCurrent()
            if (execution.stopped()) return Promise.reject(cancelledError())
            // Processing verification proved missing before any hold: re-stage, same paid key.
            prepared.upload = undefined
            body = prepared.upload = await stageClaimedOcrImage(prepared.body, uploadHeaders, execution, budget)
          }
        }
      }
      const once = await process()
      logStage("ai.ocr", row.id, {
        ms: elapsedMs(ocrStartedAt),
        model: once.result.model,
        cost_microfen: once.result.cost_microfen,
      })
      return once
    }
    try {
      // The key is the Job's own (`ListingRunView.idempotencyKey`), not a local
      // restatement of `recognize_job_key`: the kernel minted it at `prepare`
      // under the revision it pinned, and re-deriving it here after a re-read
      // would file the same work under a second key — a second purchase.
      ;({ requestId, listingRow } = await purchase(ocrPurchaseKey(idempotencyKey, job.attempt)))
    } catch (reason) {
      // A busy ceiling that Stop interrupted is not a failure of this row.
      if (isBusyRefusal(reason) && execution.stopped()) return undefined
      if (isBusyRefusal(reason)) throw reason
      if (isWritebackPending(reason)) {
        requestId = purchaseIdOf(reason) ?? requestId
      } else if (isContractUnusable(reason) && mayRetryContract(reason) && ocrPurchaseKey(idempotencyKey, job.attempt) === originalKey) {
        if (execution.stopped()) return undefined
        ;({ requestId, listingRow } = await purchase(retryKey))
      } else if (shouldRecoverOcr(reason)) {
        const recovered = await recoverPaidOcr({
          row, job, execution, originalKey: idempotencyKey, retryKey,
          recognize: (key) => recognizeOnce(body, key, jobId, execution),
          settle: (requestId) => settlePaidRow(row, jobId, execution, requestId),
          shouldRecover: shouldRecoverOcr, contractUnusable: isContractUnusable,
          shouldRetryContract: mayRetryContract,
          writebackPending: isWritebackPending, purchaseId: purchaseIdOf,
        })
        if (recovered === "paused") return undefined
        if (recovered) return recovered
        throw reason
      } else {
        throw reason
      }
    }
  } catch (reason) {
    if (isBusyRefusal(reason)) throw reason
    if (isOcrRecoveryPaused(reason)) {
      execution.feedback?.("waiting", "识图结果待核对，请稍后重新准备", { code: "workflow_ocr_recovery_paused" })
      return undefined
    }
    requestId = purchaseIdOf(reason) ?? requestId
    const lost = errorFields(reason).code === "workflow_browser_lease_lost"
    // Matching-epoch fail still closes `uncertain`. Skip only when nothing
    // was purchased — a lost local timer must not skip that write.
    if ((requestId || !lost) && !shouldRecoverOcr(reason)) {
      await api.post(route("listingRowsByIdAiFail", { id: row.id }), { job_id: jobId, lease: execution.lease }, CONTROL_PLANE_TIMEOUT_MS).catch(() => undefined)
    }
    if (execution.stopped()) return undefined
    throw reason
  }
  if (listingRow) return listingRow
  if (!requestId) {
    throw Object.assign(new Error("识图购买记录缺失，结果无法写入商品"), { code: "workflow_purchase_missing" })
  }
  return settlePaidRow(row, jobId, execution, requestId)
}

export async function prepareAiInput(row: ListingRowView, job: PreparationJob, workers: RenderBatch, shouldStop: () => boolean): Promise<PreparedAiInput> {
  const pinned = jobPayload(job)
  const snapshot = (job.payload as { recognition_prompt?: { content?: string, fixed_tags?: unknown } }).recognition_prompt
  if (!snapshot?.content?.trim()) throw new Error("识图作业缺少提示词快照，请重新准备")
  const tagCount = Array.isArray(snapshot.fixed_tags)
    ? snapshot.fixed_tags.filter(tag => typeof tag === "string").length
    : 0
  if (tagCount < 1) {
    throw new Error("识图作业缺少固定标签，请重新准备")
  }
  const source = sourceOf(row)
  if (!pinned.sourceSha256 || source.sha256 !== pinned.sourceSha256) {
    throw Object.assign(new Error("源图已变化，请重新准备该行"), { code: "workflow_source_changed" })
  }
  if (pinned.recognitionContractVersion !== RECOGNITION_CONTRACT_VERSION) {
    throw Object.assign(new Error("识图处理版本已变化，请刷新后重新准备"), { code: "workflow_recognition_contract_changed" })
  }
  if (shouldStop()) throw cancelledError()
  const bytes = await device.getSource(source.sha256, source.fileName)
  if (!bytes) throw Object.assign(new Error("本机没有该源图，请重新导入后再识别"), { code: "workflow_source_missing" })
  const sourceByteLength = bytes.byteLength
  const releaseSource = workers.occupy(sourceByteLength)
  const startedAt = performance.now()
  let image: RenderBytes
  try { image = await workers.prepareAiImage(bytes, shouldStop) }
  finally { releaseSource() }
  const releaseImage = workers.occupy(image.byteLength)
  try {
    logStage("ai.image", row.id, { ms: elapsedMs(startedAt), sourceBytes: sourceByteLength, imageBytes: image.length })
    if (shouldStop()) throw cancelledError()
    const body = prepareOcrImage(image)
    return {
      jobId: job.id, idempotencyKey: job.idempotency_key, prompt: JSON.stringify(snapshot),
      sourceSha256: pinned.sourceSha256, recognitionContractVersion: pinned.recognitionContractVersion,
      body, release: releaseImage,
    }
  } catch (reason) { releaseImage(); throw reason }
}

/**
 * One relay round trip under one key. Only an admission 429 — this
 * Workspace's own budget refusal, zero work done — throws as busy, so the AI
 * stage slot can be released for the wait (lease stays) and the same key is
 * asked again after backoff. An uncertain upstream failure never takes that
 * shape: it arrives as a terminal 502/504 carrying
 * "本次未计费，请更换新的 Idempotency-Key 重试", and the key is dead. It
 * flows into the same `unbilled_unknown` pause-recovery path
 * (`recoverPaidOcr`) — never a same-key retry, an automatic new-key purchase,
 * or a row failure. Only the `docs/ocr.md` §3 contract retry changes the key.
 */
async function recognizeOnce(body: unknown, idempotencyKey: string, jobId: string, execution: BrowserExecution): Promise<{ result: WorkflowAiResult, requestId: string, listingRow?: ListingRowView }> {
  execution.assertCurrent()
  if (execution.stopped()) throw cancelledError()
  const headers = {
    "Idempotency-Key": idempotencyKey,
    "X-Listing-Job-Id": jobId,
    "X-Listing-Lease-Owner": execution.lease.owner,
    "X-Listing-Lease-Epoch": String(execution.lease.epoch),
  }
  const readReceipt = () => retryWhenBusy(() => apiRequest<components["schemas"]["AiCompletionData"]>(
    "GET", route("aiOcrCompletions"), undefined, headers, STATUS_TIMEOUT_MS,
  ).catch(reason => {
    // A disconnected POST may not have committed its purchase record yet.
    if ((reason as { status?: number })?.status === 404) {
      throw Object.assign(new Error("正在核实已有识图结果"), { status: 429, retryAfterMs: 1000 })
    }
    throw receiptWait(reason)
  }), { attempts: 3, maxWaitMs: 60_000 })
  let completion: components["schemas"]["AiCompletionData"]
  try {
    completion = execution.uncertainPurchases?.has(idempotencyKey)
      ? await readReceipt()
      : await apiRequest("POST", route("aiOcrCompletions"), body, headers, OCR_FETCH_TIMEOUT_MS)
  } catch (reason) {
    if (shouldRecoverOcr(reason) || isWritebackPending(reason) || isContractUnusable(reason)) throw reason
    const pending = receiptWait(reason)
    if (!isBusyRefusal(pending) || isBusyRefusal(reason)) throw reason
    ;(execution.uncertainPurchases ??= new Set()).add(idempotencyKey)
    // Stop still permits this read-only receipt lookup and paid settlement.
    // No missing/failed receipt can turn this GET into a new purchase.
    completion = await readReceipt()
  }
  const billing = completion.billing
  if (!billing?.request_id || !billing.model) {
    throw Object.assign(new Error("识图购买记录缺失，结果无法写入商品"), { code: "workflow_purchase_missing" })
  }
  const requestId = billing.request_id
  // The generated completion wire leaves projection sections as `unknown`;
  // this row came from the same server projection consumed by the workbench.
  // Keep the nullable wire field explicit before handing it to the existing
  // narrowed view path.
  const listingRow = completion.listing_row as unknown as ListingRowView | null | undefined
  try {
    return {
      requestId,
      listingRow: listingRow ?? undefined,
      // Cost is the charged split — what settlement actually took out of the
      // balance — never the nominal total that includes absorbed relief.
      result: await parseAiCompletion(completion.completion, billing.model, billing.charged_microfen),
    }
  } catch (reason) {
    if (listingRow) return { requestId, listingRow, result: { ru: "", tags: [], description: "", model: billing.model, cost_microfen: billing.charged_microfen ?? 0, candidates: [] } }
    throw Object.assign(reason as object, { requestId })
  }
}

function isWritebackPending(reason: unknown): boolean {
  return errorFields(reason).code === "cloud_listing_writeback_pending"
}

export function isContractUnusable(reason: unknown): boolean {
  const code = errorFields(reason).code
  return code === "workflow_ai_result_unusable" || code === "cloud_ocr_contract_violation"
}

/** Language and tag-contract failures allow one correction; permanent refusals do not. */
export function mayRetryContract(reason: unknown): boolean {
  if (!isContractUnusable(reason)) return false
  const kind = (reason as { contractKind?: OcrRetryClass }).contractKind
  if (kind === "permanent") return false
  return true
}

export function isOcrRecoveryPaused(reason: unknown): boolean {
  return errorFields(reason).code === "workflow_ocr_recovery_paused"
}

function shouldRecoverOcr(reason: unknown): boolean {
  const code = errorFields(reason).code
  const status = (reason as { status?: number })?.status
  if (code === "cloud_listing_writeback_pending") return false
  // `cloud_request_unbilled_unknown` is the same-key replay answer for a
  // purchase that already ended `unbilled_unknown` — terminal for the key, a
  // new one is required — so it pauses into recovery like any other
  // uncertain shape, never fails the row or re-fires the purchase (04/D2).
  if (
    code === "cloud_unavailable"
    || code === "cloud_request_in_flight"
    || code === "cloud_upstream_unknown"
    || code === "cloud_request_unbilled_unknown"
  ) {
    return true
  }
  // An upstream-uncertain failure (upstream
  // 429/5xx/timeout) surfaces as 502/504 "本次未计费" — never 429 (D5).
  return status === 500 || status === 502 || status === 504
}

function receiptWait(reason: unknown): unknown {
  const code = errorFields(reason).code
  if (code === "cloud_request_in_flight") {
    return Object.assign(new Error("正在核实已有识图结果"), { code, status: 429, retryAfterMs: 1000 })
  }
  return reason
}

async function settlePaidRow(
  row: ListingRowView,
  jobId: string,
  execution: BrowserExecution,
  requestId: string,
): Promise<ListingRowView> {
  const settleStartedAt = performance.now()
  const settled = await retryWhenBusy(() => withListingSchemaSync([row], () => api.post<ListingRowView>(
    route("listingRowsByIdAiSettle", { id: row.id }),
    { job_id: jobId, lease: execution.lease, request_id: requestId },
    CONTROL_PLANE_TIMEOUT_MS,
  )).catch(reason => { throw receiptWait(reason) }), PREPARATION_BUSY_RETRY)
  logStage("ai.settle", row.id, {
    ms: elapsedMs(settleStartedAt),
    revision: settled.revision,
  })
  return settled
}

function purchaseIdOf(reason: unknown): string | undefined {
  const requestId = (reason as { requestId?: unknown })?.requestId
  return typeof requestId === "string" && requestId.trim() ? requestId : undefined
}
