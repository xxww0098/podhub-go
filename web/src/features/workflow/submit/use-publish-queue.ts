import { useEffect, useRef, useState, type RefObject } from "react"
import type {
  WorkflowOperationRowResult,
  WorkflowQueueState,
} from "@/bindings/commands"
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import { openCardSession } from "../card/card-session"
import { workflowPublishPause, workflowPublishStop, workflowSaveQueueState } from "../card/card-writes"
import { workflowActions } from "../workflow-actions"
import { clearLive, notifyCommandError, notifyError, notifyInfo, notifyLive, notifySuccess } from "@/lib/notify"
import { diagLog } from "@/lib/diag-log"
import {
  cancelInFlightIntentForDraft,
  cancelInFlightIntentsForDrafts,
} from "./cancel-in-flight-intents"
import {
  listingWorkbenchScope,
  listingScopeCurrent,
  patchListingWorkbench,
  peekListingWorkbench,
  projectListingSelection,
} from "../workbench/listing-workbench-store"
import {
  createPreparationTracks,
  preparationRunning,
} from "../prepare/preparation-tracks"
import { commitProductStatuses } from "../workbench/product-status"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { workflowRowsActionRequest } from "../batch-operation"
import {
  preparationBlockedRows,
  publishPreflight,
  type PublishPreflight,
  type PublishRefusal,
} from "./publish-policy"
import { beforeDispatchFailure, blockedPublishMessage, projectPublishResults, UNCONFIRMED_PUBLISH_MESSAGE } from "./publish-queue-results"
import { notifySendRefusal } from "./send-report-context"
import { useRepairPublish, type BrandRepairCapability } from "./use-repair-publish"
import { createPublishDiagnosticAction } from "./queue/diagnostics"
import { diagnosticReferenceFrom } from "../model/publish-diagnostic"
import { captureWorkbenchPublishDiagnostics } from "../workbench/publish-diagnostic-producer"
import { cohortInFlight, watchQueueDrain } from "./queue-drain"

/** True when the tab refuses the send; says why, focusing the row that must change. */
function refusePublish(verdict: PublishPreflight): verdict is PublishRefusal {
  if (verdict.ok) return false
  const focus = verdict.focusRowId
  if (focus) projectListingSelection(() => new Set([focus]))
  notifyError(verdict.message)
  return true
}

type UsePublishQueueInput = {
  brandRepairCapability?: BrandRepairCapability
  cardTemplateId: string | undefined
  supplierProductId?: string
  busy: boolean
  storeConfigured: boolean
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  guidedPreparationLock: RefObject<boolean>
  flushAutosave: () => Promise<boolean>
  /** Shared Card defaults plus just these Product Instances. */
  flushAutosavesFor: (draftIds: readonly string[]) => Promise<boolean>
  diagnosticCurrent?: () => boolean
}

