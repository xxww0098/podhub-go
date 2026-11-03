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
