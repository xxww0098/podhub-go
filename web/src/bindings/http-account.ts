/**
 * Account HTTP wire: session, Workspace, notifications, payments, Agent workbench.
 *
 * Screens import `accountHttp` directly. This file is the binding — no
 * browser orchestration and no feature imports. Workflow lives in
 * `web/src/features/workflow/workflow-actions.ts`.
 */
import { api, request } from "@/api/client"
import { hashUploadBody, putDirectUpload } from "./direct-upload"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { beginErrorTelemetryContextChange } from "@/lib/error-telemetry"
import { invalidateAllSessionCaches, onSessionInvalidated } from "@/lib/session-cache"
import { clearInvitationCredential, invitationToken } from "@/lib/invitation-link"
import type {
  AccountChangePasswordRequest,
  AccountLoginRequest,
  AccountOverview,
  AccountRegisterRequest,
  AgentClaim,
  AgentLedgerEntry,
  AgentPayoutAccount,
  AgentPayoutAccountRequest,
  AgentTransfer,
  AgentWithdrawal,
  AgentWorkbench,
  AiRechargeOrderView,
  CreateWorkspaceInvitationRequest,
  NotificationReadView,
  NotificationsView,
  OcrQuotaData,
  PaymentMethodsData,
  PaymentOrderView,
  RedeemResultView,
  SeatCatalogData,
  AvatarSubjectView,
  WorkspaceBillingOverviewData,
  WorkspaceDirectoryView,
  WorkspaceInvitationCreatedView,
  WorkspaceStandingView,
  UsageStatsView,
} from "./commands"

/** The one composed projection the authenticated shell paints from. */
const ACCOUNT_OVERVIEW = route("viewAccountOverview")

/** Retire reads on both sides of the write; polls during it cannot restore diagnostics. */
async function withAccountContextChange<T>(write: () => Promise<T>): Promise<T> {
  const finish = beginErrorTelemetryContextChange()
  invalidateAllSessionCaches()
  try {
    return await write()
  } finally {
    invalidateAllSessionCaches()
    finish()
  }
}

/** A Workspace write is only interesting through the standing it produces. */
export async function accountOverview(): Promise<AccountOverview> {
  return api.get<AccountOverview>(ACCOUNT_OVERVIEW)
}

/**
 * The Workspace roster and Store slot state the shell shows around the switcher.
 * Cloud publishes the same five facts inside the overview; this is the slice
 * `NoWorkspaceScreen` and `WorkspaceSwitcher` take.
 */
function workspaceStanding(overview: AccountOverview): WorkspaceStandingView {
  return {
    workspaces: overview.workspaces,
    active_workspace: overview.active_workspace,
    account_mode: overview.account_mode ?? "unaffiliated",
    owned_count: overview.owned_count,
    owned_limit: overview.owned_limit,
  }
}

/**
 * `GET /api/workspaces/members` is camelCase on the wire; the directory screen
 * reads snake_case. One projection here beats renaming the fields on every
 * roster row, seat counter and invitation card.
 */
function workspaceDirectory(data: components["schemas"]["WorkspaceMembersData"]): WorkspaceDirectoryView {
  return {
    members: data.members.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      status: member.status,
      joined_at_ms: member.joined_at_ms,
      permissions: member.permissions,
    })),
    invitations: data.invitations.map((invitation) => ({
      id: invitation.id,
      uuid: invitation.uuid,
      email: invitation.email,
      role: invitation.role,
      invited_by_email: invitation.invited_by_email,
      created_at_ms: invitation.created_at_ms,
      expires_at_ms: invitation.expires_at_ms,
    })),
    seats_used: data.seats_used,
    pending_used: data.pending_used,
    pending_limit: data.pending_limit,
    permissions: data.permissions,
  }
}

/**
 * `GET /api/ai/wallet` answers three facts in one read: the balance, the
 * ledger page, and recent recharge orders. Callers that only want the balance
 * take `accountGetWallet`; the recharge dialog polls the detail for the
 * pending order's status flip.
 */
function walletDetail() {
  return api.get<components["schemas"]["WalletData"]>(route("aiWallet"))
}

