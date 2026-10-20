/**
 * Shared execution resources for the browser preparation executor: the
 * cooperative-stop registry, the OPFS device seam, the open card's template
 * context, browser job leases, the pending-upload reservation budget and the
 * small wire helpers every rail shares.
 *
 * These are single-owner module state: `activeBatches`, `pendingUploads`,
 * `device` and `cardContext` live only here; the AI, media and send rails
 * import them. Split file, same singletons.
 */
import { diagnosticProperty } from "@/lib/diagnostic-context"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { CommandError, WorkflowOperationOutcome } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { renderOpfs } from "@/bindings/render-opfs"
import { diagLog, elapsedMs, PREPARE_LOG, type DiagFields } from "@/lib/diag-log"
import { TRACE_ID_PATTERN } from "@/lib/utils"
import { renderClient } from "@/render/client"
import {
  dropRender,
  getRender,
  getSource,
  getTemplate,
  openStaticSliceCache,
  putRender,
  putSource,
  sha256Hex,
  writeStaticSlices,
} from "@/render/opfs"
import { tabLeaseScheduler } from "@/features/automation/lease-scheduler"

/**
 * The device half of a job. OPFS exists only in a browser, and gathering the
 * four calls here is what lets a test drive the routes above — the pin, the
 * relay key, the writeback shape — without one. The render worker needs no
 * wrapper: `renderClient` is already one object.
 */
export const device = {
  getSource,
  getTemplate,
  getRender,
  putRender,
  putSource,
  sha256Hex,
  dropRender,
  openStaticSliceCache,
  writeStaticSlices,
  stageSupplierTemplate: renderOpfs.workflowStageSupplierTemplate,
}

export const CONTROL_PLANE_TIMEOUT_MS = 35_000
export const STATUS_TIMEOUT_MS = 10_000
// A user's active batch waits for capacity until Stop; generic API retries stay bounded.
export const PREPARATION_BUSY_RETRY = { attempts: Infinity, maxWaitMs: Infinity } as const

/** Which rails a verb is allowed to carry out. `prepare` runs both. */
export type PreparationVerb = "recognize" | "slice" | "upload" | "prepare"

export const JOB_AI = "ai.recognize"
export const JOB_RENDER = "media.render"
export const JOB_UPLOAD = "media.upload"

/** Automation execution identity: the command, the claiming tab, its epoch. */
export type AutomationExecutionScope = {
  operationId: string
  runtimeId: string
  claimEpoch: number
}

/**
 * Cooperative stop. Unstarted items are skipped; the browser checks before the
 * paid OCR boundary and every Job. An in-flight request is allowed to settle
 * because it is already paid for.
 */
export type RowBatch = {
  modelRouting?: import("./ocr-model-routing").OcrModelRouting
  rows: Set<string>
  cancelled: Set<string>
  pinned: Set<string>
  verb: PreparationVerb
  uploadBatch?: Promise<import("../media/media-objects").MediaUploadBatch>
}

export const activeBatches = new Set<RowBatch>()
/** Waits `requestStop` re-checks at once; each one knows its own row. */
const stopWaiters = new Set<() => void>()
export function requestStop(rowIds: readonly string[]): void {
  for (const batch of activeBatches) {
    for (const rowId of rowIds) {
      if (batch.rows.has(rowId)) batch.cancelled.add(rowId)
    }
  }
  pendingUploads.interrupt()
  for (const wake of stopWaiters) wake()
}

/**
 * `wait`, cut short the moment `requestStop` stops this row — not at the next
 * poll — so no backoff stands between Stop and the cancel it sends.
 */
export function untilStopped(wait: Promise<unknown>, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { stopWaiters.delete(wake); resolve() }
    const wake = () => { if (stopped()) done() }
    stopWaiters.add(wake)
    wake()
    void wait.then(done, done)
  })
}

/** A busy-retry `sleep` that Stop ends at once; its timer never outlives it. */
export function stopAwareSleep(ms: number, stopped: () => boolean): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return untilStopped(new Promise((resolve) => { timer = setTimeout(resolve, ms) }), stopped)
    .finally(() => clearTimeout(timer))
}

/**
 * Draft ids the existing cancel helper should send. A running `prepare` or
 * `recognize` batch only cancels rows that already `/prepare` pinned and have not settled;
 * other verbs keep the all-ids cancel.
 */
