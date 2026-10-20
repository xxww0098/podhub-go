/**
 * Seller 店铺注入 presentation (SHIP-04). Cloud owns readiness; this file
 * only maps the seller DTO onto platform-safe copy.
 */
import type { SellerShippingReadiness } from "@/bindings/http-supply-chain"
import type { StateTone } from "@/lib/receipt-state"

export const PLATFORM_LOGISTICS_TITLE = "平台物流配置"

export const SELLER_INJECT_COPY = {
  notConfigured: "尚未配置",
  inject: "注入到店铺",
  ready: "✓ 物流配置已就绪",
  stale: "! 平台物流配置有更新",
  update: "更新店铺物流配置",
  waiting: "○ Ozon 正在处理物流配置",
  unknown: "! 物流配置状态待核对，请勿重复提交",
  failed: "物流配置未成功",
  missingBind: "尚未配置平台物流",
  writesDisabled: "店铺物流配置暂时无法写入",
  unavailable: "平台物流配置暂不可用",
  notActive: "物流配置尚未生效",
} as const

export type SellerInjectKind =
  | "not_configured"
  | "ready"
  | "stale"
  | "waiting"
  | "result_unknown"
  | "blocked"

export type SellerInjectAction = "inject" | "update" | null

export type SellerInjectPresentation = {
  kind: SellerInjectKind
  statusText: string
  action: SellerInjectAction
  actionLabel: string | null
  tone: StateTone
}

const WAITING_STATUSES = new Set(["waiting", "queued", "submitting"])

const UNAVAILABLE_REASONS = new Set([
  "inject_not_available",
  "weight_unit_unpinned",
  "non_integrated_unsupported",
])

function hasReason(
  reasons: SellerShippingReadiness["reasons"],
  reason: SellerShippingReadiness["reasons"][number],
): boolean {
  return reasons.includes(reason)
}

export function presentSellerInject(
  readiness: SellerShippingReadiness,
): SellerInjectPresentation {
  const reasons = readiness.reasons
  const injectStatus = readiness.inject_status ?? undefined

  if (
    hasReason(reasons, "waiting") ||
    (injectStatus !== undefined && WAITING_STATUSES.has(injectStatus))
  ) {
    return {
      kind: "waiting",
      statusText: SELLER_INJECT_COPY.waiting,
      action: null,
      actionLabel: null,
      tone: "flight",
    }
  }
  if (hasReason(reasons, "result_unknown") || injectStatus === "unknown") {
    return {
      kind: "result_unknown",
      statusText: SELLER_INJECT_COPY.unknown,
      action: null,
      actionLabel: null,
      tone: "unknown",
    }
  }
  if (readiness.status === "ready") {
    return {
      kind: "ready",
      statusText: SELLER_INJECT_COPY.ready,
      action: null,
      actionLabel: null,
      tone: "good",
    }
  }
  // Hard blocks outrank staleness: the server force-inserts writes_disabled
  // alongside a retained stale_version, so the stale branch must not hand
  // out an enabled update button while writes are refused.
  if (hasReason(reasons, "writes_disabled")) {
    return {
      kind: "blocked",
      statusText: SELLER_INJECT_COPY.writesDisabled,
      action: null,
      actionLabel: null,
      tone: "bad",
    }
  }
  if (reasons.some((reason) => UNAVAILABLE_REASONS.has(reason))) {
    return {
      kind: "blocked",
      statusText: SELLER_INJECT_COPY.unavailable,
      action: null,
      actionLabel: null,
      tone: "bad",
    }
  }
  if (readiness.status === "stale" || hasReason(reasons, "stale_version")) {
    return {
      kind: "stale",
      statusText: SELLER_INJECT_COPY.stale,
      action: "update",
      actionLabel: SELLER_INJECT_COPY.update,
      tone: "attest",
    }
  }
  if (hasReason(reasons, "missing_bind")) {
    return {
      kind: "blocked",
      statusText: SELLER_INJECT_COPY.missingBind,
      action: null,
      actionLabel: null,
      tone: "idle",
    }
  }
  if (hasReason(reasons, "failed") || injectStatus === "failed") {
    return {
      kind: "blocked",
      statusText: SELLER_INJECT_COPY.failed,
      action: "inject",
      actionLabel: SELLER_INJECT_COPY.inject,
      tone: "bad",
    }
  }
  if (hasReason(reasons, "delivery_method_not_active")) {
    return {
      kind: "blocked",
      statusText: SELLER_INJECT_COPY.notActive,
      action: "inject",
      actionLabel: SELLER_INJECT_COPY.inject,
      tone: "attest",
    }
  }
  return {
    kind: "not_configured",
    statusText: SELLER_INJECT_COPY.notConfigured,
    action: "inject",
    actionLabel: SELLER_INJECT_COPY.inject,
    tone: "idle",
  }
}
