/**
 * 委托订单的纯模型：posting 四态 → 行内动作、单级/包状态中文口径、
 * 发货屏徽标的 N/M 计算、原图约束与 sha256。
 *
 * 判定与合并都在服务端（`DelegatePostingState`），前端只做「态 → 动作」的
 * 映射；唯一需要前端自己算的是发货屏徽标的 N/M——`posting-states` 只回
 * `coveredOfferIds`，总数在 posting 自己的 `products[]` 里。
 * 状态色不发明第七种 tone，全部落在 `receipt-state` 的六色词汇里。
 */
import { commandErrorCode } from "@/lib/error-message"
import { formatDateTime } from "@/lib/format"
import type { StateTone } from "@/lib/receipt-state"

/** 行级委托态（服务端合并）。 */
export type DelegateRowState = "delegated" | "partial" | "ready" | "needs_setup"

/** 一行 posting 在屏上的动作映射。`needs_setup` 的补齐流是屏幕自己的对话框。 */
export type DelegateRowAction =
  | { kind: "view-order"; label: string }
  | { kind: "delegate-rest"; label: string }
  | { kind: "delegate"; label: string }
  | { kind: "setup"; label: string }

export function delegateRowAction(state: DelegateRowState): DelegateRowAction {
  switch (state) {
    case "delegated":
      return { kind: "view-order", label: "查看委托单" }
    case "partial":
      return { kind: "delegate-rest", label: "委托剩余行" }
    case "ready":
      return { kind: "delegate", label: "委托" }
    case "needs_setup":
      return { kind: "setup", label: "补齐并委托" }
  }
}

// ---------------------------------------------------------------------------
// 状态中文口径（wire 值保持 wire 值，只有印出的字被翻译）
// ---------------------------------------------------------------------------

export const ORDER_STATE_LABELS: Record<string, string> = {
  awaiting_setup: "待完善",
  ready: "待派发",
  dispatched: "已派发",
  in_production: "生产中",
  shipped: "已发货",
  done: "已完成",
  cancelled: "已取消",
}

export function orderStateLabel(state: string): string {
  return ORDER_STATE_LABELS[state] ?? state
}

export function orderStateTone(state: string): StateTone {
  switch (state) {
    case "awaiting_setup":
      return "attest"
    case "ready":
    case "dispatched":
    case "in_production":
      return "flight"
    case "shipped":
    case "done":
      return "good"
    case "cancelled":
      return "bad"
    default:
      return "idle"
  }
}

export const PACKET_STATE_LABELS: Record<string, string> = {
  dispatched: "待接单",
  accepted: "已接单",
  shipped: "已发货",
  rejected: "已拒单",
  cancelled: "已取消",
}

export function packetStateLabel(state: string): string {
  return PACKET_STATE_LABELS[state] ?? state
}

export function packetStateTone(state: string): StateTone {
  switch (state) {
    case "dispatched":
      return "idle"
    case "accepted":
      return "flight"
    case "shipped":
      return "good"
    case "rejected":
    case "cancelled":
      return "bad"
    default:
      return "unknown"
  }
}

/** 委托单里的时间统一走本仓的中文日期格式；空值与无法解析的原样。 */
export function formatInstantValue(value: string | number): string {
  if (value === "" || value === 0) return "—"
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) return value
  return formatDateTime(value)
}

/**
 * 状态 × 动作（撤单：未接单真撤、已接单置
 * `cancel_requested`；收口只对 dispatched/in_production/shipped 开）。终态
 * 两个动作都不给；服务端仍是最终门。
 */
export function orderCanCancel(state: string, cancelRequested: boolean): boolean {
  return (
    !cancelRequested &&
    ["awaiting_setup", "ready", "dispatched", "in_production"].includes(state)
  )
}

export function orderCanClose(state: string): boolean {
  return ["dispatched", "in_production", "shipped"].includes(state)
}