export function cancelablePrepareDraftIds(draftIds: readonly string[]): string[] {
  const prepareRows = new Set<string>()
  const pinned = new Set<string>()
  for (const batch of activeBatches) {
    if (batch.verb !== "prepare" && batch.verb !== "recognize") continue
    for (const id of batch.rows) prepareRows.add(id)
    for (const id of batch.pinned) pinned.add(id)
  }
  if (prepareRows.size === 0) return [...draftIds]
  return draftIds.filter((id) => !prepareRows.has(id) || pinned.has(id))
}

export type BrowserLease = components["schemas"]["ListingBrowserJobLease"]

/** Timers may stall in a hidden tab: a local monotonic deadline also fences each boundary. */
export type LeaseFeedback =
  | { kind: "degraded", code?: string }
  | { kind: "recovered" }
  | { kind: "lost", code: string, remainingMs: number, elapsedMs: number }

export function keepBrowserLease(jobId: string, lease: BrowserLease, leaseSeconds: number, requestedAt: number, shouldStop: () => boolean, onHeartbeat?: (event: LeaseFeedback) => void) {
  let until = requestedAt + leaseSeconds * 1000
  let lost = false
  let disposed = false
  let degraded = false
  let lossReported = false
  const reportLoss = (code: string) => {
    if (disposed || lossReported) return
    lossReported = true
    lost = true
    onHeartbeat?.({ kind: "lost", code, remainingMs: Math.max(0, until - performance.now()), elapsedMs: elapsedMs(requestedAt) })
  }
  const assertCurrent = () => {
    if (lost || performance.now() >= until) {
      reportLoss("workflow_browser_lease_lost")
      throw Object.assign(new Error("准备作业的执行权已失效，请重新领取"), {
        code: "workflow_browser_lease_lost",
      })
    }
  }
  const stopRenew = tabLeaseScheduler().keep(`browser:${jobId}`, Math.max(1, leaseSeconds * 1000 / 3), async () => {
    if (disposed || lost) return
    const started = performance.now()
    try {
      assertCurrent()
      const valid = await api.post<boolean>(route("listingJobsByIdHeartbeat", { id: jobId }), lease, STATUS_TIMEOUT_MS)
      // A delayed response must never revive a tab whose local lease already expired.
      if (disposed) return
      assertCurrent()
      if (!valid) {
        reportLoss("workflow_browser_lease_lost")
      } else {
        until = started + leaseSeconds * 1000
        if (degraded) {
          degraded = false
          onHeartbeat?.({ kind: "recovered" })
        }
      }
    } catch (reason) {
      if (disposed) return
      // An unconfirmed renewal leaves the last confirmed deadline intact.
      const error = errorFields(reason)
      if (performance.now() < until) {
        if (!degraded) {
          degraded = true
          onHeartbeat?.({ kind: "degraded", code: error.code })
        }
      }
      if (performance.now() >= until) {
        reportLoss(error.code)
      }
    }
  })
  return {
    lease,
    assertCurrent,
    stopped: shouldStop,
    cancelled: () => lost || performance.now() >= until || shouldStop(),
    dispose: () => { disposed = true; stopRenew() },
  }
}
export type RenderBatch = ReturnType<typeof renderClient.createBatch>
export type BrowserExecution = ReturnType<typeof keepBrowserLease> & {
  workers: RenderBatch
  uncertainPurchases?: Set<string>
  feedback?: (state: "waiting" | "running" | "failed", message: string, fields?: DiagFields) => void
  /** Prepare-batch identity for upload byte totals. Not a Cloud id. */
  uploadAccount?: object
}

/** Local media has no Cloud execution lease; only the tab can stop its work. */
export type MediaExecution = Omit<BrowserExecution, "lease" | "uncertainPurchases">

// --- small shared helpers ---------------------------------------------------

/**
 * Rendered artifacts waiting for origin PUT. Full → new render waits without
 * a render slot; OCR keeps its own pool. listing-design.md §3.7.2.
 */
export const PENDING_UPLOAD_MAX_COUNT = 8
export const PENDING_UPLOAD_MAX_BYTES = 16 * 1024 * 1024

