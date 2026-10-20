/**
 * Admin HTTP wire: directory, agents, redeem codes, usage, errors, orders,
 * prices, quotas and Workspace wallets.
 *
 * Screens import `adminHttp` directly. Rank gates live in `./admin-writes`;
 * Cloud re-checks every write.
 */
import { api, request as apiRequest } from "@/api/client"
import { route, type RouteKey } from "@/api/routes"
import type { components } from "@/api/schema"
import {
  findDirectoryPerson,
  planUserCreate,
  planUserUpdate,
  roleFromStored,
  type PlatformRole,
} from "./admin-writes"
import { accountOverview } from "./http-account"
import { refuse } from "./refusal"
import type {
  AdminAgentCommissionsOverview,
  AdminAgentCreateRequest,
  AdminAgentRebatePolicy,
  AdminAgentRebatePolicyRequest,
  AdminAgentUpdateRequest,
  AdminAgentView,
  AdminAgentWithdrawal,
  AdminAgentFilters,
  AdminAgentsOverview,
  AdminCreateUserRequest,
  AdminDeleteErrorLogsData,
  AdminDissolveWorkspaceRequest,
  AdminErrorLogData,
  AdminErrorLogFilters,
  AdminErrorLogKey,
  AdminMemberSeatApplyData,
  AdminMemberSeatPreviewData,
  AdminPaymentOrderView,
  AdminRedeemCodeCreateRequestView,
  AdminRedeemCodesCreated,
  AdminRedeemCodesOverview,
  AdminResetPasswordRequest,
  AdminWorkspaceWalletTopupRequest,
  AdminWorkspaceWalletRevokeRequest,
  AdminUpdateUserRequest,
  AdminUsageData,
  AdminUsageFilters,
  AdminUsageSummaryData,
  AdminUserUuidRequest,
  AdminUserView,
  AdminUserQuotaApplyRequest,
  AdminUserQuotaPreviewRequest,
  AdminUsersOverview,
  WalletTopupsData,
  PublishAiPriceRequest,
} from "./commands"

type AdminAccountMutation = components["schemas"]["AdminAccountMutationData"]
export type CatalogFetchConfigData = components["schemas"]["CatalogFetchConfigData"]
export type CatalogFetchWbCredentialView =
  components["schemas"]["CatalogFetchWbCredentialView"]
export type CatalogFetchWbCredentialWriteRequest =
  components["schemas"]["CatalogFetchWbCredentialWriteRequest"]
export type CatalogFetchConfigWriteRequest =
  components["schemas"]["CatalogFetchConfigWriteRequest"]

/** The actor's own PlatformRole. The two rank gates read it; Cloud re-checks. */
async function actorPlatformRole(): Promise<PlatformRole> {
  return roleFromStored((await accountOverview()).session.role)
}

/** The per-field write routes, keyed by the segment the callers pass. */
const USER_FIELD_ROUTE: Record<string, RouteKey> = {
  admin: "adminUsersByUuidAdmin",
  password: "adminUsersByUuidPassword",
  seats: "adminUsersByUuidSeats",
  status: "adminUsersByUuidStatus",
}

/** Every per-field admin write answers with the account it changed. */
async function adminUserWrite(
  uuid: string,
  segment: string,
  body: unknown,
): Promise<AdminUserView> {
  const key = USER_FIELD_ROUTE[segment]
  if (!key) throw new Error("unknown admin user field: " + segment)
  return (await api.post<AdminAccountMutation>(route(key, { uuid }), body)).user
}

/** Append the filter pairs an admin table actually set; blanks stay off the URL. */
function filterQuery(filters: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    const text = value?.trim()
    if (text) search.append(key, text)
  }
  return search.toString()
}

/** `?a=b` when there are filters, empty when there are none. */
function queryStart(query: string): string {
  return query ? `?${query}` : ""
}

