/** One row's independent rails, bounded attempts and Cloud projections. Batch lifetime is owned by runRows. */
import { isBusyRefusal, retryWhenBusy } from "@/api/busy-retry"
import { api, type CloudRefusal } from "@/api/client"
import { route } from "@/api/routes"
import type { CommandError, WorkflowOperationRowResult, WorkflowPreparationProgress } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { readListingRow } from "@/bindings/http-listing"
import { elapsedMs, type DiagFields } from "@/lib/diag-log"
import { cancelledError } from "@/lib/error-message"
import { listingLog, listingRowFailureStage } from "@/lib/listing-log"
import { refusalPair } from "@/lib/listing-refusal"
import { rowStatusView } from "../../model/row-state"
import { cancelPrepareJobsForDrafts } from "../cancel-prepare-jobs"
import { isContractUnusable, isOcrRecoveryPaused, prepareAiInput, runAiJob, type PreparedAiInput } from "../ai-job"
import {
  blockersOf,
  errorFields,
  isBlocked,
  JOB_AI,
  JOB_RENDER,
  JOB_UPLOAD,
  keepBrowserLease,
  logStage,
  outcomeOf,
  pendingUploads,
  stopAwareSleep,
  untilStopped,
  type AutomationExecutionScope,
  type BrowserExecution,
  type MediaExecution,
  type PreparationJob,
  type PreparationPlan,
  type PreparationVerb,
  type RenderBatch,
  type RowBatch,
} from "../execution-context"
import { pendingUploadBytes, runMediaJob } from "../media-job"
import { preparationStage, RENDER_ISOLATION_ERROR } from "./capacity"
import type { ClaimCoordinator } from "./claim-coordinator"
import { planRow, PREPARE_BUSY_RETRY, queueBusy } from "./planning"
import { createRowFeedback, feedbackStageOf, waitLabel } from "./row-feedback"
import { authorizeBatchUpload } from "./upload-authorization"

const MAX_PREPARATION_ATTEMPTS = 3

function wants(verb: PreparationVerb, kind: string): boolean {
  if (verb === "prepare") return true
  if (verb === "recognize") return kind === JOB_AI
  return kind === JOB_RENDER || kind === JOB_UPLOAD
}

type StageWork = { kind: string, job: PreparationJob } | { kind: string, operation: PreparationVerb }

function operationForStage(kind: string): PreparationVerb {
  return kind === JOB_AI ? "recognize" : kind === JOB_RENDER ? "slice" : "upload"
}

/** Internal resource handoff: row state and retry ledgers never escape this module. */
type PreparationRowContext = Readonly<{
  shouldStop: () => boolean
  workers: RenderBatch
  batch: RowBatch
  claims: ClaimCoordinator
  onRow?: (row: WorkflowOperationRowResult) => void
  onRenderSettled?: () => void
  onPinReleased?: () => void
  automationScope?: AutomationExecutionScope
}>

