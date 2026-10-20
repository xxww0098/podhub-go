/** 工具栏上当前店铺的同步控制：更新时间、暂停原因、立即更新。 */
import { TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { StoreProductOverviewRow } from "./products-api"
import { fmtTime, fmtWindowStamp } from "./products-status"

/** `hold_reason` → the hover hint. Only read under a `credential` hold — the
 * machine lands credential holds with exactly these three verdicts
 * (`credential_verdict` + the runner's open-key mapping); transient internals
 * (限流、熔断、写入让路…) stay server-side and surface at the button. */
const HOLD_REASON_TITLE: Record<string, string> = {
  credential_revoked: "Seller 密钥已被撤销，请到「店铺设置」重新登记",
  credential_expired: "Seller 密钥已过期，请重新登记",
  ip_restricted: "密钥设置了 IP 白名单，本部署不在其中",
}

/** The only holds that earn a badge are the ones the operator can act on —
 * 密钥与停用. Self-recovering pauses surface once, at the button they block,
 * instead of narrating the scheduler. */
function holdBadge(
  store: StoreProductOverviewRow,
): { label: string; title?: string; warn?: boolean } | null {
  if (store.hold === "credential") {
    const title = store.hold_reason ? HOLD_REASON_TITLE[store.hold_reason] : undefined
    return { label: "密钥待复查", title: title ?? "请重新登记 Seller 密钥", warn: true }
  }
  if (store.hold === "disabled") return { label: "已停用" }
  return null
}

/** A short clock face for intra-day stamps like a cooldown lift — 「02:40」. */
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

/** Why 「立即更新」 must not fire — or null when it may. */
export function scheduleBlockedReason(
  store: StoreProductOverviewRow,
  syncDisabled: boolean,
  nowMs: number,
): string | null {
  if (syncDisabled) return "自动更新已停用"
  if (store.status !== "active") return "店铺已停用"
  // 服务端只在 hold 窗口开着时回 409（`hold_until_ms > now`）；窗口已过、
  // 调度器尚未重落的行照样接受手动更新——按钮不能冻结在过去的时间戳上。
  if (store.hold != null && store.hold !== "none") {
    const holdUntil = store.hold_until_ms
    const windowOpen = holdUntil != null && holdUntil > nowMs
    if (windowOpen) {
      if (store.hold === "credential") return "密钥待复查"
      if (store.hold_reason === "budget_exhausted") {
        return `今日更新次数已用完，${fmtWindowStamp(holdUntil)} 恢复`
      }
      return `更新暂停，${fmtWindowStamp(holdUntil)} 恢复`
    }
  }
  if (store.manual_next_allowed_at_ms != null && store.manual_next_allowed_at_ms > nowMs) {
    return `${fmtClock(store.manual_next_allowed_at_ms)} 可再次更新`
  }
  return null
}

/** Toolbar cluster for the store currently scoping the table. */
export function StoreSyncActions({
  store,
  syncDisabled,
  scheduling,
  onSchedule,
}: {
  store: StoreProductOverviewRow
  syncDisabled: boolean
  scheduling: boolean
  onSchedule: () => void
}) {
  const nowMs = Date.now()
  const blocked = scheduleBlockedReason(store, syncDisabled, nowMs)
  const hold = holdBadge(store)
  const running = store.pass != null && store.pass !== "none"
  return (
    <div className="flex flex-wrap items-center gap-2">
      {store.status !== "active" ? (
        <Badge variant="outline">{store.status === "manual_disabled" ? "已停用" : "额度暂停"}</Badge>
      ) : null}
      {/* 新鲜度只在要提醒时着色；从未同步时不占位，由表格空状态说明。 */}
      {store.freshness === "expired" ? (
        <span className="text-xs text-st-bad-ink">数据已失效，数字未知</span>
      ) : store.freshness !== "never" ? (
        <span
          className={cn(
            "text-xs",
            store.freshness === "stale" ? "text-st-attest-ink" : "text-muted-foreground",
          )}
          title={store.freshness === "stale" ? "数据较旧，建议立即更新" : undefined}
        >
          更新于 {fmtTime(store.last_full_sync_at_ms)}
        </span>
      ) : null}
      {hold ? (
        <span className="text-xs text-muted-foreground" title={hold.title}>
          {hold.label}
          {hold.warn ? (
            <TriangleAlert className="ml-1 inline size-3 text-st-bad-ink" aria-hidden />
          ) : null}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={scheduling || blocked !== null}
        onClick={onSchedule}
      >
        {scheduling ? "提交中…" : running ? "更新中…" : "立即更新"}
      </Button>
      {blocked ? <span className="text-xs text-muted-foreground">{blocked}</span> : null}
    </div>
  )
}