/** The redeem receipt flattens Cloud's nested plan; the screen prints both. */
function redeemResult(data: components["schemas"]["RedeemData"]): RedeemResultView {
  return {
    plan_key: data.plan.key,
    plan_name: data.plan.name,
    member_seats: data.member_seats,
    ocr_credits: data.ocr_credits ?? 0,
    wallet_cents: data.wallet_cents ?? 0,
    replaced_lots: data.replaced_lots ?? 0,
    replaced_seats: data.replaced_seats ?? 0,
    plan_expires_at: data.plan_expires_at ?? undefined,
    ocr_expires_at: data.ocr_expires_at ?? undefined,
  }
}

export type AvatarSetRequest = { subject: AvatarSubjectView, image: Blob | Uint8Array, signal?: AbortSignal }
type AvatarTarget = components["schemas"]["DirectUploadTarget"]
type AvatarAttempt = { target: AvatarTarget, sha256: string, putStarted: boolean, confirmed: boolean }
const avatarAttempts = new Map<string, AvatarAttempt>()
const avatarFlights = new Map<string, AbortController>()
onSessionInvalidated(() => {
  for (const controller of avatarFlights.values()) controller.abort()
  avatarFlights.clear()
  avatarAttempts.clear()
})

function assertAvatarScope(controller: AbortController): void {
  if (controller.signal.aborted) throw Object.assign(new Error("头像操作已取消"), { code: "avatar_cancelled" })
}

/** Keep only redacted transport fields; no nested cause, grant URL or S3 XML. */
function avatarFailure(reason: unknown): Error {
  const fields = reason as { message?: string, code?: string, status?: number, retryAfterMs?: number, serverCode?: string, outcomeUnknown?: boolean }
  return Object.assign(new Error(fields?.message ?? "头像操作尚未确认，请重新选择同一图片重试"), {
    code: fields?.code, status: fields?.status, serverCode: fields?.serverCode,
    retryAfterMs: fields?.retryAfterMs, outcomeUnknown: fields?.outcomeUnknown,
  })
}

async function setAvatar(requestBody: AvatarSetRequest): Promise<AccountOverview> {
  const workspaceId = requestBody.subject.workspace.workspace_id
  const path = route("avatarsWorkspacesByWorkspaceId", { workspace_id: workspaceId })
  const grantPath = route("avatarsWorkspacesByWorkspaceIdUpload", { workspace_id: workspaceId })
  const controller = new AbortController()
  avatarFlights.get(path)?.abort()
  avatarFlights.set(path, controller)
  const abort = () => controller.abort()
  requestBody.signal?.addEventListener("abort", abort, { once: true })
  if (requestBody.signal?.aborted) controller.abort()
  const options = { callerSignal: controller.signal, reportOwner: "caller" as const }
  try {
    assertAvatarScope(controller)
    const bytes = requestBody.image instanceof Blob ? requestBody.image.size : requestBody.image.byteLength
    if (bytes < 3 || bytes > 256 * 1024) throw new Error("图片须为不超过 256KB 的 JPEG")
    const sha256 = await hashUploadBody(requestBody.image, controller.signal)
    assertAvatarScope(controller)
    let attempt = avatarAttempts.get(path)
    if (attempt && attempt.sha256 !== sha256) {
      avatarAttempts.delete(path)
      attempt = undefined
    }
    const init = async (): Promise<AvatarAttempt> => {
      if (!avatarAttempts.has(path) && avatarAttempts.size >= 8) throw new Error("尚有待确认的头像操作，请先完成确认或刷新账号后重试")
      const target = await request<AvatarTarget>("POST", grantPath,
        { bytes, sha256, content_type: "image/jpeg" } satisfies components["schemas"]["DirectUploadSpec"], {}, 30_000, undefined, options)
      assertAvatarScope(controller)
      const next = { target, sha256, putStarted: false, confirmed: false }
      // Expired or temporarily unavailable confirmations fail closed. Never
      // evict an unknown same-file attempt and silently retransmit its bytes.
      avatarAttempts.set(path, next)
      return next
    }
    attempt ??= await init()
    let sends = 0
    let putError: unknown
    while (!attempt.confirmed) {
      assertAvatarScope(controller)
      if (!attempt.putStarted) {
        attempt.putStarted = true
        if (attempt.target.upload) {
          sends++
          try {
            await putDirectUpload(attempt.target.upload, requestBody.image, {
              expectedByteLength: bytes, signal: controller.signal, timeoutMs: 60_000,
            })
          } catch (reason) { putError = reason }
          assertAvatarScope(controller)
        }
      }
      // Any uncertain PUT or prior failed confirmation is reconciled first.
      // Only this specific object-missing refusal permits another byte upload.
      try {
        await request("PUT", path, { upload_ticket: attempt.target.upload_ticket } satisfies components["schemas"]["PutAvatarRequest"], {}, 60_000, undefined, options)
        assertAvatarScope(controller)
        attempt.confirmed = true
      } catch (reason) {
        assertAvatarScope(controller)
        const code = (reason as { code?: string })?.code
        if (code !== "cloud_media_complete_missing") throw reason
        if (sends >= 2) throw putError ?? reason
        if (!attempt.target.upload || attempt.target.upload.expires_at_ms <= Date.now() + 5000) attempt = await init()
        else attempt.putStarted = false
      }
    }
    const overview = await request<AccountOverview>("GET", ACCOUNT_OVERVIEW, undefined, {}, 30_000, undefined, options)
    assertAvatarScope(controller)
    if (avatarAttempts.get(path) === attempt) avatarAttempts.delete(path)
    return overview
  } catch (reason) {
    throw avatarFailure(reason)
  } finally {
    requestBody.signal?.removeEventListener("abort", abort)
    if (avatarFlights.get(path) === controller) avatarFlights.delete(path)
  }
}

