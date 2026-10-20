/**
 * 「同款规格」预览的读会话。
 *
 * 一次打开 + 一个范围（工作空间/店铺）+ 一份请求 = 一次读取。换范围、关窗或
 * 重新读取都会作废在途回包（VariantPreviewGuard），晚到的回包不能重填已经
 * 清掉的预览。读失败走 notifyCommandError，页面里只留图标与重试按钮。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import {
  productVariantsHttp,
  type VariantPreviewData,
  type VariantPreviewRequest,
} from "@/bindings/http-product-variants"
import { notifyCommandError } from "@/lib/notify"

import { VariantPreviewGuard } from "./products-variant-model"

export type VariantPreviewState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; data: VariantPreviewData }
  | { phase: "failed" }

export function useVariantPreview({
  enabled,
  scopeKey,
  request,
  failureCopy,
}: {
  enabled: boolean
  /** 工作空间 + 店铺；变了就是新会话，旧回包一律作废。 */
  scopeKey: string
  /** 空表示这次不读（例如还没选目标）。 */
  request: VariantPreviewRequest | null
  /** 读失败的一次性提示；页面不渲染错误原文。 */
  failureCopy: string
}): { state: VariantPreviewState; reload: () => void } {
  const guard = useRef(new VariantPreviewGuard())
  const requestRef = useRef(request)
  requestRef.current = request
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<VariantPreviewState>({ phase: "idle" })
  // 请求内容而不是对象身份决定是否重读：行数组每次回读都是新对象。
  const requestKey = request ? JSON.stringify(request) : ""

  useEffect(() => {
    // 换范围 / 重新读取：先作废上一轮，再开始这一轮。
    guard.current.clear()
    const current = requestRef.current
    if (!enabled || current === null) {
      setState({ phase: "idle" })
      return
    }
    const token = guard.current.begin()
    setState({ phase: "loading" })
    let cancelled = false
    productVariantsHttp.preview(current).then(
      (data) => {
        if (cancelled || !guard.current.accepts(token)) return
        setState({ phase: "ready", data })
      },
      (reason: unknown) => {
        if (cancelled || !guard.current.accepts(token)) return
        setState({ phase: "failed" })
        notifyCommandError(reason, failureCopy)
      },
    )
    return () => {
      cancelled = true
      guard.current.clear()
    }
  }, [enabled, requestKey, scopeKey, nonce, failureCopy])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { state, reload }
}
