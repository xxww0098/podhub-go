import type { WorkflowProductStatusView } from "@/bindings/commands"
import { commitProductStatus } from "../workbench/product-status"
import { useRef, useState } from "react"
import { readListingIntents, releaseUnknownListingIntents, type ListingIntent } from "@/bindings/http-listing-intents"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { sameIntent } from "../model/publish-actions"
import { releaseReadFactsClear } from "../workflow-intent-authority"
import { listingScopeCurrent, listingWorkbenchScope, patchListingWorkbench, peekListingWorkbench } from "../workbench/listing-workbench-store"

/** Captured authority, never inferred from a row log, receipt, or canResume. */
export type UnknownReleaseTarget = {
  platform: "ozon"
  intent: ListingIntent
  canManage: boolean
  storeVisible: boolean
  claimActive: boolean
  jobsActive: boolean
}
export type UnknownReleaseCapability = {
  capture: (rowId: string) => UnknownReleaseTarget | undefined
  /** Includes current account, store, row revision, claim/jobs, and Stop fence. */
  current: (target: UnknownReleaseTarget) => boolean
  /** Freeze the inspected candidate before this explicit mutation, without sending. */
  beginRelease?: (target: UnknownReleaseTarget) => boolean
  /** Accept only this POST's exact superseded receipt before a release view transition. */
  acceptRelease?: (target: UnknownReleaseTarget, receipt: ListingIntent) => boolean
  /** Real native validation; return facts only, without unlocking or submitting. */
  revalidate: (target: UnknownReleaseTarget, current: ListingIntent) => Promise<WorkflowProductStatusView | undefined>
}

