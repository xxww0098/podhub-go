import { useEffect, useRef } from "react"
import { sendBatchEligible } from "./batch-actions"
import { publishStoreAssignments } from "./submit/publish-policy"
import { peekListingWorkbench } from "./workbench/listing-workbench-store"

type Workbench = ReturnType<typeof peekListingWorkbench>
type Marker = { nonce: string; cardId: string }
type Command = { nonce: string; cardId: string; rowId: string; storeId: string; sha256: string; fileName: string; action: "status" | "prepare" | "send" }

export type MozaAutomationContext = {
  active: boolean
  cardId?: string
  busy: boolean
  templateReady: boolean
  storeConfigured: boolean
  workbench: () => Workbench
  prepare: (ids: string[]) => Promise<void>
  send: (ids: string[], expected: { rowId: string; storeId: string; sha256: string; fileName: string }) => Promise<void>
}

type AutomationWindow = Window & {
  __MOZA_LISTING_AUTOMATION__?: Marker
  __MOZA_LISTING_BRIDGE__?: (command: Command) => Promise<unknown>
}

/** The bridge is installed only in the browser page opened by the local plugin. */
export function createMozaAutomation(marker: Marker, current: () => MozaAutomationContext) {
  let running = false
  return async (command: Command) => {
    if (!command || command.nonce !== marker.nonce || command.cardId !== marker.cardId ||
      !command.rowId || !command.storeId || !/^[a-f0-9]{64}$/.test(command.sha256) || !command.fileName ||
      !["status", "prepare", "send"].includes(command.action)) {
      throw new Error("自动任务身份无效")
    }
    const getRow = () => {
      const context = current()
      const workbench = context.workbench()
      if (!context.active || context.cardId !== marker.cardId || workbench.cardId !== marker.cardId) {
        throw new Error("上架方案已切换或尚未加载")
      }
      const row = workbench.rows.find((item) => item.draftId === command.rowId)
      const product = row && workbench.productDrafts[row.draftId]
      if (!row || !product || product.parent_card_id !== marker.cardId) throw new Error("商品不属于当前上架方案")
      if (product.target_store_id !== command.storeId || publishStoreAssignments(workbench).get(row.draftId) !== command.storeId) {
        throw new Error("商品目标店铺已变化")
      }
      return { context, row, product }
    }
    const snapshot = () => {
      const { row, product } = getRow()
      return {
        rowId: row.draftId, cardId: marker.cardId, storeId: product.target_store_id,
        stage: product.lifecycle.stage, readiness: row.readiness, message: row.log,
        sourceAvailable: Boolean(row.source?.handle),
        candidatesUnsettled: [...(row.candidates ?? []), ...(product.lifecycle.ai_candidates ?? [])].some(
          (candidate) => candidate.state === "proposed" || candidate.state === "unresolved",
        ),
      }
    }
    if (command.action === "status") return snapshot()
    if (running) throw new Error("自动任务正在执行")
    const { context, row, product } = getRow()
    if (context.busy || !context.storeConfigured) throw new Error("工作台正忙或店铺不可用")
    if (row.source?.handle !== `${command.sha256}/${command.fileName}`) throw new Error("本地源图已变化或不可用")
    if (command.action === "prepare") {
      if (!context.templateReady || !row.source?.handle) throw new Error("缺少 PSD 模板或本地源图")
      if (row.publishUnconfirmed || ["queued", "submitting", "outcome_unknown", "accepted", "publish_rejected", "operator_attested"].includes(product.lifecycle.stage)) {
        throw new Error("商品已有发送记录，不能重新准备")
      }
    } else {
      if (snapshot().candidatesUnsettled || row.publishUnconfirmed || !sendBatchEligible(row, product.lifecycle)) {
        throw new Error("商品尚未满足自动发送条件")
      }
    }
    running = true
    try {
      if (command.action === "prepare") await context.prepare([row.id])
      else await context.send([row.id], { rowId: row.draftId, storeId: command.storeId, sha256: command.sha256, fileName: command.fileName })
      return snapshot()
    } finally {
      running = false
    }
  }
}

export function useMozaAutomation(context: MozaAutomationContext) {
  const current = useRef(context)
  current.current = context
  useEffect(() => {
    const page = window as AutomationWindow
    const marker = page.__MOZA_LISTING_AUTOMATION__
    if (!marker || !/^[a-f0-9]{64}$/.test(marker.nonce) || !marker.cardId) return
    const bridge = createMozaAutomation(marker, () => current.current)
    page.__MOZA_LISTING_BRIDGE__ = bridge
    return () => { if (page.__MOZA_LISTING_BRIDGE__ === bridge) delete page.__MOZA_LISTING_BRIDGE__ }
  }, [])
}
