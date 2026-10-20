import { formatCents } from "@/lib/money"

export function payoutLabel(row: {
  payout_cents?: number | null
  payout_state?: string | null
}): string | null {
  if (row.payout_state === "settled") return "已到账 " + formatCents(row.payout_cents ?? 0)
  if (row.payout_state === "held") return "待到账 " + formatCents(row.payout_cents ?? 0)
  if (row.payout_state === "released") return "已退回"
  if ((row.payout_cents ?? 0) > 0) return "大约 " + formatCents(row.payout_cents ?? 0)
  return null
}

export function channelLabel(channel: string): string {
  if (channel === "alipay") return "支付宝"
  if (channel === "wechat") return "微信"
  if (channel === "bank") return "银行卡"
  return channel
}

export function withdrawalStatusLabel(status: string): string {
  if (status === "requested") return "待打款"
  if (status === "paid") return "已打款"
  if (status === "rejected") return "已拒绝"
  return status
}

/** 提现行徽标的三态色：已打款绿、已拒绝红、其余（待打款）描边。 */
export function withdrawalBadgeVariant(
  status: string,
): "good" | "destructive" | "outline" {
  if (status === "paid") return "good"
  if (status === "rejected") return "destructive"
  return "outline"
}