export function useUnknownRelease(busy: boolean, capability?: UnknownReleaseCapability, inspect?: (ids: readonly string[]) => Promise<{ message: string }>) {
  const [releaseInFlight, setReleaseInFlight] = useState(false)
  const lock = useRef(false)

  async function releaseUnknownRows(rowIds: string[]) {
    if (lock.current) return
    const scope = listingWorkbenchScope()
    const workbench = peekListingWorkbench()
    if (busy || workbench.queueRunning || workbench.queuePaused) {
      notifyError("发送队列正在进行或已停止，请先核对当前队列状态再处理未确认 Intent。")
      return
    }
    if (!rowIds.length) return
    if (!capability) {
      notifyInfo("当前工作台没有确切 Intent 释放能力；请管理员在原店铺核对原操作 ID，保持商品锁定，不要重新发送。")
      return
    }
    const selected = [...new Set(rowIds)]
    const targets = selected.map((id) => {
      const target = capability.capture(id)
      const row = workbench.rows.find((row) => row.id === id)
      const product = row && workbench.productDrafts[row.draftId]
      return target && row?.draftId === target.intent.listing_row_id
        && product?.target_store_id === target.intent.store_id
        && product.lifecycle.revision === target.intent.row_revision ? target : undefined
    })
    const admissible = (target: UnknownReleaseTarget | undefined): target is UnknownReleaseTarget =>
      !!target && target.platform === "ozon" && target.intent.state === "unknown"
      && !!target.intent.id && !!target.intent.store_id && !!target.intent.client_operation_id
      && target.canManage === true && target.storeVisible === true && target.claimActive === false && target.jobsActive === false
      && releaseReadFactsClear(target.intent)
      && capability.current(target)
    if (targets.length > 100 || new Set(targets.map((target) => target?.intent.store_id)).size !== 1
      || targets.some((target) => !admissible(target))) {
      notifyInfo("请每次选择同一店铺最多 100 件，核对当前操作身份、权限与在途任务；证据不完整时不释放。")
      return
    }
    const captured = targets.filter((target): target is UnknownReleaseTarget => !!target).map((target) => structuredClone(target))
    const released = new Set<string>()
    const current = (target: UnknownReleaseTarget) => {
      const state = peekListingWorkbench()
      const row = state.rows.find((row) => row.draftId === target.intent.listing_row_id)
      const view = row && state.productDrafts[row.draftId]
      return listingScopeCurrent(scope) && capability.current(target) && !state.queueRunning && !state.queuePaused
        && view?.target_store_id === target.intent.store_id && view.lifecycle.revision === target.intent.row_revision
        && !["queued", "submitting", "accepted", "operator_attested"].includes(view.lifecycle.stage)
        && (view.lifecycle.stage === "outcome_unknown" || row?.publishUnconfirmed === true
          || (released.has(target.intent.id) && !!capability.acceptRelease && view.lifecycle.stage === "ready_to_publish"))
    }
    lock.current = true
    setReleaseInFlight(true)
    let ready = 0
    try {
      if (!captured.every(current)) {
        notifyInfo("当前商品状态与未确认 Intent 不一致，保持锁定；请重新核对原店铺记录。")
        return
      }
      const begin = capability.beginRelease
      if (begin && !captured.every((target) => begin(target))) {
        notifyInfo("原 Intent 释放证据已变化，保持锁定；请重新核对。")
        return
      }
      // ADR-0107 E: one explicit POST, then one latest-per-row read, no retries or pagination.
      const receipt = await releaseUnknownListingIntents(captured.map((target) => target.intent.id))
      const proven = captured.filter((target) => {
        const matches = receipt.intents.filter((intent) => intent.id === target.intent.id)
        const after = matches[0]
        if (!receipt.released_intent_ids.includes(target.intent.id) || matches.length !== 1 || !after
          || !sameIntent(target.intent, after) || after.state !== "superseded"
          || after.updated_at_ms < target.intent.updated_at_ms) return false
        if (capability.acceptRelease && !capability.acceptRelease(target, after)) return false
        released.add(target.intent.id)
        return true
      })
      if (!captured.every(current)) {
        if (listingScopeCurrent(scope)) notifyInfo("释放期间商品或操作权限已变化，保持锁定；请重新核对原 Intent。")
        return
      }
      const page = proven.length ? await readListingIntents(captured[0]!.intent.store_id,
        { rowIds: captured.map((target) => target.intent.listing_row_id) }) : undefined
      for (const target of proven) {
        const before = target.intent
        const matches = page?.items.filter((intent) => intent.listing_row_id === before.listing_row_id) ?? []
        const after = matches.length === 1 ? matches[0] : undefined
        if (!current(target) || !page || page.next_cursor || page.items.length !== captured.length || !after || !sameIntent(before, after)
          || after.state !== "superseded" || !releaseReadFactsClear(after)
          || after.updated_at_ms !== receipt.intents.find((intent) => intent.id === before.id)?.updated_at_ms) continue
        const validated = await capability.revalidate(target, after)
        if (!current(target) || !validated || validated.target_store_id !== before.store_id
          || validated.lifecycle.revision !== before.row_revision || validated.lifecycle.fields !== "valid"
          || !validated.readiness.ready_to_publish || !validated.readiness.can_start_publish_attempt
          || !validated.readiness.allowed_actions.includes("publish")
          || ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(validated.lifecycle.stage)) continue
        if (!commitProductStatus(before.listing_row_id, validated, scope, "原 Intent 已释放并通过原生校验；尚未发送")) continue
        patchListingWorkbench((state) => ({ rows: state.rows.map((row) => row.draftId === before.listing_row_id
          ? { ...row, publishUnconfirmed: false, publishRequestEvidence: undefined } : row) }), scope)
        ready += 1
      }
      if (!listingScopeCurrent(scope)) return
      if (ready === captured.length) notifySuccess(`已释放并重新校验 ${ready} 件商品；未发送，请核对后明确点击发送。`)
      else notifyInfo("部分或全部商品仍缺少当前释放或校验证据，保持锁定；请核对原店铺确切 Intent，不要重发。")
    } catch (reason) {
      if (listingScopeCurrent(scope)) notifyCommandError(reason, "未确认 Intent 释放或读回未完成，保持商品锁定；请核对原操作，不要重发。")
    } finally {
      lock.current = false
      setReleaseInFlight(false)
    }
  }
  async function inspectUnknownRows(rowIds: string[]) {
    const scope = listingWorkbenchScope()
    const state = peekListingWorkbench()
    if (!inspect || lock.current || busy || state.queueRunning || state.queuePaused || !rowIds.length) return
    lock.current = true
    setReleaseInFlight(true)
    try {
      const result = await inspect(rowIds)
      if (listingScopeCurrent(scope)) notifyInfo(result.message)
    } catch (reason) {
      if (listingScopeCurrent(scope)) notifyCommandError(reason, "原 Intent 核对未完成，保持锁定；请管理员核对原店铺记录。")
    } finally { lock.current = false; setReleaseInFlight(false) }
  }
  const canReleaseUnknownRows = (ids: readonly string[]) => !busy && !lock.current && ids.length > 0 && ids.length <= 100
    && !!capability && new Set(ids.map((id) => capability.capture(id)?.intent.store_id)).size === 1
    && ids.every((id) => {
      const target = capability.capture(id)
      const state = peekListingWorkbench(), row = state.rows.find((row) => row.id === id)
      const product = row && state.productBases[row.draftId]
      return !!target && target.platform === "ozon" && target.intent.state === "unknown"
        && !!target.intent.id && !!target.intent.client_operation_id && target.canManage === true && target.storeVisible === true
        && target.claimActive === false && target.jobsActive === false && releaseReadFactsClear(target.intent)
        && row?.draftId === target.intent.listing_row_id && product?.target_store_id === target.intent.store_id
        && product.lifecycle.revision === target.intent.row_revision && !state.queueRunning && !state.queuePaused
        && !["queued", "submitting", "accepted", "operator_attested"].includes(product.lifecycle.stage)
        && capability.current(target)
    })
  return { releaseUnknownRows, releaseInFlight, inspectUnknownRows, canReleaseUnknownRows }
}