function createPendingUploads() {
  let count = 0
  let bytes = 0
  const held = new Map<string, number>()
  const waiting: Array<() => void> = []
  const limits = { maxCount: PENDING_UPLOAD_MAX_COUNT, maxBytes: PENDING_UPLOAD_MAX_BYTES }
  const wake = () => waiting.shift()?.()
  return {
    async acquire(rowId: string, cancelled?: () => boolean, feedback?: { onWait?: (stats: { count: number, maxCount: number, bytes: number, maxBytes: number }) => void, onReady?: (waitedMs: number, stats: { count: number, maxCount: number, bytes: number, maxBytes: number }) => void }): Promise<void> {
      const queuedAt = performance.now()
      const stats = () => ({ count, maxCount: limits.maxCount, bytes, maxBytes: limits.maxBytes })
      await new Promise<void>((resolve) => {
        const tryEnter = () => {
          // Both early exits consume this waiter's turn — wake the next one
          // first or the freed slot dies with us and every later waiter
          // stays pending until an unrelated release.
          if (cancelled?.()) { wake(); resolve(); return }
          if (held.has(rowId)) { wake(); resolve(); return }
          if (count < limits.maxCount && bytes < limits.maxBytes) {
            count += 1
            held.set(rowId, 0)
            resolve()
            wake()
            return
          }
          feedback?.onWait?.(stats())
          waiting.push(tryEnter)
        }
        tryEnter()
      })
      if (performance.now() > queuedAt) feedback?.onReady?.(elapsedMs(queuedAt), stats())
    },
    /** Re-check waiters after Stop. Does not drop held rows or wipe OPFS. */
    interrupt(): void {
      const pending = waiting.splice(0)
      for (const tryEnter of pending) tryEnter()
    },
    attach(rowId: string, size: number): void {
      if (!held.has(rowId)) {
        count += 1
        held.set(rowId, 0)
      }
      bytes += size
      held.set(rowId, (held.get(rowId) ?? 0) + size)
    },
    release(rowId: string): void {
      if (!held.has(rowId)) return
      bytes -= held.get(rowId) ?? 0
      held.delete(rowId)
      count -= 1
      wake()
    },
    releaseAll(rowIds: readonly string[]): void {
      for (const id of rowIds) this.release(id)
    },
    configure(next: Partial<typeof limits>): void { Object.assign(limits, next) },
    reset(): void {
      count = 0
      bytes = 0
      held.clear()
      waiting.splice(0)
    },
  }
}

export const pendingUploads = createPendingUploads()
export const configurePendingUploads = (next: { maxCount?: number, maxBytes?: number }) => pendingUploads.configure(next)
export const resetPendingUploads = () => pendingUploads.reset()

/** Keep validated transport correlation on browser-local errors without changing the wire model. */
export function errorFields(reason: unknown): CommandError & { traceId?: string; status?: number; serverCode?: string } {
  const code = diagnosticProperty(reason, "code")
  const message = diagnosticProperty(reason, "message")
  const remediation = diagnosticProperty(reason, "remediation")
  const traceId = diagnosticProperty(reason, "traceId")
  const serverCode = diagnosticProperty(reason, "serverCode")
  const status = diagnosticProperty(reason, "status")
  const codePattern = /^(?:[a-z]+:)?[A-Za-z0-9_.-]{1,64}$/
  return {
    code: typeof code === "string" && codePattern.test(code) ? code : "workflow_executor_failed",
    message: typeof message === "string" ? message : typeof reason === "string" ? reason : "图片处理失败",
    remediation: typeof remediation === "string" ? remediation : null,
    ...(typeof traceId === "string" && TRACE_ID_PATTERN.test(traceId) ? { traceId } : {}),
    ...(typeof serverCode === "string" && codePattern.test(serverCode) ? { serverCode } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  }
}

/**
 * One console line per row per stage, `[prepare] <stage> row=<id> …`, so a
 * batch that sits at 「AI 识别 0/75」 can be read off the console: which row
 * is in which stage, how long each took, and what a failure said.
 */
export function logStage(stage: string, rowId: string, fields: DiagFields = {}): void {
  diagLog(PREPARE_LOG, stage, { row: rowId, ...fields })
}

/** The 422 body `listing_api` writes when `prepare` or `send` is blocked. */
export function blockersOf(reason: unknown): string[] {
  const blockers = (reason as { blockers?: unknown })?.blockers
  return Array.isArray(blockers)
    ? blockers.map((blocker) => (typeof blocker === "string" ? blocker : JSON.stringify(blocker)))
    : []
}

export function isBlocked(reason: unknown): boolean {
  return blockersOf(reason).length > 0
}

/**
 * A 422 blocker as the sentence an operator can act on. Stable blockers are
 * plain codes; structured ones arrive as single-key JSON.
 */
export function operationBlockerMessage(blocker: string): string {
  let value: unknown = blocker
  try {
    value = JSON.parse(blocker)
  } catch {
    // Stable blockers are plain codes; structured blockers are JSON.
  }
  const key = typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)[0]
      : undefined
  switch (key) {
    case "missing_source_image": return "缺少源图，请重新导入原图片"
    case "missing_template": return "缺少 PSD 模板，请先选择模板再切片"
    case "missing_renderer_contract": return "切片配置不可用，请重新选择模板；仍失败请联系管理员"
    case "missing_delivery_contract": return "上传配置不可用，请联系管理员检查媒体存储配置"
    case "inconsistent_binding": return "源图或模板已变化，请重新切片并上传"
    case "missing_prompt": return "缺少识别提示词，请先配置提示词再识别"
    case "missing_media_account": return "尚未配置媒体存储，请联系管理员配置后再上传"
    case "missing_render_evidence": return "缺少已提交的切片，请先完成切片再上传"
    case "upload_plan_missing": return "无法生成上传计划，请重新切片；仍失败请联系管理员"
    case "candidates_unsettled": return "仍有 AI 候选未确认，请逐项确认或忽略后再发送"
    case "content_not_ready": return "识别尚未完成，请先完成识别并确认候选字段"
    case "media_not_ready": return "媒体尚未上传完成，请先完成切片和上传再发送"
    case "validation_stale": return "字段需要重新校验，请保存字段后再发送"
    case "validation_failed": return "字段校验未通过，请修正标记的字段并保存后再发送"
    case "submission_in_flight": return "发送任务正在进行，请等待结果，勿重复发送"
    case "needs_reconciliation": return "发送结果正在自动核对，确认未创建前勿直接重发"
    case "missing_cloud_identity": return "商品云端记录缺失，请刷新页面；仍缺失请联系管理员"
    case "orphaned_running_state": return "任务状态需要恢复，请刷新页面；仍未恢复请联系管理员"
    case "target_store_missing": return "商品尚未绑定目标店铺，请先绑定店铺后再发送"
    case "target_store_mismatch": return "商品绑定的店铺不一致，请选择该商品绑定的店铺后再发送"
    default: return "当前状态不允许执行"
  }
}