export const accountHttp = {
  accountGetOverview: accountOverview,
  accountSetAvatar: setAvatar,
  accountClearAvatar: async () => {
    const path = route("avatarsMe")
    avatarFlights.get(path)?.abort()
    avatarAttempts.delete(path)
    await api.del<void>(path)
    return accountOverview()
  },
  accountChangePassword: (request: AccountChangePasswordRequest) =>
    withAccountContextChange(() => api.post<void>(route("authPassword"), request)),
  accountRedeemCode: async (request: {
    code: string
    expected_workspace_uuid: string
  }) =>
    redeemResult(await api.post<components["schemas"]["RedeemData"]>(route("redeem"), request)),
  // One attempt id per purchase intent: a retry with the same id resumes the
  // pending order that attempt already committed (same public_id) instead of
  // answering PENDING_ORDER_EXISTS. Callers rotate it when the content changes.
  accountCreatePaymentIntent: async (request: components["schemas"]["PaymentIntentRequest"]): Promise<PaymentOrderView> =>
    (
      await api.post<components["schemas"]["PaymentOrderData"]>(route("paymentIntent"), request)
    ).order,
  accountCreateRenewalIntent: async (request: components["schemas"]["RenewalIntentRequest"]): Promise<PaymentOrderView> =>
    (
      await api.post<components["schemas"]["PaymentOrderData"]>(
        route("paymentIntentRenewal"),
        request,
      )
    ).order,
  accountGetOcrQuota: () => api.get<OcrQuotaData>(route("ocrQuota")),
  accountGetPaymentMethods: () => api.get<PaymentMethodsData>(route("paymentMethods")),
  // The purchasable seat catalog — Cloud's `billing::seats` price book as a
  // read projection; the `plans` rows on the same response are display
  // metadata the UI does not need.
  accountGetSeatCatalog: async (): Promise<SeatCatalogData> =>
    (await api.get<components["schemas"]["PlansData"]>(route("plans"))).seat_catalog,
  // The Workspace's entitlement overview: purchased lots, overrides, usage
  // and the next lot boundary — the plans page's per-lot truth.
  accountGetBillingOverview: (): Promise<WorkspaceBillingOverviewData> =>
    api.get<WorkspaceBillingOverviewData>(route("workspaceBillingOverview")),
  accountListPaymentOrders: async (filter?: {
    status?: string
    limit?: number
    cursor?: string
  }): Promise<PaymentOrderView[]> => (await accountHttp.accountListPaymentOrderPage(filter)).orders,
  accountListPaymentOrderPage: async (filter?: {
    status?: string
    limit?: number
    cursor?: string
  }) => {
    const params = new URLSearchParams()
    if (filter?.status) params.set("status", filter.status)
    if (filter?.limit != null) params.set("limit", String(filter.limit))
    if (filter?.cursor) params.set("cursor", filter.cursor)
    const suffix = params.size > 0 ? `?${params.toString()}` : ""
    return api.get<components["schemas"]["PaymentOrderListData"]>(`${route("orders")}${suffix}`)
  },
  accountGetPaymentOrder: async (publicId: string): Promise<PaymentOrderView> =>
    (
      await api.get<components["schemas"]["PaymentOrderData"]>(
        route("ordersByPublicId", { public_id: publicId }),
      )
    ).order,
  // The hosted checkout is the provider's own page, so it opens in a tab of
  // its own rather than replacing the workspace mid-purchase.
  accountOpenPaymentOrder: async (publicId: string) => {
    const { order } = await api.get<components["schemas"]["PaymentOrderData"]>(
      route("ordersByPublicId", { public_id: publicId }),
    )
    if (order.pay_url) window.open(order.pay_url, "_blank", "noopener")
  },
  accountCancelPaymentOrder: async (publicId: string): Promise<PaymentOrderView> =>
    (
      await api.post<components["schemas"]["PaymentOrderData"]>(
        route("ordersByPublicIdCancel", { public_id: publicId }),
      )
    ).order,
  // Query-first recovery of a pending order's payment entry. Cloud asks the
  // provider by merchant order id before anything is re-created; a re-issued
  // entry, entry_confirming, or the settled row comes back as the order.
  accountRecoverPaymentOrder: async (publicId: string): Promise<PaymentOrderView> =>
    (
      await api.post<components["schemas"]["PaymentOrderData"]>(
        route("ordersByPublicIdRecover", { public_id: publicId }),
      )
    ).order,
  accountLogin: async (request: AccountLoginRequest) => {
    await withAccountContextChange(() => api.post(route("authLogin"), request))
    return accountOverview()
  },
  accountRegister: async (request: AccountRegisterRequest) => {
    await withAccountContextChange(() => api.post(route("authRegister"), request))
    return accountOverview()
  },
  accountForgotPassword: (email: string) =>
    api.post<void>(route("authForgot"), { email }),
  accountResetPassword: (token: string, password: string) =>
    api.post<void>(route("authReset"), { token, password }),
  accountVerifyEmail: (token: string) =>
    api.post<void>(route("authVerify"), { token }),
  accountResendVerification: () =>
    api.post<void>(route("authVerifyResend")),
  accountLogout: async () => {
    await withAccountContextChange(() => api.post<void>(route("authLogout")))
    clearInvitationCredential()
  },
  // Account switching is cookie plumbing plus a repaint: Cloud promotes the
  // stacked session to `sid`, and the shell repaints from a fresh overview.
  accountSwitchAccount: async (uuid: string) => {
    await withAccountContextChange(() => api.post(route("authSwitch"), { uuid }))
    return accountOverview()
  },
  // Sign one stacked account out of this browser — the switcher row's "…".
  accountLogoutAccount: async (uuid: string) => {
    await withAccountContextChange(() => api.del<void>(route("authAccountsByUuid", { uuid })))
    clearInvitationCredential()
  },
  accountListWorkspaces: accountOverview,
  accountSwitchWorkspace: async (workspaceId: number) => {
    await withAccountContextChange(() => api.post(route("workspacesSwitch"), { workspace_id: workspaceId }))
    return accountOverview()
  },
  accountGetWorkspaceDirectory: async () =>
    workspaceDirectory(await api.get<components["schemas"]["WorkspaceMembersData"]>(route("workspacesMembers"))),
  accountCreateWorkspaceInvitation: (request: CreateWorkspaceInvitationRequest) =>
    api.post<WorkspaceInvitationCreatedView>(route("invitations"), request),
  accountCreateWorkspace: async (name: string) => {
    await withAccountContextChange(() => api.post(route("workspaces"), { name }))
    return workspaceStanding(await accountOverview())
  },
  accountRenameWorkspace: async (name: string) => {
    await api.put(route("workspacesName"), { name })
    return accountOverview()
  },

  accountRename: async (name: string) => {
    await api.put(route("authName"), { name })
    return accountOverview()
  },
  accountDissolveWorkspace: async (name: string) => {
    await withAccountContextChange(() => api.post(route("workspacesDissolve"), { name }))
    return accountOverview()
  },
  accountLeaveWorkspace: async (workspaceId?: number) => {
    await withAccountContextChange(() => api.post(
      route("workspacesLeave"),
      workspaceId == null ? undefined : { workspace_id: workspaceId },
    ))
    return accountOverview()
  },
  accountGetWallet: async () => (await walletDetail()).wallet,
  accountGetWalletDetail: walletDetail,
  // A top-up order is a Payment Order on the `wallet_topup` product: the
  // generic `/api/orders/*` reads are member-seats only, so recharge status
  // comes back through the wallet detail's `recharges` page.
  accountCreateRechargeOrder: async (request: {
    operation_id: string
    amount_cents: number
    provider: string
    expected_workspace_uuid: string
  }): Promise<AiRechargeOrderView> =>
    (
      await api.post<components["schemas"]["AiRechargeOrderData"]>(
        route("aiRechargeOrders"),
        request,
      )
    ).order,
  accountRecoverRechargeOrder: async (publicId: string): Promise<AiRechargeOrderView> =>
    (
      await api.post<components["schemas"]["AiRechargeOrderData"]>(
        route("aiRechargeOrdersByPublicIdRecover", { public_id: publicId }),
      )
    ).order,
  accountAcceptWorkspaceInvitation: async (uuid: string, token: string) => {
    await api.post<void>(route("invitationsByUuidAccept", { uuid }), { token: invitationToken(token) } satisfies components["schemas"]["InvitationProofRequest"])
    clearInvitationCredential(uuid)
  },
  accountDeclineWorkspaceInvitation: async (uuid: string, token: string) => {
    await api.post<void>(route("invitationsByUuidDecline", { uuid }), { token: invitationToken(token) } satisfies components["schemas"]["InvitationProofRequest"])
    clearInvitationCredential(uuid)
  },
  accountRevokeWorkspaceInvitation: (uuid: string) =>
    api.del<void>(route("invitationsByUuid", { uuid })),
  accountRemoveWorkspaceMember: (membershipId: number) =>
    api.del<void>(route("workspacesMembersById", { id: membershipId })),
  /** Owner-only roster edit: move one non-Owner member between 主管 and 运营. */
  accountChangeWorkspaceMemberRole: (membershipId: number, role: string) =>
    api.put<void>(route("workspacesMembersByIdRole", { id: membershipId }), { role }),
  accountListNotifications: (cursor?: string) =>
    api.get<NotificationsView>(
      cursor ? `${route("notifications")}?cursor=${encodeURIComponent(cursor)}` : route("notifications"),
    ),
  accountMarkNotificationRead: (uuid: string) =>
    api.post<NotificationReadView>(route("notificationsByUuidRead", { uuid })),
  accountMarkAllNotificationsRead: () =>
    api.post<NotificationReadView>(route("notificationsReadAll")),
  accountGetUsageStats: (options: {
    days?: number
    from?: string
    to?: string
    page: number
    pageSize: number
    summary?: boolean
  }) => {
    const range =
      options.from !== undefined && options.to !== undefined
        ? `from=${options.from}&to=${options.to}`
        : `days=${options.days ?? 30}`
    const summary = options.summary ? "&summary=1" : ""
    return api.get<UsageStatsView>(
      `${route("billingUsageStats")}?${range}&page=${options.page}&page_size=${options.pageSize}${summary}`,
    )
  },
  agentGetWorkbench: () => api.get<AgentWorkbench>(route("agent")),
  agentClaimCode: (code: string) =>
    api.post<AgentClaim>(route("agentClaim"), { code }),
  agentSetPayoutAccount: (request: AgentPayoutAccountRequest) =>
    api.put<AgentPayoutAccount | null>(route("agentPayoutAccount"), request),
  agentRequestWithdrawal: (amount_cents: number) =>
    api.post<AgentWithdrawal>(route("agentWithdrawals"), { amount_cents }),
  agentListWithdrawals: async () =>
    (await api.get<{ withdrawals: AgentWithdrawal[] }>(route("agentWithdrawals"))).withdrawals,
  agentListLedger: async () =>
    (await api.get<{ entries: AgentLedgerEntry[] }>(route("agentLedger"))).entries,
  agentTransferToWallet: (operation_id: string, amount_cents: number) =>
    api.post<AgentTransfer>(route("agentWalletTransfers"), { operation_id, amount_cents }),
}
