/**
 * 平台管理面的厂家账号与提现管理接口。
 * 工厂工作空间的读取与履约操作位于 factory/api.ts。
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
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

// ---------- admin: 厂家账号管理 ----------

type FactoryWire = { factoryId: string; name: string; country: string; icon: string }
type SupplierMemberWire = {
  memberId: string; accountUuid: string; factory: FactoryWire; email: string; name?: string | null; status: string; createdAtMs: number
}
type SupplierAccountMutationWire = { member: SupplierMemberWire; initialPassword?: string | null }

function supplierFactory(data: FactoryWire): SupplierAccountMemberView["factory"] {
  return { factory_id: data.factoryId, name: data.name, country: data.country, icon: data.icon }
}

function supplierMember(data: SupplierMemberWire): SupplierAccountMemberView {
  return { member_id: data.memberId, account_uuid: data.accountUuid, factory: supplierFactory(data.factory), email: data.email, name: data.name, status: data.status, created_at_ms: data.createdAtMs }
}

function supplierAccountMutation(data: SupplierAccountMutationWire): AdminSupplierAccountMutationData {
  return { member: supplierMember(data.member), initial_password: data.initialPassword }
}

export async function listSupplierAccounts(): Promise<AdminSupplierAccountsData> {
  const data = await api.get<{ groups: { factory: FactoryWire; members: SupplierMemberWire[] }[] }>(route("adminSupplierAccounts"))
  return { groups: data.groups.map((group) => ({ factory: supplierFactory(group.factory), members: group.members.map(supplierMember) })) }
}

/** 开通；`initialPassword` 只在本响应出现一次。 */
export async function createSupplierAccount(payload: {
  factoryId: string
  email: string
  name?: string
  password?: string
}): Promise<AdminSupplierAccountMutationData> {
  const data = await api.post<SupplierAccountMutationWire>(
    route("adminSupplierAccounts"),
    payload,
  )
  return supplierAccountMutation(data)
}

/** 停用/启用（admin+）或重置密码（super_admin，回显一次）。 */
export async function patchSupplierAccount(
  memberId: string,
  payload: { status?: "active" | "disabled"; password?: string },
): Promise<AdminSupplierAccountMutationData> {
  const data = await api.patch<SupplierAccountMutationWire>(
    route("adminSupplierAccountsByMemberId", { member_id: memberId }),
    payload,
  )
  return supplierAccountMutation(data)
}

export async function deleteSupplierAccount(
  memberId: string,
): Promise<AdminSupplierAccountDeleteData> {
  const data = await api.del<{ memberId: string; unbound: boolean }>(
    route("adminSupplierAccountsByMemberId", { member_id: memberId }),
  )
  return { member_id: data.memberId, unbound: data.unbound }
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

