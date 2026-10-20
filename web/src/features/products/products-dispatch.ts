/**
 * 店铺商品表所有写入对话框共用的派发层。
 *
 * 全部走 `opsHttp.productsMutate`——写账本按 `operation_id` 幂等，同一
 * id 只会回放第一次的回执，绝不二次写 Seller。超过 Ozon 单次上限的请求
 * 按块拆开，每块独立 operation_id；同一份请求内容的重试复用同一组 id。
 */
import { useCallback, useRef } from "react"

import { opsHttp } from "@/bindings/http-ops"
import type { ProductMutationItemResult, ProductMutationRequest } from "@/bindings/commands"
import { notifyInfo, notifySuccess } from "@/lib/notify"

export type ChunkDispatch = {
  items: ProductMutationItemResult[]
  /** 第一个失败分块的原因；此时 `items` 是失败点之前已落地分块的回执。 */
  failure?: unknown
}

export async function dispatchChunks(
  storeId: string,
  requests: ProductMutationRequest[],
  operationIds: readonly string[],
): Promise<ChunkDispatch> {
  const items: ProductMutationItemResult[] = []
  // 顺序派发：后一块的 429 不会让前一块的成功结果被误报，也不会并发写。
  for (const [index, request] of requests.entries()) {
    try {
      const response = await opsHttp.productsMutate({
        operation_id: operationIds[index]!,
        store_id: storeId,
        request,
      })
      items.push(...response.items)
    } catch (reason) {
      // 已落地分块的回执仍交给调用方上报回填；失败点之后的块不再发。
      return { items, failure: reason }
    }
  }
  return { items }
}

/** 同一组 operation_id 只属于「一次打开的会话 × 同一份请求内容」：内容不变
 * 的重试复用旧键（账本重放回执，绝不二次写 Seller）；换了内容、或关掉再
 * 重新打开对话框（新意图，哪怕内容一字不差）都换新键——同 id 同体会被
 * 账本静默重放旧回执，第二次写入就再也到不了 Ozon。 */
export function useOperationIds(sessionKey: unknown) {
  const ref = useRef<{ sessionKey: unknown; fingerprint: string; ids: string[] }>({
    sessionKey: undefined,
    fingerprint: "",
    ids: [],
  })
  return useCallback(
    // 内容指纹可以是任何可序列化的命令：分组端点不是 `productsMutate` 的块，
    // 但「同一份内容复用同一组 id」这条纪律两边一样。
    (requests: readonly unknown[]) => {
      const fingerprint = JSON.stringify(requests)
      if (ref.current.sessionKey !== sessionKey || ref.current.fingerprint !== fingerprint) {
        ref.current = { sessionKey, fingerprint, ids: requests.map(() => crypto.randomUUID()) }
      }
      return ref.current.ids
    },
    [sessionKey],
  )
}

/** 汇总回执并通知；返回成功项的 Ozon 回执 identity。 */
export function reportOutcome(
  items: ProductMutationItemResult[],
  successText: (succeeded: number) => string,
): string[] {
  const failed = items.filter((item) => !item.succeeded)
  if (failed.length > 0) {
    const details = failed
      .slice(0, 2)
      .map((item) => `${item.identity}：${item.message || "Ozon 未提供失败原因"}`)
      .join("；")
    notifyInfo(
      `Ozon 已处理；成功 ${items.length - failed.length}，失败 ${failed.length}。${details}`,
    )
  } else {
    notifySuccess(successText(items.length))
  }
  return items.filter((item) => item.succeeded).map((item) => item.identity)
}
