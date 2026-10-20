/**
 * 管理面「委托单」(ADR-0100) HTTP — the `/admin?screen=admin-delegate-orders`
 * face's reads and the three actions: 手动派发 / 代录回执 / 撤单.
 *
 * Types mirror the frozen wire contract `src/wire/cloud_api/delegate.rs`
 * (AdminDelegate* family). The admin surface is a superset audience: it sees
 * the seller-shaped order view plus the dispatch ledger
 * (`dispatchId` / `attemptedBy` / `receipt` — the fields the seller wire
 * never carries by design).
 *
 * The generated `route("adminDelegateOrders…")` keys are the path authority.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type AdminDelegateOrderRow =
  components["schemas"]["AdminDelegateOrderRow"]
export type AdminDelegateOrderListData =
  components["schemas"]["AdminDelegateOrderListData"]
export type AdminDelegateOrderDetailView =
  components["schemas"]["AdminDelegateOrderDetailView"]
export type DelegateOrderLineView =
  components["schemas"]["DelegateOrderLineView"]
export type SellerSupplierDbData =
  components["schemas"]["SellerSupplierDbData"]

/** 跨 org 队列：单级状态 / 厂家 / Workspace 过滤 + keyset 游标分页。 */
export async function listAdminDelegateOrders(query?: {
  state?: string
  sourceId?: string
  orgId?: number
  cursor?: string
}): Promise<AdminDelegateOrderListData> {
  const params = new URLSearchParams()
  if (query?.state) params.set("state", query.state)
  if (query?.sourceId) params.set("sourceId", query.sourceId)
  if (query?.orgId !== undefined) params.set("orgId", String(query.orgId))
  if (query?.cursor) params.set("cursor", query.cursor)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return api.get<AdminDelegateOrderListData>(
    route("adminDelegateOrders") + suffix,
  )
}

export async function getAdminDelegateOrder(
  orderId: string,
): Promise<AdminDelegateOrderDetailView> {
  const data = await api.get<{ order: AdminDelegateOrderDetailView }>(
    route("adminDelegateOrdersByOrderId", { order_id: orderId }),
  )
  return data.order
}

/**
 * 手动派发/重派：`sourceId` 缺省 = 各行当前绑定厂家，显式 = 只派绑定该厂的
 * 行；`lineIds` 缺省 = 全部可派行。人工派发整体无视拒单 latch（§D.16 的
 * 解除路径），派发成功后清这些行的 latch。
 */
export async function dispatchAdminDelegateOrder(
  orderId: string,
  payload: { sourceId?: string; lineIds?: string[] },
): Promise<AdminDelegateOrderDetailView> {
  const data = await api.post<{ order: AdminDelegateOrderDetailView }>(
    route("adminDelegateOrdersByOrderIdDispatch", { order_id: orderId }),
    payload,
  )
  return data.order
}

/** 代厂家录回执：对单的最新 live 包（dispatched/accepted）推 shipped。 */
export async function recordAdminDelegateReceipt(
  orderId: string,
  payload: { trackingNo?: string; note?: string },
): Promise<AdminDelegateOrderDetailView> {
  const data = await api.post<{ order: AdminDelegateOrderDetailView }>(
    route("adminDelegateOrdersByOrderIdReceipt", { order_id: orderId }),
    payload,
  )
  return data.order
}

/** 管理员撤单：未接单直撤；已接单置 `cancelRequested`（同卖家语义）。 */
export async function cancelAdminDelegateOrder(
  orderId: string,
): Promise<AdminDelegateOrderDetailView> {
  const data = await api.post<{ order: AdminDelegateOrderDetailView }>(
    route("adminDelegateOrdersByOrderIdCancel", { order_id: orderId }),
  )
  return data.order
}
