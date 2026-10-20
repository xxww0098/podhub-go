import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { AlertTriangle, Store } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { clearLive, notifyLive } from "@/lib/notify"

type StoreGateProps = {
  loading: boolean
  error: string
  reason?: unknown
  storeCount: number
  hasUnavailableStores: boolean
  onRetry: () => void
  onOpenStores?: () => void
  children: ReactNode
  icon?: ReactNode
}

const STORE_GATE_LIVE = "store-gate-load"

/** Shared roster boundary; queue-specific loading and empty states stay below it. */
export function StoreGate({
  loading,
  error,
  reason,
  storeCount,
  hasUnavailableStores,
  onRetry,
  onOpenStores,
  children,
  icon = <Store />,
}: StoreGateProps) {
  // Failure copy lives in the toast host, never in the page. The live row
  // carries the retry so the gate needs no in-page banner; it clears itself
  // the moment a retry succeeds. The ref keeps an inline parent callback from
  // re-firing (and re-logging) the notice on unrelated re-renders.
  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry

  useEffect(() => {
    if (!error) {
      clearLive(STORE_GATE_LIVE)
      return
    }
    notifyLive({
      id: STORE_GATE_LIVE,
      type: "error",
      reason,
      title: error,
      action: { label: "重试", onClick: () => onRetryRef.current() },
    })
    return () => clearLive(STORE_GATE_LIVE)
  }, [error, reason])

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="grid min-h-48 place-items-center rounded-xl border border-border bg-card text-sm text-muted-foreground"
      >
        <span className="inline-flex items-center gap-2">
          <Spinner className="size-4" />
          正在读取店铺配置…
        </span>
      </div>
    )
  }

  if (error && storeCount === 0) {
    return (
      <Empty className="min-h-48">
        <EmptyMedia variant="icon"><AlertTriangle /></EmptyMedia>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onRetry}>重试</Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (storeCount === 0) {
    return (
      <Empty role="status" className="min-h-48">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{hasUnavailableStores ? "已接入的店铺当前不可用" : "还没有已接入的店铺"}</EmptyTitle>
          <EmptyDescription>
            {hasUnavailableStores
              ? "店铺已被 Workspace 停用、超出当前名额或 Seller 密钥已过期，请先到店铺恢复。"
              : "先去店铺配置 Client ID / API Key。"}
          </EmptyDescription>
        </EmptyHeader>
        {onOpenStores ? <EmptyContent><Button size="sm" variant="outline" onClick={onOpenStores}>打开店铺</Button></EmptyContent> : null}
      </Empty>
    )
  }

  return <>{children}</>
}