const OUTCOMES: Record<string, WorkflowOperationOutcome> = {
  running: "start",
  waiting: "wait",
  prepared: "noop",
  needs_review: "needs_review",
  blocked: "blocked",
}

export function outcomeOf(prepareOutcome: string): WorkflowOperationOutcome {
  return OUTCOMES[prepareOutcome] ?? "noop"
}

export interface RowSourceRef {
  sha256: string
  fileName: string
}

/**
 * What Cloud pinned this job to (`ListingRunView.payload`): the executor, the
 * revision, the source digest, the template digest and the renderer contract.
 * The browser acts on the pin rather than on whatever the open card holds now.
 */
export function jobPayload(job: components["schemas"]["ListingRunView"]): {
  pinnedRevision?: number
  sourceSha256?: string
  recognitionContractVersion?: string
  psdTemplateSha256?: string
  cardPayload?: { supplierProductId?: string, psdTemplateFileName?: string }
} {
  // The wire pins jobs with snake_case payload keys; the executor keeps its camel projection.
  const wire = (job.payload ?? {}) as {
    pinned_revision?: number
    source_sha256?: string
    recognition_contract_version?: string
    psd_template_sha256?: string
    card_payload?: { supplier_product_id?: string, psd_template_file_name?: string }
  }
  return {
    ...(wire.pinned_revision != null ? { pinnedRevision: wire.pinned_revision } : {}),
    ...(wire.source_sha256 != null ? { sourceSha256: wire.source_sha256 } : {}),
    ...(wire.recognition_contract_version != null ? { recognitionContractVersion: wire.recognition_contract_version } : {}),
    ...(wire.psd_template_sha256 != null ? { psdTemplateSha256: wire.psd_template_sha256 } : {}),
    ...(wire.card_payload != null ? { cardPayload: {
      ...(wire.card_payload.supplier_product_id != null ? { supplierProductId: wire.card_payload.supplier_product_id } : {}),
      ...(wire.card_payload.psd_template_file_name != null ? { psdTemplateFileName: wire.card_payload.psd_template_file_name } : {}),
    } } : {}),
  }
}

export function sourceOf(row: ListingRowView): RowSourceRef {
  return {
    sha256: row.source?.sha256 ?? "",
    fileName: row.source?.fileName ?? "",
  }
}

export type PreparationPlan = components["schemas"]["PrepareListingRowData"]
export type PreparationJob = components["schemas"]["ListingRunView"]

/**
 * The open card's template digest is a cheap preflight for Slice. Prepare
 * lets Cloud report a media blocker while it still admits recognition.
 * Actual execution always uses the Job's pinned template.
 */
export interface CardContext {
  psdTemplateSha256: string
}

let cardContext: CardContext = { psdTemplateSha256: "" }

export function setCardContext(next: CardContext): void {
  cardContext = next
}

export function currentCardContext(): CardContext {
  return cardContext
}
