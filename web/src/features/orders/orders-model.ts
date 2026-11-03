import type { AdminPaymentOrderView } from "@/bindings/commands"
import { planDisplayName } from "@/features/plans/plan-catalog"

export type OrderStatusFilter = "all" | "pending" | "paid" | "canceled"

const subscriptionPlans = new Set(["free", "lite", "pro", "max"])

export function orderPlanName(plan: string) {
  const key = plan.trim().toLowerCase()
  if (subscriptionPlans.has(key)) return planDisplayName(key)
  if (key === "wallet_topup") return "钱包充值"
  if (key === "platform_goods") return "平台商品"
  return plan.trim() || "未知权益"
}

export function orderEntitlement(order: AdminPaymentOrderView) {
  const label = orderPlanName(order.plan)
  return subscriptionPlans.has(order.plan.trim().toLowerCase()) && order.months > 0
    ? `${label} · ${order.months} 个月`
    : label
}

export function filterOrders(
  orders: AdminPaymentOrderView[],
  filters: {
    status: OrderStatusFilter
    query: string
    workspace: string
    from: string
    to: string
  },
) {
  const query = filters.query.trim().toLocaleLowerCase()
  return orders.filter((order) => {
    if (filters.status !== "all" && order.status !== filters.status) return false
    if (filters.workspace !== "all" && String(order.org_id) !== filters.workspace) return false
    if (query && ![order.public_id, order.workspace_name, order.created_by_email, order.plan, orderPlanName(order.plan)]
      .some((value) => value.toLocaleLowerCase().includes(query))) return false
    if (filters.from || filters.to) {
      const date = new Date(order.created_at)
      if (Number.isNaN(date.getTime())) return false
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      if (filters.from && day < filters.from) return false
      if (filters.to && day > filters.to) return false
    }
    return true
  })
}

export function sortOrdersByTime(orders: AdminPaymentOrderView[], direction: "asc" | "desc") {
  return [...orders].sort((a, b) => {
    const first = Date.parse(a.created_at)
    const second = Date.parse(b.created_at)
    if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0
    if (!Number.isFinite(second)) return -1
    return direction === "asc" ? first - second : second - first
  })
}
