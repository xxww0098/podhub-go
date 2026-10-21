/**
 * 厂家门户 (ADR-0100 DEL-04) HTTP — the `/supplier` face's reads, the three
 * actions and the 管理面「厂家账号管理」writes.
 *
 * Types mirror the frozen wire contract
 * `src/wire/cloud_api/supplier_portal.rs`: the factory view is whitelist-only
 * (no org/store/seller identity/sku keys exist on the wire at all), and admin
 * account payloads echo a one-time password exactly once.
 *
 * The generated `route("supplier…")` keys are the path authority.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { downloadGrant, startPresignedDownload } from "./object-download"

export type SupplierMeData = components["schemas"]["SupplierMeData"]
export type SupplierDispatchRow = components["schemas"]["SupplierDispatchRow"]
export type SupplierDispatchListData =
  components["schemas"]["SupplierDispatchListData"]
export type SupplierDispatchDetail =
  components["schemas"]["SupplierDispatchDetail"]
export type SupplierActionData = components["schemas"]["SupplierActionData"]
export type SupplierAccountMemberView =
  components["schemas"]["SupplierAccountMemberView"]
export type SupplierAccountsGroup =
  components["schemas"]["SupplierAccountsGroup"]
export type AdminSupplierAccountsData =
  components["schemas"]["AdminSupplierAccountsData"]
export type AdminSupplierAccountMutationData =
  components["schemas"]["AdminSupplierAccountMutationData"]
export type AdminSupplierAccountDeleteData =
  components["schemas"]["AdminSupplierAccountDeleteData"]

// ---------- factory reads ----------

export async function getSupplierMe(): Promise<SupplierMeData> {
  return api.get<SupplierMeData>(route("supplierMe"))
}

export async function listSupplierDispatches(
  query?: { state?: string; cursor?: string },
): Promise<SupplierDispatchListData> {
  const params = new URLSearchParams()
  if (query?.state) params.set("state", query.state)
  if (query?.cursor) params.set("cursor", query.cursor)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return api.get<SupplierDispatchListData>(route("supplierDispatches") + suffix)
}

export async function getSupplierDispatch(
  dispatchId: string,
): Promise<SupplierDispatchDetail> {
  const data = await api.get<{
    dispatch: SupplierDispatchDetail
  }>(route("supplierDispatchesByDispatchId", { dispatch_id: dispatchId }))
  return data.dispatch
}

// ---------- factory actions ----------

export async function acceptSupplierDispatch(
  dispatchId: string,
): Promise<SupplierActionData> {
  return api.post<SupplierActionData>(
    route("supplierDispatchesByDispatchIdAccept", { dispatch_id: dispatchId }),
  )
}

export async function rejectSupplierDispatch(
  dispatchId: string,
  reason: string,
): Promise<SupplierActionData> {
  return api.post<SupplierActionData>(
    route("supplierDispatchesByDispatchIdReject", { dispatch_id: dispatchId }),
    { reason },
  )
}

// 厂家不手填运单。已接单的包由同步环在读到物流信息后发货，所以这里没有 ship 客户端。

/** Same-origin download route. Older pages use it as an `<a download>` relay. */
export function supplierAssetUrl(dispatchId: string, assetId: string): string {
  return route("supplierDispatchesByDispatchIdAssetsByAssetId", {
    dispatch_id: dispatchId,
    asset_id: assetId,
  })
}

/** Ask Cloud for a short-lived object URL, then hand it to the browser download manager. */
export async function downloadSupplierAsset(dispatchId: string, assetId: string): Promise<void> {
  const grant = await downloadGrant(supplierAssetUrl(dispatchId, assetId))
  startPresignedDownload(grant)
}

// ---------- admin: 厂家账号管理 ----------

export async function listSupplierAccounts(): Promise<AdminSupplierAccountsData> {
  return api.get<AdminSupplierAccountsData>(route("adminSupplierAccounts"))
}

/** 开通；`initialPassword` 只在本响应出现一次。 */
export async function createSupplierAccount(payload: {
  sourceId: string
  email: string
  name?: string
  password?: string
}): Promise<AdminSupplierAccountMutationData> {
  const data = await api.post<AdminSupplierAccountMutationData>(
    route("adminSupplierAccounts"),
    payload,
  )
  return data
}

/** 停用/启用（admin+）或重置密码（super_admin，回显一次）。 */
export async function patchSupplierAccount(
  memberId: string,
  payload: { status?: "active" | "disabled"; password?: string },
): Promise<AdminSupplierAccountMutationData> {
  const data = await api.patch<AdminSupplierAccountMutationData>(
    route("adminSupplierAccountsByMemberId", { member_id: memberId }),
    payload,
  )
  return data
}

export async function deleteSupplierAccount(
  memberId: string,
): Promise<AdminSupplierAccountDeleteData> {
  return api.del<AdminSupplierAccountDeleteData>(
    route("adminSupplierAccountsByMemberId", { member_id: memberId }),
  )
}

/**
 * 平台侧提现单视图。供应商已无资金面（doc §9.1 F1：三条供应商资金路由连同
 * 界面一起卸载），只剩平台员工的工作表还需要读这张单，所以类型直接指向
 * admin 的 schema；名字沿用旧名只是为了不动 supplier/admin-supplier-withdrawals.tsx。
 */
export type SupplierWithdrawalView = components["schemas"]["AdminFactoryWithdrawalView"]

export async function listFactoryWithdrawals(
  status?: string,
): Promise<SupplierWithdrawalView[]> {
  const suffix = status ? "?status=" + encodeURIComponent(status) : ""
  const data = await api.get<components["schemas"]["AdminFactoryWithdrawalListData"]>(
    route("adminSupplierWithdrawals") + suffix,
  )
  return data.withdrawals
}

export async function payFactoryWithdrawal(
  withdrawalId: string,
  reference: string,
): Promise<SupplierWithdrawalView | undefined> {
  const data = await api.post<components["schemas"]["AdminFactoryWithdrawalListData"]>(
    route("adminSupplierWithdrawalsByWithdrawalIdPay", { withdrawal_id: withdrawalId }),
    { reference },
  )
  return data.withdrawals[0]
}

export async function rejectFactoryWithdrawal(
  withdrawalId: string,
  reason: string,
): Promise<SupplierWithdrawalView | undefined> {
  const data = await api.post<components["schemas"]["AdminFactoryWithdrawalListData"]>(
    route("adminSupplierWithdrawalsByWithdrawalIdReject", { withdrawal_id: withdrawalId }),
    { reason },
  )
  return data.withdrawals[0]
}