// ---------------------------------------------------------------------------
// 发货屏徽标：coveredOfferIds → N/M（partial 由屏算）
// ---------------------------------------------------------------------------

export type DelegateBadge = {
  /** 全覆盖 / 部分覆盖。 */
  kind: "delegated" | "partial"
  label: string
}

/** offer_id 归一口径与后端 `NULLIF(btrim())` 对齐：去首尾空白后比较。 */
export function normalizedOfferId(offerId: string): string {
  return offerId.trim()
}

/**
 * 发货屏行内徽标：`covered` 为空 → 无徽标；覆盖全部去重后的行 → 「已委托」；
 * 否则 → 「已委托 N/M 行」。N/M 按归一后的 offer_id 去重计数。
 */
export function delegateBadgeFor(
  postingOfferIds: string[],
  coveredOfferIds: string[],
): DelegateBadge | null {
  const totals = new Set(postingOfferIds.map(normalizedOfferId).filter(Boolean))
  if (totals.size === 0) return null
  const totalSet = new Set(totals)
  let coveredCount = 0
  for (const covered of new Set(coveredOfferIds.map(normalizedOfferId))) {
    if (totalSet.delete(covered)) coveredCount += 1
  }
  if (coveredCount === 0) return null
  if (totalSet.size === 0) return { kind: "delegated", label: "已委托" }
  return { kind: "partial", label: `已委托 ${coveredCount}/${totals.size} 行` }
}

// ---------------------------------------------------------------------------
// 原图约束（与 `src/delegate/plan.rs` 同一白名单与上限）
// ---------------------------------------------------------------------------

export const ASSET_MAX_BYTES = 500 * 1024 * 1024

/** `<input accept>` 口径：扩展名而非 MIME（各端 MIME 不一致，PSD 尤甚）。 */
export const ASSET_ACCEPT = ".jpg,.jpeg,.png,.webp,.psd"

/** 归一扩展名（`jpeg` 折叠为 `jpg`）；不在白名单内回 `null`。 */
export function assetExtensionOf(fileName: string): string | null {
  const trimmed = fileName.trim()
  const dot = trimmed.lastIndexOf(".")
  const ext = dot >= 0 ? trimmed.slice(dot + 1).toLowerCase() : ""
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "jpg"
    case "png":
      return "png"
    case "webp":
      return "webp"
    case "psd":
      return "psd"
    default:
      return null
  }
}

/** 声明给 presign / 中转 PUT 的 Content-Type：浏览器识别优先，扩展名兜底。 */
export function assetContentType(file: { name: string; type: string }): string {
  const declared = file.type.trim()
  if (declared) return declared
  switch (assetExtensionOf(file.name)) {
    case "jpg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "webp":
      return "image/webp"
    default:
      // PSD 无 MIME 约束（plan.rs：只要求头值非空），octet-stream 即可。
      return "application/octet-stream"
  }
}

/** 本地预检：白名单 + 上限。中文提示直接可读；`null` 放行。 */
export function assetFileError(file: { name: string; size: number }): string | null {
  if (!assetExtensionOf(file.name)) {
    return "原图仅支持 jpg/png/webp/psd 格式"
  }
  if (file.size <= 0) {
    return `原图「${file.name}」是空文件`
  }
  if (file.size > ASSET_MAX_BYTES) {
    return `原图「${file.name}」超过 500MB 上限`
  }
  return null
}

/** WebCrypto sha256 → 小写 hex（服务端按这个值派生对象键并回读核验）。 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

// ---------------------------------------------------------------------------
// CAS / 幂等
// ---------------------------------------------------------------------------

/** 绑定 CAS 409（`DelegateErrorCode::Conflict` → `cloud_conflict`）。 */
export function isDelegateConflict(reason: unknown): boolean {
  return commandErrorCode(reason) === "cloud_conflict"
}

/** 建单幂等键：每次意图一个新值，重试沿用同一个（由调用方持有）。 */
export function newIdempotencyKey(): string {
  return `delegate-${crypto.randomUUID()}`
}