/** Each claimed stage reports Cloud projections; its siblings settle independently. */
export async function runPreparationRow(rowId: string, verb: PreparationVerb, context: PreparationRowContext): Promise<WorkflowOperationRowResult> {
  const { shouldStop, workers, onRow, batch, claims, automationScope } = context
  let { onRenderSettled, onPinReleased } = context
  const { snapshot: progressSnapshot, set: setProgress, clear: clearProgress } = createRowFeedback(rowId, verb,
    progress => onRow?.({ ...started, preparation_progress: progress }))
  let started: WorkflowOperationRowResult = { row_id: rowId, outcome: "start", blockers: [], interim: true, preparation_progress: progressSnapshot() }

  // A new run must replace the previous run's transient browser feedback.
  onRow?.({ ...started, preparation_progress: progressSnapshot() })
  const commands = new Map<PreparationVerb, string>()
  const planCommand = (operation: PreparationVerb) => {
    if (!commands.has(operation)) commands.set(operation, crypto.randomUUID())
    return planRow(rowId, operation, shouldStop, commands.get(operation)!, {
      onWait: () => setProgress("plan", "waiting", "等待本机准备容量"),
      onReady: waitedMs => {
        setProgress("plan", "running", "正在准备计划")
        logStage("queue.ready", rowId, { stage: "plan", waitedMs, queue: "plan" })
      },
    }, automationScope, batch?.modelRouting).then(result => {
      if (verb === "prepare" || verb === "recognize") batch?.pinned.add(rowId)
      return result
    })
  }
  // Every pre-purchase busy wait ends the moment Stop lands, not at a poll.
  const busySleep = (ms: number) => stopAwareSleep(ms, shouldStop)
  const reportWaiting = (stage: WorkflowPreparationProgress["stage"] = "plan", retry?: { attempt: number, delayMs: number, status: number }) => {
    if (!shouldStop()) {
      const message = retry ? `自动重试 ${retry.status}，约 ${waitLabel(retry.delayMs)}后重试` : "等待云端准备队列"
      setProgress(stage, "waiting", message, { queue: "cloud", status: retry?.status, delay: retry?.delayMs, attempt: retry?.attempt })
      if (retry) logStage("retry.wait", rowId, { stage, status: retry.status, delayMs: retry.delayMs, attempt: retry.attempt })
      onRow?.({ ...started, outcome: "wait", noop_reason: "queue_busy", preparation_progress: progressSnapshot() })
    }
  }
  const settleRender = () => {
    onRenderSettled?.()
    onRenderSettled = undefined
  }
  const releasePin = () => {
    onPinReleased?.()
    onPinReleased = undefined
  }
  let plan: PreparationPlan
  try {
    plan = await retryWhenBusy(async () => {
      setProgress("plan", "running", "正在准备计划")
      try { return await planCommand(verb) }
      catch (reason) {
        if (!queueBusy(reason) || verb === "prepare") throw reason
        // Durable admission waits in this rail's execution pool. HTTP
        // admission refusals instead retry the short planning request here.
        const kind = verb === "recognize" ? JOB_AI : verb === "slice" ? JOB_RENDER : JOB_UPLOAD
        return { outcome: "running", jobs: [], issues: [{ kind, blockers: [], message: errorFields(reason).message }] }
      }
    }, { ...PREPARE_BUSY_RETRY, cancelled: shouldStop, sleep: busySleep, onWait: retry => reportWaiting("plan", retry) })
  } catch (reason) {
    settleRender()
    releasePin()
    if (shouldStop()) return { row_id: rowId, outcome: "noop", blockers: [], noop_reason: "cancelled" }
    if (isBusyRefusal(reason)) return { row_id: rowId, outcome: "wait", blockers: [], noop_reason: "queue_busy" }
    return { row_id: rowId, outcome: "blocked", blockers: blockersOf(reason), ...(!isBlocked(reason) ? { error: errorFields(reason) } : {}) }
  }
  // Cloud plans the independent AI and media rails against their current inputs.
  const jobs = plan.jobs.filter((job) => wants(verb, job.kind))
  clearProgress("plan")
  const blockers = (plan.issues ?? []).flatMap((issue) => blockersOf(issue))
  const failures: Array<{ kind: string, error: CommandError }> = []
  const stageAttempts = new Map<string, number>()
  // A replan under the same commandId replays the same Job, so a stage that
  // fails before claiming retries the replan — not the Job. `stageReplans`
  // bounds those cycles; `firstStageError` keeps the root-cause error that
  // started the retries, because the dead-Job refusal that ends them is a
  // symptom, not the reason the row failed.
  const stageReplans = new Map<string, number>()
  const firstStageError = new Map<string, unknown>()
  started = { row_id: rowId, outcome: outcomeOf(plan.outcome), blockers, job_id: jobs[0]?.id, interim: true, preparation_progress: progressSnapshot() }
  logStage("pin", rowId, { verb, outcome: plan.outcome, jobs: jobs.map((job) => job.kind).join(",") || "-" })
  const startedAt = performance.now()
  let landed: ListingRowView | undefined
  let didWork = false
  let waiting = false
  let capacityWaiting = false
  const publish = (row: ListingRowView) => {
    if (!landed || row.view_revision >= landed.view_revision) {
      landed = row
      onRow?.({ ...started, interim: true, product: rowStatusView(row), preparation_progress: progressSnapshot() })
    }
  }
  const recordFailure = (kind: string, reason: unknown) => {
    if (shouldStop()) return
    if (queueBusy(reason)) {
      waiting = true
      capacityWaiting = true
      logStage("queue.wait", rowId, { verb, leg: kind })
      setProgress(feedbackStageOf(kind), "waiting", "等待云端容量", { queue: "cloud" })
      return
    }
    if (isBlocked(reason)) { blockers.push(...blockersOf(reason)); return }
    const error = errorFields(reason)
    const pair = refusalPair(reason) ?? { code: error.code, refusal: error.code }
    const loggedStage = listingRowFailureStage(kind, pair.code)
    failures.push({ kind, error })
    logStage("row.fail", rowId, { verb, leg: kind, code: error.code, message: error.message })
    listingLog({ level: "error", module: "prepare", event: "row.fail", rowId, errorCode: pair.code, errorMessage: error.message, fields: { verb, stage: loggedStage, refusal: pair.refusal } })
    setProgress(loggedStage === "ai" ? "ai" : feedbackStageOf(kind), "failed", error.message, { code: error.code })
  }
  const replanAfterAi = async (): Promise<StageWork[]> => {
    if (verb !== "prepare" || shouldStop()) return []
    const hasDeferredMedia = (plan.issues ?? []).some(issue =>
      (issue.kind === JOB_RENDER || issue.kind === JOB_UPLOAD) && issue.message && !issue.blockers.length)
    if (jobs.some(next => next.kind === JOB_RENDER || next.kind === JOB_UPLOAD) || hasDeferredMedia) return []
    const commandId = crypto.randomUUID()
    let followUp: PreparationPlan
    try {
      followUp = await retryWhenBusy(
        () => planRow(rowId, "prepare", shouldStop, commandId, undefined, automationScope, batch?.modelRouting),
        { ...PREPARE_BUSY_RETRY, cancelled: shouldStop, sleep: busySleep, onWait: retry => reportWaiting("plan", retry) },
      )
    } catch (reason) {
      if (isBusyRefusal(reason)) throw reason
      recordFailure(JOB_UPLOAD, reason)
      return []
    }
    blockers.push(...(followUp.issues ?? []).flatMap(issue => blockersOf(issue)))
    const items = [
      ...followUp.jobs.map(job => ({ kind: job.kind, job })),
      ...(followUp.issues ?? []).filter(issue => issue.message && !issue.blockers.length)
        .map(issue => ({ kind: issue.kind, operation: operationForStage(issue.kind) })),
    ]
    const uniqueBlockers = [...new Set(blockers)]
    blockers.splice(0, blockers.length, ...uniqueBlockers)
    return items.filter(item => wants("prepare", item.kind))
  }
  const seen = new Set<string>()
  const execute = async (work: StageWork): Promise<void> => {
    const stage = preparationStage(work.kind)
    if (!stage) return
    if (work.kind === JOB_RENDER && globalThis.crossOriginIsolated === false) {
      recordFailure(work.kind, RENDER_ISOLATION_ERROR)
      settleRender()
      return
    }
    let dependencies: StageWork[] = []
    let planned: PreparationJob | undefined
    let claimed: PreparationJob | undefined
    let execution: BrowserExecution | MediaExecution | undefined
    let preparation: { input: PreparedAiInput } | { error: unknown } | undefined
    let keepPending = false
    let claimLogged = false
    let stageDidWork = false
    try {
      // Reservation is occupancy, not a render slot: wait here so a full
      // upload budget cannot pin a lane or WASM instance.
      const feedbackStage = feedbackStageOf(work.kind)
      // A render-only `slice` has no upload consumer. Reserving upload memory
      // for it can strand the render batch behind an unrelated upload that is
      // already holding the budget. The combined `prepare` pipeline keeps the
      // reservation because its render immediately feeds an upload Job.
      if (work.kind === JOB_RENDER && verb === "prepare") await pendingUploads.acquire(rowId, shouldStop, {
        onWait: stats => {
          setProgress("render", "waiting", "等待上传完成，释放容量后继续切片")
          logStage("queue.wait", rowId, { stage: "render", queue: "pending_uploads", ...stats })
        },
        onReady: (waitedMs, stats) => logStage("queue.ready", rowId, { stage: "render", waitedMs, queue: "pending_uploads", ...stats }),
      })
      // The quota slot is released before a busy wait; the Cloud lease stays.
      // batchSize must not scale this budget — a large prepare batch would
      // 429-storm the Workspace lane.
      const busyOptions = {
        ...PREPARE_BUSY_RETRY, cancelled: shouldStop, onWait: reportWaiting,
        // An empty claim waits for its batch's shared tick; any other refusal for its own delay.
        sleep: (ms: number, reason: CloudRefusal) => {
          const tick = (reason as { claimTick?: Promise<void> }).claimTick
          return tick ? untilStopped(tick, shouldStop) : busySleep(ms)
        },
      }
      dependencies = await retryWhenBusy(async () => {
        return stage(async (): Promise<StageWork[]> => {
          if (shouldStop()) return []
          setProgress(feedbackStage, "running", work.kind === JOB_AI ? "正在领取识图任务" : work.kind === JOB_RENDER ? "准备渲染" : "准备上传")
          if (!planned) {
            if ("operation" in work) {
              const retried = await planCommand(work.operation)
              blockers.push(...(retried.issues ?? []).flatMap(blockersOf))
              planned = retried.jobs.find(job => job.kind === work.kind)
              if (!planned) {
                started.outcome = outcomeOf(retried.outcome)
                const current = await readListingRow(rowId)
                publish(current)
                return verb === "prepare"
                  && work.kind === JOB_RENDER
                  && current.media_state === "rendered"
                  ? [{ kind: JOB_UPLOAD, operation: "upload" }]
                  : []
              }
            } else {
              planned = work.job
            }
          }
          if (seen.has(planned.id) && !execution) return []
          try {
            if (!execution) {
              if (work.kind === JOB_AI && !preparation) {
                setProgress("ai", "running", "正在处理识图图片")
                try { preparation = { input: await prepareAiInput(await readListingRow(rowId), planned, workers, shouldStop) } }
                catch (reason) {
                  if (isBusyRefusal(reason)) throw reason
                  preparation = { error: reason }
                }
              }
              if (shouldStop()) return []
              const feedback = (state: "waiting" | "running" | "failed", message: string, fields: DiagFields = {}) => {
                setProgress(feedbackStage, state, message, { job: planned!.id, ...fields })
              }
              if (work.kind !== JOB_AI) {
                execution = {
                  workers, feedback, uploadAccount: batch,
                  stopped: shouldStop,
                  cancelled: shouldStop,
                  assertCurrent: () => {
                    if (shouldStop()) throw cancelledError()
                  },
                  dispose: () => {},
                }
              } else {
                const requestedAt = performance.now()
                if (!claimLogged) {
                  claimLogged = true
                  logStage("claim.wait", rowId, { stage: feedbackStage, job: planned.id })
                }
                const claim = await claims.claim(planned.id, planned.kind)
                if (!claim) {
                  // After Stop, only the cancel may leave this tab.
                  if (shouldStop()) return []
                  const current = await api.get<PreparationJob>(route("listingJobsById", { id: planned.id }))
                  if (shouldStop()) return []
                  const row = await readListingRow(rowId)
                  publish(row)
                  if (!["queued", "retry_wait", "running"].includes(current.state)) {
                    if (current.state !== "succeeded") {
                      const lastErrorCode = current.last_error_code
                      if (lastErrorCode === "browser_prepare_queue_expired") {
                        throw Object.assign(new Error("排队超时，任务已结束，请重试该阶段"), { code: lastErrorCode, terminalJob: true })
                      }
                      throw Object.assign(new Error(current.state === "uncertain"
                        ? "上次准备的执行结果待确认，请刷新后查看该行状态" : "准备作业已结束，请查看该行状态"),
                      { code: `workflow_job_${current.state}`, terminalJob: true })
                    }
                    didWork = true
                    return replanAfterAi()
                  }
                  const next = claims.nextTick()
                  throw Object.assign(new Error("准备队列已满"), {
                    status: 429,
                    retryAfterMs: next.ms,
                    claimTick: next.wait,
                  })
                }
                claimed = claim.job
                execution = { ...keepBrowserLease(claim.job.id, claim.lease, claim.lease_seconds, requestedAt, shouldStop, event => {
                  if (event.kind === "lost") {
                    feedback("failed", "执行权已失效，请刷新核对已完成结果", { code: event.code, remainingMs: event.remainingMs, elapsedMs: event.elapsedMs })
                    logStage("lease.lost", rowId, { job: claim.job.id, code: event.code, remainingMs: event.remainingMs, elapsedMs: event.elapsedMs })
                  } else if (event.kind === "degraded") {
                    logStage("lease.degraded", rowId, { job: claim.job.id, code: event.code })
                  } else {
                    logStage("lease.recovered", rowId, { job: claim.job.id })
                  }
                }), workers, feedback }
              }
              seen.add(planned.id)
              // Busy re-entries keep the current attempt, including its OCR lease.
              stageAttempts.set(work.kind, (stageAttempts.get(work.kind) ?? 0) + 1)
            }
            const job = claimed ?? planned
            execution.assertCurrent()
            if (shouldStop()) return []
            didWork = true
            stageDidWork = true
            started.job_id ??= job.id
            const row = await readListingRow(rowId)
            if (shouldStop()) return []
            publish(row)
            if (job.kind === JOB_AI) {
              setProgress("ai", "running", "正在识别图片")
              if (!("lease" in execution)) throw new Error("识图缺少执行权")
              const settled = await runAiJob(row, job, execution, preparation!)
              execution.dispose()
              if (settled) publish(settled)
              return settled ? replanAfterAi() : []
            }
            const mediaExecution = execution
            const media = await runMediaJob(row, job, mediaExecution,
              rejectedBatch => authorizeBatchUpload(batch, mediaExecution, rejectedBatch))
            if (media?.row) publish(media.row)
            const enqueueUpload = !shouldStop() && !execution.stopped() && (
              Boolean(media?.jobs.length)
              || (verb === "prepare" && job.kind === JOB_RENDER && media?.row?.media_state === "rendered")
            )
            if (job.kind === JOB_RENDER && enqueueUpload) {
              pendingUploads.attach(rowId, pendingUploadBytes(media?.row))
              keepPending = true
            }
            if (media?.jobs.length) return media.jobs.map(next => ({ kind: next.kind, job: next }))
            return enqueueUpload ? [{ kind: JOB_UPLOAD, operation: "upload" }] : []
          } catch (reason) {
            if (isBusyRefusal(reason)) throw reason
            if (isContractUnusable(reason) || isOcrRecoveryPaused(reason)) {
              recordFailure(work.kind, reason)
              return []
            }
            // A dead Job can never be claimed again, and the same-commandId
            // replan only ever replays that Job — the retry cannot advance.
            if ((reason as { terminalJob?: unknown }).terminalJob) {
              recordFailure(work.kind, firstStageError.get(work.kind) ?? reason)
              return []
            }
            const attempt = stageAttempts.get(work.kind) ?? MAX_PREPARATION_ATTEMPTS
            const replans = stageReplans.get(work.kind) ?? 0
            if (!shouldStop() && attempt < MAX_PREPARATION_ATTEMPTS && replans < MAX_PREPARATION_ATTEMPTS) {
              if (!firstStageError.has(work.kind)) firstStageError.set(work.kind, reason)
              stageReplans.set(work.kind, replans + 1)
              seen.delete((claimed ?? planned).id)
              // A local attempt that wrote a failure needs a fresh plan, not
              // the old command's replay of its now-terminal media record.
              if (work.kind !== JOB_AI) commands.delete(operationForStage(work.kind))
              setProgress(feedbackStage, "waiting", `第 ${attempt + 1}/${MAX_PREPARATION_ATTEMPTS} 次尝试`)
              logStage("stage.retry", rowId, { stage: feedbackStage, attempt: attempt + 1 })
              return [{ kind: work.kind, operation: operationForStage(work.kind) }]
            }
            recordFailure(work.kind, firstStageError.get(work.kind) ?? reason)
            return []
          }
        }, {
          onWait: () => setProgress(feedbackStage, "waiting", "等待本机阶段容量", { queue: work.kind }),
          onReady: (waitedMs) => logStage("queue.ready", rowId, { stage: feedbackStage, waitedMs, queue: work.kind }),
        })
      }, { ...busyOptions, onWait: (retry) => reportWaiting(feedbackStage, retry) })
    } catch (reason) {
      if (isBusyRefusal(reason)) {
        waiting = true
        capacityWaiting = true
      } else recordFailure(work.kind, reason)
    } finally {
      execution?.dispose()
      if (preparation && "input" in preparation) preparation.input.release()
      preparation = undefined
      if (work.kind === JOB_AI) releasePin()
      if (work.kind === JOB_RENDER && !keepPending) pendingUploads.release(rowId)
      if (work.kind === JOB_UPLOAD) pendingUploads.release(rowId)
    }
    if (work.kind === JOB_RENDER && !dependencies.some(next => next.kind === JOB_RENDER)) settleRender()
    const finalStage = feedbackStageOf(work.kind)
    if (stageDidWork && !failures.some(failure => failure.kind === work.kind)) clearProgress(finalStage)
    await Promise.all(dependencies.map(execute))
  }
  const deferred = (plan.issues ?? [])
    .filter(issue => issue.message && !issue.blockers.length)
    .map(issue => ({ kind: issue.kind, operation: operationForStage(issue.kind) }))
  const renderItems = [
    ...jobs.filter(job => job.kind === JOB_RENDER).map(job => ({ kind: job.kind, job })),
    ...deferred.filter(item => item.kind === JOB_RENDER),
  ]
  const otherItems = [
    ...jobs.filter(job => job.kind !== JOB_RENDER).map(job => ({ kind: job.kind, job })),
    ...deferred.filter(item => item.kind !== JOB_RENDER),
  ]
  if (!jobs.some((job) => job.kind === JOB_AI) && !deferred.some((item) => item.kind === JOB_AI)) {
    releasePin()
  }
  const hasAiWork = jobs.some(job => job.kind === JOB_AI) || deferred.some(item => item.kind === JOB_AI)
  if (renderItems.length === 0 && !(verb === "prepare" && hasAiWork)) settleRender()
  const rendering = renderItems.length
    ? Promise.all(renderItems.map(execute)).finally(settleRender)
    : Promise.resolve([])
  await Promise.all([rendering, ...otherItems.map(execute)])
  if (renderItems.length === 0) settleRender()
  if ((didWork && verb === "prepare")
    || (!didWork && verb !== "recognize" && started.outcome === "noop" && !shouldStop())) {
    try {
      const current = await readListingRow(rowId)
      if (!landed || current.view_revision >= landed.view_revision) landed = current
    } catch { /* settled responses remain valid projections */ }
  }
  const error = failures[0]?.error
  const result: WorkflowOperationRowResult = {
    ...started,
    interim: false,
    outcome: shouldStop() ? "noop" : blockers.length ? "blocked" : waiting ? "wait" : didWork ? "start" : started.outcome,
    ...(shouldStop() ? { noop_reason: "cancelled" } : capacityWaiting ? { noop_reason: "queue_busy" } : {}),
    ...(landed ? { product: rowStatusView(landed) } : {}),
    ...(error ? { error: failures.length > 1 ? { ...error, message: failures.map(({kind,error}) => `${kind}: ${error.message}`).join("；") } : error } : {}),
    preparation_progress: failures.length ? progressSnapshot().filter(item => item.state === "failed") : [],
  }
  logStage("row.done", rowId, { verb, ms: elapsedMs(startedAt), revision: landed?.revision })
  listingLog({ module: "prepare", event: "row.end", rowId, durationMs: elapsedMs(startedAt), fields: { verb, revision: landed?.revision } })
  if ((verb === "prepare" || verb === "recognize") && batch?.pinned.has(rowId) && shouldStop()) {
    batch.pinned.delete(rowId)
    try { await cancelPrepareJobsForDrafts([rowId]) } catch { /* stop still wins */ }
  } else {
    batch?.pinned.delete(rowId)
  }
  releasePin()
  return result
}