export const adminHttp = {
  /** Platform catalog fetch configuration and immediate run. */
  catalogFetchConfig: () => api.get<CatalogFetchConfigData>(route("catalogFetchConfig")),
  saveCatalogFetchConfig: (request: CatalogFetchConfigWriteRequest) =>
    api.put<CatalogFetchConfigData>(route("catalogFetchConfig"), request),
  saveCatalogFetchWbCredential: (request: CatalogFetchWbCredentialWriteRequest) =>
    api.put<CatalogFetchWbCredentialView>(route("catalogFetchConfigWbCredential"), request),
  runCatalogFetch: () => api.post<CatalogFetchConfigData>(route("catalogFetchConfigRun")),
  adminListUsers: () => api.get<AdminUsersOverview>(route("adminUsers")),
  adminDissolveWorkspace: (request: AdminDissolveWorkspaceRequest) =>
    api.post<void>(route("adminWorkspacesByUuidDissolve", { uuid: request.workspace_uuid }), {
      name: request.name,
    }),
  adminListAgents: (filters: AdminAgentFilters = {}) => {
    const query = new URLSearchParams()
    const text = filters.query?.trim()
    if (text) query.set("query", text)
    const status = filters.status?.trim()
    if (status) query.set("status", status)
    if (filters.flagged) query.set("flagged", "true")
    const suffix = query.size ? `?${query}` : ""
    return api.get<AdminAgentsOverview>(`${route("adminAgents")}${suffix}`)
  },
  adminCreateAgent: (request: AdminAgentCreateRequest) =>
    api.post<AdminAgentView>(route("adminAgents"), request),
  adminUpdateAgent: (userUuid: string, request: AdminAgentUpdateRequest) =>
    api.put<AdminAgentView>(route("adminAgentsByUuid", { uuid: userUuid }), request),
  adminSetAgentRebatePolicy: (policy: AdminAgentRebatePolicyRequest) =>
    api.put<AdminAgentRebatePolicy>(route("adminAgentRebatePolicy"), policy),
  /** The ledger's CSV download: a plain same-origin URL, cookie-authenticated. */
  adminAgentCommissionsCsvUrl: () => route("adminAgentCommissionsCsv"),
  adminListAgentWithdrawals: async (status?: "pending" | "paid" | "rejected") =>
    (
      await api.get<{ withdrawals: AdminAgentWithdrawal[] }>(
        `${route("adminAgentWithdrawals")}${status ? `?status=${status}` : ""}`,
      )
    ).withdrawals,
  adminPayAgentWithdrawal: (publicId: string, reference?: string) =>
    api.post<AdminAgentWithdrawal>(
      route("adminAgentWithdrawalsByPublicIdPay", { public_id: publicId }),
      { reference: reference ?? null },
    ),
  adminRejectAgentWithdrawal: (publicId: string, reason: string) =>
    api.post<AdminAgentWithdrawal>(
      route("adminAgentWithdrawalsByPublicIdReject", { public_id: publicId }),
      { reason },
    ),
  adminListAgentCommissions: (page = 1, status?: "credited" | "skipped") => {
    const query = new URLSearchParams({ page: String(page), page_size: "50" })
    if (status) query.set("status", status)
    return api.get<AdminAgentCommissionsOverview>(
      `${route("adminAgentCommissions")}?${query}`,
    )
  },
  adminListRedeemCodes: () => api.get<AdminRedeemCodesOverview>(route("adminRedeemCodes")),
  adminCreateRedeemCodes: (request: AdminRedeemCodeCreateRequestView) =>
    api.post<AdminRedeemCodesCreated>(route("adminRedeemCodes"), request),
  adminDeleteRedeemCode: (id: number) => api.del<void>(route("adminRedeemCodesById", { id })),
  adminListAiRequests: (page: number, pageSize: number, filters: AdminUsageFilters) => {
    const query = filterQuery({
      q: filters.query,
      status: filters.status,
      api_format: filters.api_format,
      operation: filters.operation,
      since: filters.since,
    })
    return api.get<AdminUsageData>(
      `${route("adminAiRequests")}?page=${page}&page_size=${pageSize}${query ? `&${query}` : ""}`,
    )
  },
  adminAiUsageSummary: (filters: AdminUsageFilters) =>
    api.get<AdminUsageSummaryData>(
      route("adminAiRequestsSummary") +
        queryStart(
          filterQuery({
            q: filters.query,
            status: filters.status,
            api_format: filters.api_format,
            operation: filters.operation,
            since: filters.since,
          }),
        ),
    ),
  adminListErrorLogs: (page: number, pageSize: number, filters: AdminErrorLogFilters) => {
    const query = filterQuery({
      q: filters.query,
      source: filters.source,
      since: filters.since,
    })
    return api.get<AdminErrorLogData>(
      `${route("adminErrorLogs")}?page=${page}&page_size=${pageSize}${query ? `&${query}` : ""}`,
    )
  },
  adminDeleteErrorLogs: (events: Array<AdminErrorLogKey>) =>
    apiRequest<AdminDeleteErrorLogsData>("DELETE", route("adminErrorLogs"), { events }),
  adminListOrders: async () =>
    (await api.get<components["schemas"]["AdminPaymentOrderListData"]>(route("adminOrders")))
      .orders,
  adminConfirmOrder: (publicId: string) =>
    api.put<AdminPaymentOrderView>(
      route("adminOrdersByPublicIdConfirm", { public_id: publicId }),
    ),
  adminCancelOrder: (publicId: string) =>
    api.post<AdminPaymentOrderView>(
      route("adminOrdersByPublicIdCancel", { public_id: publicId }),
    ),
  adminListAiPrices: async () =>
    (await api.get<components["schemas"]["AiPricesData"]>(route("aiPrices"))).prices,
  adminPublishAiPrice: async (request: PublishAiPriceRequest) =>
    (await api.put<components["schemas"]["AiPricesData"]>(route("adminAiPrices"), request))
      .prices,
  adminDeleteAiPrice: async (model: string) =>
    (
      await apiRequest<components["schemas"]["AiPricesData"]>(
        "DELETE",
        route("adminAiPrices"),
        { model },
      )
    ).prices,
  adminCreateUser: async (request: AdminCreateUserRequest) => {
    const body = planUserCreate(await actorPlatformRole(), request)
    return (await api.post<AdminAccountMutation>(route("adminUsers"), body)).user
  },
  adminUpdateUser: async (request: AdminUpdateUserRequest) => {
    const uuid = request.uuid.trim()
    if (uuid.length === 0) throw refuse("admin_account_invalid", "账户无效")
    // Cloud has no get-by-id, so the directory is the "current" row the diff
    // runs against; the actor's own rank decides which changes are allowed.
    const [actor, directory] = await Promise.all([
      actorPlatformRole(),
      api.get<AdminUsersOverview>(route("adminUsers")),
    ])
    const current = findDirectoryPerson(directory, uuid)
    // Zero writes must not fall through to a fabricated view — the caller
    // would render plan/seat/token fields the server never stated.
    const writes = planUserUpdate(actor, current, request)
    if (writes.length === 0) {
      throw refuse("admin_account_no_changes", "没有需要更新的字段")
    }
    let user: AdminUserView | undefined
    for (const write of writes) {
      user = await adminUserWrite(uuid, write.segment, write.body)
    }
    if (!user) throw refuse("admin_account_no_changes", "没有需要更新的字段")
    return user
  },
  adminResetPassword: (request: AdminResetPasswordRequest) =>
    api.post<void>(route("adminUsersByUuidPassword", { uuid: request.uuid }), {
      password: request.password,
    }),
  adminDisableUser: (request: AdminUserUuidRequest) =>
    adminUserWrite(request.uuid, "status", { enabled: false }),
  // The account is the route, not a body field: Cloud's quota requests are
  // `deny_unknown_fields`, so `uuid` travels in the path only.
  adminPreviewUserQuotas: ({ uuid, ...quota }: AdminUserQuotaPreviewRequest) =>
    api.post<AdminMemberSeatPreviewData>(
      route("adminUsersByUuidMemberSeatsPreview", { uuid }),
      quota,
    ),
  adminApplyUserQuotas: ({ uuid, ...quota }: AdminUserQuotaApplyRequest) =>
    api.post<AdminMemberSeatApplyData>(
      route("adminUsersByUuidMemberSeatsApply", { uuid }),
      quota,
    ),
  adminWorkspaceWallet: (workspaceUuid: string) =>
    api.get<WalletTopupsData>(route("adminWorkspacesByUuidWallet", { uuid: workspaceUuid })),
  adminTopupWorkspaceWallet: (request: AdminWorkspaceWalletTopupRequest) =>
    api.post<WalletTopupsData>(
      route("adminWorkspacesByUuidWalletTopups", { uuid: request.workspace_uuid }),
      {
        operation_id: request.operation_id,
        amount_cents: request.amount_cents,
        note: request.note,
      },
    ),
  adminRevokeWorkspaceWalletTopup: (request: AdminWorkspaceWalletRevokeRequest) =>
    api.post<WalletTopupsData>(
      route("adminWorkspacesByUuidWalletTopupsByTopupIdRevoke", { uuid: request.workspace_uuid, topup_id: request.topup_id }),
    ),
}