/** The send-queue state machine: progress projection, pause and stop. */
export function usePublishQueue({
  brandRepairCapability,
  cardTemplateId,
  supplierProductId,
  busy,
  storeConfigured,
  preparationTracks,
  guidedPreparationLock,
  flushAutosave,
  flushAutosavesFor,
  diagnosticCurrent = () => true,
}: UsePublishQueueInput) {
  const [queueStopRequested, setQueueStopRequested] = useState(false)
  const { repairRows: clearRepairedTags, repairInFlight, repairPending } = useRepairPublish({ busy, preparationTracks, flushAutosavesFor, capability: brandRepairCapability })
  const resumeInFlight = useRef(false)
  const publishInFlight = useRef<{
    scope: number
    stopped: boolean
    pending: boolean
    cancelledRows: Set<string>
    send?: Promise<WorkflowOperationRowResult[]>
  } | undefined>(undefined)
  const stopInFlight = useRef(false)
  const controlVersion = useRef(0)
  const queueWrite = useRef<Promise<unknown>>(Promise.resolve())
  /** Drafts whose cancel is still scanning/cancelling; a repeat click joins it. */
  const cancelPending = useRef(new Set<string>())
  const diagnosticAction = useRef<{ scope: number; owner: ReturnType<typeof createPublishDiagnosticAction> } | undefined>(undefined)

  function writeQueue(write: () => Promise<WorkflowQueueState>) {
    // Pause/stop must follow a pending cohort save, not race its Card CAS.
    const pending = queueWrite.current.catch((reason) => {
      diagLog("[listing-send]", "queue_write_failed", { reason: reason instanceof Error ? reason.message : String(reason) })
    }).then(write)
    queueWrite.current = pending
    return pending
  }

  function projectQueueState(
    state: Pick<
      WorkflowQueueState,
      | "paused"
      | "running"
      | "frozen_row_ids"
      | "next_position"
      | "stop_after_current"
      | "halt_reason"
    >,
    scope = listingWorkbenchScope(),
  ) {
    if (!listingScopeCurrent(scope)) return
    setQueueStopRequested(stopInFlight.current || state.stop_after_current)
    patchListingWorkbench({
      queuePaused: state.paused,
      queueRunning: stopInFlight.current || (publishInFlight.current?.scope === scope && publishInFlight.current.pending) || state.running,
      queueHaltReason: state.halt_reason ?? null,
      queueFrozenIds: state.frozen_row_ids,
    })
  }

  function refreshQueueRunning(scope: number) {
    const held = stopInFlight.current || (publishInFlight.current?.scope === scope && publishInFlight.current.pending)
    patchListingWorkbench((current) => ({ queueRunning: held || cohortInFlight(current) }), scope)
  }

  // Row updates from SSE land after this click's refresh. Re-derive only when
  // the same card's queued/submitting cohort becomes empty.
  const refreshQueue = useRef(refreshQueueRunning)
  refreshQueue.current = refreshQueueRunning
  useEffect(() => watchQueueDrain((scope) => refreshQueue.current(scope)), [])

  async function startPublish(rowIds?: string[]) {
    const scope = listingWorkbenchScope()
    const currentSession = rowCacheScope().current
    // Only `undefined` is the queue's continuation; an explicit empty selection
    // selects nothing and must never widen to the whole queue.
    const selection = rowIds === undefined ? undefined : new Set(rowIds)
    const clicked = peekListingWorkbench()
    const activity = preparationTracks.current.snapshot()
    // An explicit selection answers for its own rows: another row's running
    // preparation no longer holds it back, while a row inside a running guided
    // batch's plan still does. The lock alone means that plan has not landed.
    const guided = clicked.guidedPreparation
    const guidedPending = guidedPreparationLock.current && !guided.active
    const blockedRows = selection
      ? preparationBlockedRows(clicked.rows, selection, activity, guided)
      : []
    const cardPreparing = !selection && (preparationRunning(activity) || guided.active)
    if (publishInFlight.current || stopInFlight.current || repairPending() || busy || !storeConfigured || cardPreparing || guidedPending || blockedRows.length > 0) {
      if (blockedRows.length > 0) {
        notifyError("所选商品仍在识别、切片或上传，请完成后再发送。")
      } else if (cardPreparing || guidedPending) {
        notifyError("识别、切片或上传仍在进行，请完成后再启动发送队列。")
      } else if (!storeConfigured) {
        notifyError("尚未配置或选择店铺，请先绑定店铺后再发送。")
      }
      return
    }
    if (!cardTemplateId) return
    // Everything the tab alone can refuse is refused here, before any flush or
    // Cloud request and before the flight is claimed.
    const preflight = publishPreflight(clicked, selection, peekAccountOverview())
    if (refusePublish(preflight)) return
    if (diagnosticAction.current?.scope !== scope) {
      diagnosticAction.current?.owner.close()
      diagnosticAction.current = { scope, owner: createPublishDiagnosticAction(crypto.randomUUID(),
        () => currentSession() && listingScopeCurrent(scope) && diagnosticCurrent()
          && peekListingWorkbench().cardId === clicked.cardId && peekListingWorkbench().mediaEpoch === clicked.mediaEpoch,
        clicked.queueFrozenIds.length > 0) }
    }
    const flight = { scope, stopped: false, pending: true, cancelledRows: new Set<string>(), send: undefined as Promise<WorkflowOperationRowResult[]> | undefined }
    const noticeId = `listing-send-${crypto.randomUUID()}`
    publishInFlight.current = flight
    patchListingWorkbench({ queueRunning: true }, scope)
    try {
      // Drain autosaves so Cloud composes the fields currently on screen. An
      // explicit selection flushes the shared Card defaults plus its own rows:
      // another row's unsaved edit must not hold these rows back.
      const flushed = selection
        ? await flushAutosavesFor(preflight.draftIds)
        : await flushAutosave()
      if (!flushed) {
        notifyError("仍有字段没有保存到云端，请重试保存后再发送。")
        return
      }
      if (!listingScopeCurrent(scope) || flight.stopped) return
      // A candidate or sign-out landing during the flush is already knowable:
      // refuse it here, before the supplier verification spends a request.
      if (refusePublish(publishPreflight(peekListingWorkbench(), selection, peekAccountOverview()))) return
      if (supplierProductId) {
        try {
          await (await openCardSession(cardTemplateId)).verifySupplierOnce()
        } catch (reason) {
          notifyCommandError(reason, "发送前无法核验供应商媒体，请检查供应商视频后重试。")
          return
        }
        if (!listingScopeCurrent(scope) || flight.stopped) return
      }
      // The verification is a wait too: the account, rows, candidates and
      // offers may change again; dispatch only what the tab still passes.
      const workbench = peekListingWorkbench()
      const ready = publishPreflight(workbench, selection, peekAccountOverview())
      if (refusePublish(ready)) return
      const { draftIds, rows: frozenRows } = ready

      notifyLive({ id: noticeId, type: "loading", title: `正在提交 ${frozenRows.length} 件商品发送...` })
      diagLog("[listing-send]", "submitting", { card: cardTemplateId, rows: frozenRows.length })
      const optimisticDrafts = { ...workbench.productDrafts }
      for (const id of draftIds) {
        const existing = optimisticDrafts[id]
        if (existing) {
          optimisticDrafts[id] = {
            ...existing,
            lifecycle: {
              ...existing.lifecycle,
              stage: "submitting",
            },
          }
        }
      }
      patchListingWorkbench({
        queueRunning: true,
        queueFrozenIds: draftIds,
        productDrafts: optimisticDrafts,
        rows: workbench.rows.map((row) =>
          draftIds.includes(row.draftId)
            ? {
                ...row,
                status: "running" as const,
                log: "正在提交发送...",
                stage: "submitting" as const,
              }
            : row,
        ),
      }, scope)

      let blockedLogs = new Map<string, string>()
      let results: WorkflowOperationRowResult[] = []
      try {
        await writeQueue(() => workflowSaveQueueState({
          parent_card_id: cardTemplateId,
          paused: false,
          stop_after_current: false,
          next_position: 0,
          frozen_row_ids: draftIds,
        }))
        if (!listingScopeCurrent(scope)) return
        if (!flight.stopped) {
          setQueueStopRequested(false)
          patchListingWorkbench({ queuePaused: false, queueHaltReason: null }, scope)
        }
        // The queue write is a wait too: the last local check sits right before
        // dispatch. A refusal puts back exactly what the optimistic patch above
        // changed, on rows no newer projection replaced; edits keep their overlay.
        const lastState = peekListingWorkbench()
        const last = publishPreflight({ ...lastState,
          productDrafts: Object.fromEntries(Object.entries(lastState.productDrafts).map(([id, view]) =>
            [id, lastState.productBases[id] === optimisticDrafts[id] && workbench.productBases[id]
              ? { ...view, lifecycle: workbench.productBases[id]!.lifecycle } : view])),
          rows: lastState.rows.map((row) => row.log === "正在提交发送..." && lastState.productBases[row.draftId] === optimisticDrafts[row.draftId]
            ? { ...row, stage: workbench.rows.find((before) => before.id === row.id)?.stage } : row),
        }, selection, peekAccountOverview())
        if (!last.ok) {
          patchListingWorkbench((current) => {
            const untouched = (id: string) => draftIds.includes(id) &&
              (current.productBases[id]?.lifecycle.view_revision ?? -1) <= (workbench.productBases[id]?.lifecycle.view_revision ?? -1)
            return {
              productDrafts: Object.fromEntries(Object.entries(current.productBases).map(([id, latest]) =>
                [id, untouched(id) ? workbench.productBases[id]! : latest])),
              rows: current.rows.map((row) => {
                const original = workbench.rows.find((item) => item.draftId === row.draftId)
                return original && untouched(row.draftId) && row.log === "正在提交发送..."
                  ? { ...row, status: original.status, stage: original.stage, log: original.log }
                  : row
              }),
            }
          }, scope)
          refusePublish(last)
          return
        }
        flight.send = workflowActions.workflowSend(
          workflowRowsActionRequest(frozenRows, workbench.productDrafts),
          (rowId) => flight.stopped || flight.cancelledRows.has(rowId),
          diagnosticAction.current.owner.context,
        )
        results = await flight.send
        flight.pending = false
        if (!listingScopeCurrent(scope)) return
        blockedLogs = new Map(
          results
            .filter((result) => result.outcome === "blocked")
            .map((result) => [
              result.row_id,
              blockedPublishMessage(result),
            ]),
        )

        const responded = results.filter((result) => result.submissionReceipt)
        const blocked = results.filter((result) => result.outcome === "blocked")
        const unconfirmed = results.filter((result) => result.outcome === "unknown")
        const noops = results.filter((result) => result.outcome === "noop")
        diagLog("[listing-send]", "submission.receipt", { card: cardTemplateId, responded: responded.length, blocked: blocked.length, unconfirmed: unconfirmed.length, skipped: noops.length })

        if (!flight.stopped && responded.length > 0) {
          const extras = [
            blocked.length ? `其余 ${blocked.length} 件未发送` : "",
            unconfirmed.length ? `${unconfirmed.length} 件结果未确认` : "",
          ].filter(Boolean).join("；")
          notifySuccess(
            (responded.length === 1
              ? "已收到商品发送响应。"
              : `已收到 ${responded.length} 件商品的发送响应。`) +
            (extras ? `${extras}。` : ""),
          )
        } else if (!flight.stopped && blocked.length === 0 && unconfirmed.length === 0 && noops.length > 0) {
          notifyInfo(noops.every((result) => result.noop_reason === "already_accepted")
            ? "所选商品此前已在 Ozon 受理，未重复发送。"
            : "所选商品本次未新建发送任务，请查看各行状态。")
        }

        // Server verdicts use the same atomic version fence as SSE and polling.
        commitProductStatuses(results.flatMap((result) => result.product ? [{
          draftId: result.row_id,
          status: result.product,
          log: blockedLogs.get(result.row_id) ?? "发送状态已刷新",
          diagnostic: diagnosticReferenceFrom(result),
        }] : []), scope, false)
        patchListingWorkbench((current) => projectPublishResults(current, workbench, results, blockedLogs, draftIds), scope)
        void captureWorkbenchPublishDiagnostics(draftIds, scope)
        refreshQueueRunning(scope)
        if (!flight.stopped && blocked.length > 0) {
          const row = frozenRows.find((item) => item.draftId === blocked[0]!.row_id)
          if (row) projectListingSelection(() => new Set([row.id]))
          const detail = blockedLogs.get(blocked[0]!.row_id) ?? "当前状态不能发送。"
          notifySendRefusal(blocked.length === 1 ? detail : `${blocked.length} 件商品未发送：${detail}；各行发布状态已标注原因`, blocked[0]!, cardTemplateId, blocked.length)
        }
        if (!flight.stopped && unconfirmed.length > 0) {
          const row = frozenRows.find((item) => item.draftId === unconfirmed[0]!.row_id)
          if (row) projectListingSelection(() => new Set([row.id]))
          notifySendRefusal(unconfirmed.length === 1
            ? "未收到本次发送结果，请刷新核对云端记录；不要重复发送。"
            : `${unconfirmed.length} 件商品未收到本次发送结果，请刷新核对云端记录；不要重复发送。`,
            unconfirmed[0]!, cardTemplateId, unconfirmed.length)
        }
      } catch (reason) {
        if (!currentSession() || !listingScopeCurrent(scope)) return
        patchListingWorkbench((current) => {
          const productDrafts = { ...current.productBases }
          const rows = current.rows.map((row) => {
            const before = workbench.productBases[row.draftId]
            const latest = current.productBases[row.draftId]
            const original = workbench.rows.find((item) => item.id === row.id && item.draftId === row.draftId)
            // Only this click's exact optimistic projection may be replaced.
            // A newer SSE, rebound Store, or another row's identity wins.
            if (current.cardId !== workbench.cardId || !draftIds.includes(row.draftId) || !before || !latest || !original ||
              latest !== optimisticDrafts[row.draftId] || latest.target_store_id !== before.target_store_id ||
              latest.lifecycle.revision !== before.lifecycle.revision || latest.lifecycle.view_revision !== before.lifecycle.view_revision ||
              row.log !== "正在提交发送...") return row
            const lifecycle = flight.send ? { ...before.lifecycle, stage: "outcome_unknown" as const } : before.lifecycle
            productDrafts[row.draftId] = { ...before, lifecycle }
            return { ...projectListingRowLifecycle(row, lifecycle, original.readiness),
              ...(flight.send ? { publishUnconfirmed: true } : {}),
              log: flight.send ? UNCONFIRMED_PUBLISH_MESSAGE : beforeDispatchFailure(reason) }
          })
          return { productDrafts, rows }
        }, scope)
        if (flight.send) void captureWorkbenchPublishDiagnostics(draftIds, scope)
        refreshQueueRunning(scope)
        if (listingScopeCurrent(scope)) notifyCommandError(reason,
          flight.send ? "未收到本次发送结果，请刷新核对云端记录；不要重复发送。" : "发布车道未能启动。")
        return
      }
    } finally {
      clearLive(noticeId)
      if (publishInFlight.current === flight) publishInFlight.current = undefined
      refreshQueueRunning(scope)
    }
  }

  async function pausePublish() {
    diagnosticAction.current?.owner.close()
    const scope = listingWorkbenchScope()
    if (!cardTemplateId || stopInFlight.current) return
    const flight = publishInFlight.current
    if (flight?.scope === scope) flight.stopped = true
    const version = ++controlVersion.current
    const draftIds = [...peekListingWorkbench().queueFrozenIds]
    patchListingWorkbench({ queuePaused: true, queueHaltReason: "operator_pause" }, scope)
    try {
      const queue = await writeQueue(() => workflowPublishPause(cardTemplateId))
      if (version === controlVersion.current) projectQueueState({ ...queue, frozen_row_ids: draftIds }, scope)
    } catch (reason) {
      if (listingScopeCurrent(scope)) notifyCommandError(reason, "本标签页已暂停后续发送，云端暂停未确认，请重试。")
    }
  }

  async function resumePublish() {
    const scope = listingWorkbenchScope()
    if (resumeInFlight.current || stopInFlight.current || publishInFlight.current) return
    const version = controlVersion.current
    resumeInFlight.current = true
    try {
      if (listingScopeCurrent(scope) && version === controlVersion.current) await startPublish()
    } finally {
      resumeInFlight.current = false
    }
  }

  async function stopPublish() {
    diagnosticAction.current?.owner.close()
    const scope = listingWorkbenchScope()
    if (!cardTemplateId || stopInFlight.current) return
    stopInFlight.current = true
    ++controlVersion.current
    const flight = publishInFlight.current
    if (flight?.scope === scope) flight.stopped = true
    const draftIds = [...peekListingWorkbench().queueFrozenIds]
    setQueueStopRequested(true)
    patchListingWorkbench({ queuePaused: true, queueRunning: true, queueHaltReason: "operator_stop" }, scope)
    try {
      const saved = await writeQueue(() => workflowPublishStop(cardTemplateId))
        .then((queue) => ({ queue, error: undefined }), (error: unknown) => ({ queue: undefined, error }))
      if (saved.queue) projectQueueState({ ...saved.queue, frozen_row_ids: draftIds }, scope)
      // Stop existing queued work promptly, then cover any Intent whose submit
      // was already in flight. Never abort that write or assume it did not land.
      const cancelling = cancelInFlightIntentsForDrafts(draftIds, cardTemplateId)
      if (flight?.scope === scope && flight.send) {
        const [, submitted] = await Promise.allSettled([cancelling, flight.send])
        await cancelInFlightIntentsForDrafts(draftIds, cardTemplateId)
        if (submitted.status === "rejected") throw submitted.reason
      } else await cancelling
      if (!saved.queue) throw saved.error
      if (listingScopeCurrent(scope)) notifyInfo("已停止后续发送并请求取消排队任务；已派发的请求会返回本次响应。")
    } catch (reason) {
      if (listingScopeCurrent(scope)) {
        setQueueStopRequested(false)
        notifyCommandError(reason, "后续发送已暂停，但未确认全部取消，请重试停止。")
      }
    } finally {
      stopInFlight.current = false
      refreshQueueRunning(scope)
    }
  }

  async function cancelRowIntent(draftId: string) {
    // Claimed synchronously so a double click cannot start a second scan; the
    // first click's flow (including its late rescan) answers for both.
    if (!draftId.trim() || cancelPending.current.has(draftId)) return
    cancelPending.current.add(draftId)
    const scope = listingWorkbenchScope()
    const flight = publishInFlight.current
    if (flight?.scope === scope) flight.cancelledRows.add(draftId)
    try {
      const cancelling = cancelInFlightIntentForDraft(draftId)
      let cancelled = false
      if (flight?.scope === scope && flight.send) {
        const [first] = await Promise.allSettled([cancelling, flight.send])
        const last = await cancelInFlightIntentForDraft(draftId)
        cancelled = last.cancelled || first.status === "fulfilled" && first.value.cancelled
      } else cancelled = (await cancelling).cancelled
      if (listingScopeCurrent(scope)) notifyInfo(cancelled
        ? "已请求取消该行发送；已派发的请求会返回本次响应。"
        : flight?.cancelledRows.has(draftId) ? "已停止该行后续提交。" : "该行当前没有可取消的 Cloud Intent。")
    } catch (reason) {
      if (listingScopeCurrent(scope)) notifyCommandError(reason, "取消发送未确认，请重试。")
    } finally {
      cancelPending.current.delete(draftId)
    }
  }

  async function repairRows(rowIds: string[]) {
    const repaired = await clearRepairedTags(rowIds)
    // The click is the confirmation: cleared tags go out on the current send rail
    // so the seller cabinet receives the update. The repair capability itself never submits.
    if (repaired.length && listingScopeCurrent(listingWorkbenchScope())) await startPublish(repaired)
  }

  return {
    submissionPending: () => publishInFlight.current?.pending ?? false,
    queueStopRequested,
    projectQueueState,
    startPublish,
    resumePublish,
    pausePublish,
    stopPublish,
    cancelRowIntent,
    repairRows,
    repairInFlight,
  }
}
