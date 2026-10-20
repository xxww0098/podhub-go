/** Agents 域共享的文案与状态色调映射。 */

export const PRODUCT_LABELS: Record<string, string> = {
  wallet_topup: "钱包充值",
  member_seats: "成员名额",
  // Legacy rows written before the store-slots→member-seats rename.
  store_slots: "成员名额",
}

export const COMMISSION_LABELS: Record<string, string> = {
  credited: "已入账",
  skipped: "未计佣",
}

export const WITHDRAWAL_STATUS_LABELS: Record<string, string> = {
  pending: "处理中",
  paid: "已打款",
  rejected: "已拒绝",
}

export const WITHDRAWAL_STATUS_TONES: Record<string, "attest" | "good" | "idle"> = {
  pending: "attest",
  paid: "good",
  rejected: "idle",
}

export const PAYOUT_CHANNEL_LABELS: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信",
}

export function payoutChannelLabel(channel: string): string {
  return PAYOUT_CHANNEL_LABELS[channel] ?? channel
}
