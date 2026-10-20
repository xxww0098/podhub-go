/**
 * Shared wire / view types for the SPA bindings.
 *
 * Runtime thunks live in `./http-*.ts`, `./render-opfs.ts` and
 * `web/src/features/workflow/workflow-actions.ts`. This file is types only —
 * no `commands` object and no re-export barrel.
 */
import type { components } from "@/api/schema"
import type { ListingRowView } from "./listing-projection"

export type CommandError = { code: string, message: string, remediation: string | null, };

/** Whether a device-local Ozon Store credential is present (integrations group). */
export type SecretRefStatus = components["schemas"]["SecretRefStatus"];

export type WorkspaceSummaryView = components["schemas"]["WorkspaceSummaryView"];

export type WorkspaceMemberStatusView = "active" | "manual_disabled" | "quota_suspended";

export type WorkspacePermissions = components["schemas"]["WorkspacePermissions"];

export type WorkspaceMemberPermissions = components["schemas"]["WorkspaceMemberPermissions"];

export type WorkspaceMemberView = { id: number, name: string, email: string, role: string, status: WorkspaceMemberStatusView, joined_at_ms: number, permissions: WorkspaceMemberPermissions, };

export type WorkspaceInvitationView = { id: number, uuid: string, email: string, role: string, invited_by_email: string, created_at_ms: number, expires_at_ms: number, };

export type WorkspaceDirectoryView = { members: Array<WorkspaceMemberView>, invitations: Array<WorkspaceInvitationView>, seats_used: number, pending_used: number, pending_limit: number, permissions: WorkspacePermissions, };

export type CreateWorkspaceInvitationRequest = components["schemas"]["CreateInvitationRequest"];

export type WorkspaceInvitationCreatedView = components["schemas"]["CreateInvitationData"];

export type AccountModeView = components["schemas"]["AccountMode"];

export type WorkspaceStandingView = { workspaces: Array<WorkspaceSummaryView>, active_workspace?: WorkspaceSummaryView, account_mode: AccountModeView, owned_count: number, owned_limit: number, };

export type InvitationStatusView = components["schemas"]["InvitationStatus"];

export type NotificationInvitationView = components["schemas"]["NotificationInvitation"];

export type NotificationView = components["schemas"]["NotificationView"];

export type NotificationsView = components["schemas"]["NotificationsData"];

export type NotificationReadView = components["schemas"]["NotificationReadData"];

export type AccountSessionView = components["schemas"]["AccountSessionView"];

/** One account on this browser's session stack, as the switcher prints it. */
export type StackedAccountView = components["schemas"]["StackedAccountView"];

export type EntitlementFeaturesView = components["schemas"]["EntitlementFeaturesView"];

export type EntitlementLimitsView = components["schemas"]["EntitlementLimitsView"];

export type EntitlementView = components["schemas"]["EntitlementView"];

/** `GET /api/view/account-overview` — one reply, the whole signed-in shell. */
export type AccountOverview = components["schemas"]["AccountOverviewData"];

export type RedeemResultView = { plan_key: string, plan_name: string, member_seats: number, ocr_credits: number, wallet_cents: number, replaced_lots: number, replaced_seats: number, plan_expires_at?: string, ocr_expires_at?: string, };

export type PaymentOrderView = components["schemas"]["PaymentOrderView"];

/** One purchasable tier/term/bound set — Cloud's `billing::seats` projection. */
export type SeatCatalogData = components["schemas"]["SeatCatalogData"];

export type SeatCatalogTierView = components["schemas"]["SeatCatalogTierView"];

/** One unexpired member-seat lot on the Workspace billing overview. */
export type MemberSeatLotView = components["schemas"]["MemberSeatLotView"];

/** What an upgrade to one purchasable tier would deduct right now. */
export type SeatUpgradeCreditView = components["schemas"]["SeatUpgradeCreditView"];

export type EntitlementChangeView = components["schemas"]["EntitlementChangeView"];

/** `GET /api/workspace/billing/overview` — the plans page's per-lot truth. */
export type WorkspaceBillingOverviewData =
  components["schemas"]["WorkspaceBillingOverviewData"];

export type AiRechargeOrderView = components["schemas"]["AiRechargeOrderView"];

export type OcrQuotaData = components["schemas"]["OcrQuotaData"];

export type PaymentMethodsData = components["schemas"]["PaymentMethodsData"];

export type PaymentProviderConfigData = { provider: string, enabled: boolean, configured: boolean, values: { [key in string]: string }, secretFieldsConfigured: Array<string>, };

export type PaymentConfigData = { revision: number, providers: Array<PaymentProviderConfigData>, };

export type ReplacePaymentProviderConfig = { provider: string, enabled: boolean, values: { [key in string]: string }, };

export type ReplacePaymentConfigRequest = { expectedRevision: number, providers: Array<ReplacePaymentProviderConfig>, };

export type SellerRelayData = components["schemas"]["SellerRelayData"];

export type SellerRelayProbeData = components["schemas"]["SellerRelayProbeData"];


export type AccountLoginRequest = { email: string, password: string, totpCode?: string, };

export type AccountChangePasswordRequest = { current_password: string, new_password: string, };

export type AccountRegisterRequest = { email: string, password: string, name: string, inviteCode?: string, };

/** `POST /api/agent/claim` — bind an invite code before the first paid order. */
export type AgentClaim = components["schemas"]["AgentClaimData"];

/** `GET /api/agent` — the signed-in Agent's own workbench (`docs/agent-rebate.md`). */
export type AgentWorkbench = components["schemas"]["AgentWorkbenchData"];

export type AgentCommissionView = components["schemas"]["AgentCommissionView"];

/** The Agent's commission wallet, as `GET /api/agent` reports it. */
export type AgentWalletView = components["schemas"]["AgentWalletView"];

export type AgentPayoutAccount = components["schemas"]["AgentPayoutAccountView"];

export type AgentPayoutAccountRequest = components["schemas"]["AgentPayoutAccountRequest"];

export type AgentWithdrawal = components["schemas"]["AgentWithdrawalView"];

export type AgentLedgerEntry = components["schemas"]["AgentLedgerEntryView"];

export type AgentTransfer = components["schemas"]["AgentTransferData"];

export type AdminAgentView = components["schemas"]["AdminAgentView"];

export type AdminAgentsOverview = components["schemas"]["AdminAgentListData"];

/** Filters the admin Agent roster accepts; blanks stay off the URL. */
export type AdminAgentFilters = {
  query?: string
  status?: string
  flagged?: boolean
};

export type AdminAgentCreateRequest = components["schemas"]["AdminAgentCreateRequest"];

export type AdminAgentRebatePolicy = components["schemas"]["AdminAgentRebatePolicyData"];

export type AdminAgentRebatePolicyRequest = components["schemas"]["AdminAgentRebatePolicyRequest"];

export type AdminAgentUpdateRequest = components["schemas"]["AdminAgentUpdateRequest"];

export type AdminAgentCommissionView = components["schemas"]["AdminAgentCommissionView"];

export type AdminAgentWithdrawal = components["schemas"]["AdminAgentWithdrawalView"];

export type AdminAgentCommissionsOverview = components["schemas"]["AdminAgentCommissionListData"];

export type AvatarSubjectView = { "workspace": { workspace_id: number, } };

export type SetAvatarRequest = { subject: AvatarSubjectView, image: Blob | Uint8Array, signal?: AbortSignal };

export type AdminUserView = components["schemas"]["AdminAccountView"];

export type AdminDirectoryPersonView = components["schemas"]["AdminDirectoryPersonView"];

export type AdminDirectoryWorkspaceView = components["schemas"]["AdminDirectoryWorkspaceView"];

export type AdminUsersOverview = components["schemas"]["AdminAccountsData"];

export type AdminRedeemCodeStatus = components["schemas"]["AdminRedeemCodeStatus"];

export type AdminRedeemCodeView = components["schemas"]["AdminRedeemCodeView"];

export type AdminRedeemCodeCreateRequestView = components["schemas"]["AdminRedeemCodeCreateRequest"];

export type AdminRedeemCodesOverview = components["schemas"]["AdminRedeemCodeListData"];

export type AdminRedeemCodeCreatedView = components["schemas"]["AdminRedeemCodeCreated"];

export type AdminRedeemCodesCreated = components["schemas"]["AdminRedeemCodeCreateData"];

export type AdminPaymentOrderView = components["schemas"]["AdminPaymentOrderView"];

export type AdminUsageFilters = { query: string, status: string, api_format: string, operation: string, since?: string, };

export type AdminUsageRequestView = { request_id: string, workspace_name: string, email: string, model: string, channel_name: string | null, thinking_depth: string | null, api_format: string | null, operation: string, status: string, input_tokens: number, output_tokens: number, cached_input_tokens: number, reasoning_output_tokens: number, total_microfen: number, charged_microfen: number, absorbed_microfen: number, error_class: string | null, upstream_error: string | null, created_at: string, latency_ms: number | null, generation_speed_milli_tps: number | null, };

export type AdminUsageData = { page: number, page_size: number, total_pages: number, total_rows: number, rows: Array<AdminUsageRequestView>, };

export type AdminUsageFailureClassView = { error_class: string, count: number, };

export type AdminUsageSummaryData = {
  total_rows: number,
  settled_rows: number,
  failed_rows: number,
  unbilled_unknown_rows: number,
  in_flight_rows: number,
  input_tokens: number,
  cached_input_tokens: number,
  cache_hit_rate_bps: number,
  output_tokens: number,
  charged_microfen: number,
  absorbed_microfen: number,
  latency_p50_ms: number | null,
  latency_p90_ms: number | null,
  latency_p99_ms: number | null,
  upstream_latency_p50_ms: number | null,
  upstream_latency_p90_ms: number | null,
  upstream_latency_p99_ms: number | null,
  generation_speed_milli_tps_median: number | null,
  failure_classes: Array<AdminUsageFailureClassView>,
};

export type AdminErrorLogFilters = { query: string, source: string, since?: string, };

export type AdminErrorLogKey = { event_id: string, device_uid: string, };

export type AdminErrorLogView = { event_id: string, workspace_name: string, email: string,
/**
 * Reporting device, for "how many distinct devices hit this" by eye.
 */
device_uid: string, source: string, code: string,
/**
 * `blocking` | `degraded`, or blank when the code prefix is unmapped.
 */
severity: string, fingerprint: string,
/**
 * v1 free text only. `desktop_error_log.v2` carries no message at all.
 */
message: string | null,
/**
 * v2 whitelisted structured params, verbatim JSON object text.
 */
params: string | null, app_version: string, os: string, occurred_at: string, received_at: string, };

export type AdminErrorLogData = { page: number, page_size: number, total_pages: number, total_rows: number, rows: Array<AdminErrorLogView>, };

export type AdminDeleteErrorLogsData = { deleted_count: number, };

export type AdminCreateUserRequest = { email: string, password: string, name?: string,
/**
 * `"user"` · `"admin"`. `"super_admin"` is created only by `admin init`, never here;
 * Cloud re-checks with `authorize`.
 */
role: string, };

export type AdminUpdateUserRequest = { uuid: string, role?: string, enabled?: boolean, };

export type AdminResetPasswordRequest = { uuid: string, password: string, };

export type AdminUserUuidRequest = { uuid: string, };

export type AdminDissolveWorkspaceRequest = { workspace_uuid: string, name: string, };

export type AdminUserQuotaPreviewRequest = { uuid: string, workspace_id?: number, member_seats_override?: number, follow_plan_member_seats: boolean, store_limit_override?: number, follow_plan_store_limit: boolean, };

export type AdminUserQuotaApplyRequest = { uuid: string } & components["schemas"]["AdminMemberSeatApplyRequest"];

export type AdminWorkspaceWalletTopupRequest = { workspace_uuid: string,
/**
 * Client-chosen identity of this one grant attempt; a retry of the same
 * submission carries the same value, a new operation mints a new one.
 */
operation_id: string,
/**
 * Fen to credit; positive only. A mistake is taken back by revoking it.
 */
amount_cents: number, note?: string, };

export type AdminWorkspaceWalletRevokeRequest = { workspace_uuid: string, topup_id: string, };

export type WalletTopupView = { id: string, amount_microfen: number, note: string, created_at: string, revoked_at?: string, };

export type WalletTopupsData = { balance_microfen: number, held_microfen: number, available_microfen: number, topups: Array<WalletTopupView>, };

export type AdminMemberSeatPreviewData = { revision: number, plan: string, memberSeats: WorkspaceQuotaView, suspend: Array<MemberSeatMembershipChange>, restore: Array<MemberSeatMembershipChange>,
/**
 * Store quota projection when the target plan also changes Store slots. The
 * arrays are absent when the apply changes no store quota (server skips
 * empty) — read them as optional or `.length` throws on the common path.
 */
storeSlots?: WorkspaceQuotaView, storeSuspend?: Array<WorkspaceStoreQuotaChange>, storeRestore?: Array<WorkspaceStoreQuotaChange>, };

export type AdminMemberSeatApplyData = { ok: boolean, revision: number, plan: string, memberSeats: WorkspaceQuotaView, suspend: Array<MemberSeatMembershipChange>, restore: Array<MemberSeatMembershipChange>,
/**
 * Store quota projection produced by the same atomic plan apply — absent
 * when no store quota changed (server skips empty).
 */
storeSlots?: WorkspaceQuotaView, storeSuspend?: Array<WorkspaceStoreQuotaChange>, storeRestore?: Array<WorkspaceStoreQuotaChange>, };

export type MemberSeatChangeAction = "SUSPEND" | "RESTORE";

export type MemberSeatMembershipChange = { membership_id: number, user_id: number, join_order: number, action: MemberSeatChangeAction, };

export type WorkspaceQuotaView = {
/**
 * Plan default for this resource.
 */
default: number,
/**
 * Workspace override; null means the plan default applies.
 */
overrideValue?: number,
/**
 * Effective quota after applying the Workspace override.
 */
effective: number,
/**
 * Currently in-use quantity.
 */
used: number,
/**
 * Quantity suspended by quota enforcement.
 */
suspended: number, };

export type WorkspaceStoreQuotaChange = { uuid: string, createOrder: number, action: WorkspaceStoreQuotaChangeAction, };

export type WorkspaceStoreQuotaChangeAction = "SUSPEND" | "RESTORE";

export type UsageRequestRowView = components["schemas"]["UsageRequestRow"];

export type UsageStatsView = components["schemas"]["UsageStatsData"];

export type AiApiFormat = "chat_completions" | "anthropic_messages" | "responses";

export type AiThinking = "provider_default" | false | "low" | "medium" | "high";

export type AiThinkingFormat = "none" | "reasoning_effort" | "enable_thinking" | "thinking_type" | "anthropic_budget" | "anthropic_adaptive";

export type AiAccountView = { id: string, label: string, ref_id: string, configured: boolean, active: boolean, base_url: string, api_format: AiApiFormat, model: string, thinking: AiThinking, thinking_format: AiThinkingFormat,
/**
 * Pool dispatch preference: higher goes first, ties round-robin.
 */
priority: number, };

export type AiModelOption = { id: string, owned_by: string, };

export type AiPriceView = components["schemas"]["AiPriceView"];

export type WalletView = components["schemas"]["WalletView"];

export type PublishAiPriceRequest = { model: string,
/**
 * `token` or `per_request`（按次）.
 */
billing_mode: string, input_microfen_per_million: number, cached_input_microfen_per_million: number, output_microfen_per_million: number, reasoning_microfen_per_million: number,
/**
 * Flat microfen per settled call; positive only in `per_request` mode.
 */
per_request_microfen: number, max_request_microfen: number, };

export type IntegrationMediaProvider = "legacy_s3" | "cloudflare" | "qiniu" | "tencent" | "aliyun" | "generic";

export type IntegrationMediaRole = "transit" | "assets" | "private";

export type MediaAccountView = { id: string, label: string, role: IntegrationMediaRole, provider: IntegrationMediaProvider, ref_id: string, configured: boolean, active: boolean, endpoint: string, region: string, bucket: string, key_prefix: string, public_base_url: string, force_path_style: boolean, };

export type MediaConnectionTestResult = { latency_ms: number, };

export type MediaStorageRequest = { id: string, prefix: string, };

export type MediaStorageGroupRow = { prefix: string, workspaceName: string, objects: number, bytes: number, };

export type MediaStorageData = { accountId: string, bucket: string, prefix: string, objects: number, bytes: number, truncated: boolean, scannedAtMs: number, groups: Array<MediaStorageGroupRow>, };

export type MediaPurgeData = { accountId: string, prefix: string, deleted: number, missing: number, failed: number, bytes: number, remaining: boolean, };

export type MediaStorageObjectKind = components["schemas"]["MediaStorageObjectKind"];

export type MediaStorageObjectView = components["schemas"]["MediaStorageObjectView"];

export type MediaStorageObjectsData = components["schemas"]["MediaStorageObjectsData"];

export type MediaStorageDeleteData = components["schemas"]["MediaStorageDeleteData"];

export type MediaStorageUploadTarget = components["schemas"]["MediaStorageUploadTarget"];

export type SupplierDbStorageObjectKind = components["schemas"]["SupplierDbStorageObjectKind"];

export type SupplierDbStorageObjectView = components["schemas"]["SupplierDbStorageObjectView"];

export type SupplierDbStorageObjectsData = components["schemas"]["SupplierDbStorageObjectsData"];

export type SupplierDbStorageDeleteData = components["schemas"]["SupplierDbStorageDeleteData"];

export type SupplierDbStorageUploadTarget = components["schemas"]["SupplierDbUploadTarget"];

export type IntegrationCredentialsOverview = { ai_default_model: string, ai_accounts: Array<AiAccountView>,
/**
 * 三个桶角色各一个账号：transit（每日 04:00 清空）、assets（公开素材库）、
 * private（组织私有，无公开域名）。服务端逐字校验桶名与公开域名。
 */
media_accounts: Array<MediaAccountView>,
};

export type OzonStoreView = components["schemas"]["OzonStoreView"];

export type OzonStoresOverview = components["schemas"]["OzonStoresOverview"];

export type ConsoleLedgerEntry = components["schemas"]["ConsoleLedgerEntry"];

export type ConsoleStoreMetrics = components["schemas"]["ConsoleStoreMetrics"];

export type ConsoleSnapshot = components["schemas"]["ConsoleSnapshot"];

export type ConsoleStoreRefreshResult = components["schemas"]["ConsoleStoreRefreshResult"];

export type ConsoleRefreshMetricsResponse = components["schemas"]["ConsoleRefreshMetricsResponse"];

export type ImportOzonStoreResultView = { source_ref: string, name: string, status: string, uuid: string | null, quota_suspended: boolean, reason: string | null, };

export type ImportOzonStoresResult = { results: Array<ImportOzonStoreResultView>, overview: OzonStoresOverview, };

export type CreateOzonStoreRequest = { label: string, };

export type UpsertOzonStoreRequest = { id: string, label: string, client_id: string,
/**
 * Empty keeps the existing API Key when the store is already configured.
 */
api_key: string, };

export type ListAiModelsRequest = {
/**
 * Existing account id; used to load the stored key when `api_key` is empty.
 */
id: string | null, base_url: string, api_format: AiApiFormat,
/**
 * Draft key override. Empty falls back to the stored key for `id`.
 */
api_key: string, };

export type UpsertMediaAccountRequest = { role: IntegrationMediaRole, label: string, provider: IntegrationMediaProvider, endpoint: string, region: string, bucket: string, key_prefix: string, public_base_url: string, force_path_style: boolean, access_key_id: string, secret_access_key: string, session_token: string, };

export type AccountIdRequest = { id: string, };
export type AssignOzonStoreRequest = { id: string, membership_id: number | null, };

export type ProductOfficialState = components["schemas"]["ProductOfficialState"];

export type ProductSyncDomain = components["schemas"]["ProductSyncDomain"];

export type ProductMonitorRequest = components["schemas"]["ProductMonitorRequest"];

export type ProductMonitorItem = components["schemas"]["ProductMonitorItem"];

export type ProductMonitorSyncState = components["schemas"]["ProductMonitorSyncState"];

export type ProductStorePerformance = components["schemas"]["ProductStorePerformance"];

export type ProductMonitorSnapshot = components["schemas"]["ProductMonitorSnapshot"];

export type ProductMetricsRequest = components["schemas"]["ProductMetricsRequest"];

export type ProductMetricsItem = components["schemas"]["ProductMetricsItem"];

export type ProductMetricsSnapshot = components["schemas"]["ProductMetricsSnapshot"];

export type ProductWarehousesRequest = components["schemas"]["ProductWarehousesRequest"];

export type ProductWarehouseView = components["schemas"]["ProductWarehouseView"];

export type ProductWarehouseStockView = components["schemas"]["ProductWarehouseStockView"];

export type ProductWarehousesView = components["schemas"]["ProductWarehousesView"];

export type OpsReturnsListRequest = components["schemas"]["OpsReturnsListRequest"];

export type OpsReturnRowView = components["schemas"]["OpsReturnRowView"];

export type OpsReturnsListView = components["schemas"]["OpsReturnsListView"];

export type OpsCancellationsListRequest = components["schemas"]["OpsCancellationsListRequest"];

export type OpsCancellationRowView = components["schemas"]["OpsCancellationRowView"];

export type OpsCancellationsListView = components["schemas"]["OpsCancellationsListView"];

export type ProductPromotionsRequest = components["schemas"]["ProductPromotionsRequest"];

export type ProductPromotionActionView = components["schemas"]["ProductPromotionActionView"];

export type ProductPromotionOfferView = components["schemas"]["ProductPromotionOfferView"];

export type ProductPromotionsView = components["schemas"]["ProductPromotionsView"];

export type SupplyListRequest = components["schemas"]["SupplyListRequest"];

export type SupplyOrderView = components["schemas"]["SupplyOrderView"];

export type SupplyStatusCountView = components["schemas"]["SupplyStatusCountView"];

export type SupplyListView = components["schemas"]["SupplyListView"];

export type SupplyWarehouseStocksRequest = components["schemas"]["SupplyWarehouseStocksRequest"];

export type SupplyWarehouseStockView = components["schemas"]["SupplyWarehouseStockView"];

export type SupplyWarehouseStocksView = components["schemas"]["SupplyWarehouseStocksView"];

export type VoiceSourceKind = components["schemas"]["VoiceSourceKind"];

export type OpsVoiceReviewsRequest = components["schemas"]["OpsVoiceReviewsRequest"];

export type OpsVoiceReviewItem = components["schemas"]["OpsVoiceReviewItem"];

export type OpsVoiceReviewsView = components["schemas"]["OpsVoiceReviewsView"];

export type OpsVoiceQuestionsRequest = components["schemas"]["OpsVoiceQuestionsRequest"];

export type OpsVoiceQuestionItem = components["schemas"]["OpsVoiceQuestionItem"];

export type OpsVoiceQuestionsView = components["schemas"]["OpsVoiceQuestionsView"];

export type OpsVoiceChatsRequest = components["schemas"]["OpsVoiceChatsRequest"];

export type OpsVoiceChatItem = components["schemas"]["OpsVoiceChatItem"];

export type OpsVoiceChatsView = components["schemas"]["OpsVoiceChatsView"];

export type MessageCenterStoreRef = components["schemas"]["MessageCenterStoreRef"];

export type MessageCenterInboxRequest = components["schemas"]["MessageCenterInboxRequest"];

export type MessageCenterChatItem = components["schemas"]["MessageCenterChatItem"];

export type MessageCenterStoreView = components["schemas"]["MessageCenterStoreView"];

export type MessageCenterFailedStore = components["schemas"]["MessageCenterFailedStore"];

export type MessageCenterInboxView = components["schemas"]["MessageCenterInboxView"];

export type MessageCenterHistoryRequest = components["schemas"]["MessageCenterHistoryRequest"];

export type MessageCenterMessageView = components["schemas"]["MessageCenterMessageView"];

export type MessageCenterHistoryView = components["schemas"]["MessageCenterHistoryView"];

export type MessageCenterSendRequest = components["schemas"]["MessageCenterSendRequest"];

export type MessageCenterSendView = components["schemas"]["MessageCenterSendView"];

export type ProductStockMutationItem = components["schemas"]["ProductStockMutationItem"];

export type ProductPriceMutationItem = components["schemas"]["ProductPriceMutationItem"];

export type ProductPromotionMutationItem = components["schemas"]["ProductPromotionMutationItem"];

export type ProductMutationRequest = components["schemas"]["ProductMutationRequest"];

export type ProductMutationCommand = components["schemas"]["ProductMutationCommand"];

export type ProductMutationItemResult = components["schemas"]["ProductMutationItemResult"];

export type ProductMutationResponse = components["schemas"]["ProductMutationResponse"];

export type ShippingListRequest = components["schemas"]["ShippingListRequest"];

export type ShippingPostingProductView = components["schemas"]["ShippingPostingProductView"];

export type ShippingPostingView = components["schemas"]["ShippingPostingView"];

export type ShippingListView = components["schemas"]["ShippingListView"];

export type AssetHandle = string;

export type PickedPsdAsset = { handle: AssetHandle,
/**
 * Basename only — never a directory or absolute path.
 */
file_name: string, };

export type CanvasSummary = { width: number, height: number, bits_per_channel: number, };

export type FeatureSummary = { layers: number, groups: number, smart_objects: number, masks: number, warped_smart_objects: number, blend_modes: { [key in string]: number }, };

export type BoundsSummary = { left: number | null, top: number | null, right: number | null, bottom: number | null, };

export type GroupSummary = { name: string, bounds: BoundsSummary, };

export type SlotSummary = { id: string, name: string, src_w: number, src_h: number, instances: number, };

export type PsdInspectSummary = { handle: string, file_name: string, canvas: CanvasSummary, features: FeatureSummary, top_groups: Array<GroupSummary>, slots: Array<SlotSummary>, capabilities: Array<string>, };

export type FieldValueOriginKind = "card_default" | "seller_sku" | "manual" | "ai_confirmed" | "system_media";

export type FieldValueOrigin = { address: FieldAddress, kind: FieldValueOriginKind, source_ref?: string, updated_at_ms: number, };

export type FieldAddress = { "kind": "plain", field_key: string, } | { "kind": "complex", group_key: string, item_id: string, field_key: string, value_index?: number, };

export type ReconciliationDecision = "reconciled" | "conflict" | "still_unknown";

export type ReconciliationChecked = { offer_id: string, task_id?: string, request_digest: string, expected_name: string, };

export type ReconciliationFound = { summary: string, product_id?: string,
/**
 * Positive Ozon storefront SKU. Absent until the product probe returns it.
 */
sku?: number, remote_name?: string, task_status?: string, };

export type ReconciliationResolution = { checked: ReconciliationChecked, found: ReconciliationFound, decided: ReconciliationDecision, reason: string, resolved_at_ms: number, };

export type ReconcileEntryOutcome = components["schemas"]["ReconcileEntryOutcome"];

export type ReconcileEntry = components["schemas"]["ReconcileEntry"];

export type ReconcileOperationsResponse = components["schemas"]["ReconcileOperationsResponse"];

export type CancelPrepareRequest = { draft_ids: Array<string>, };

export type OperationStatus = components["schemas"]["OperationStatus"];

export type OperationView = { run_id: string, draft_id: string, offer_id: string, status: OperationStatus, idempotency_key: string, intent_id?: string, task_id?: string, error_kind?: string, error_message?: string, resolution?: ReconciliationResolution, created_at_ms: number, updated_at_ms: number, };

export type SubmitDraftResponse = { operation: OperationView,
/**
 * True when an existing Intent was reused without creating a new one.
 */
replayed: boolean, };

export type WorkflowLanguage = "default" | "ru" | "en" | "tr" | "zh_hans";

export type CategorySchemaRequest = { description_category_id: number, type_id: number, language?: WorkflowLanguage,
/**
 * Optional Store binding used while creating a card. Existing saved
 * cards never resolve live metadata and therefore omit this field.
 */
target_store_id?: string, };

export type CategoryTreeRequest = { language?: WorkflowLanguage, target_store_id?: string, };

export type CategoryTreeNodeView = { description_category_id: number, category_name: string, type_id: number, type_name: string, disabled: boolean, children: Array<CategoryTreeNodeView>, };

export type CategoryDictionarySearchRequest = { description_category_id: number, type_id: number, language?: WorkflowLanguage, target_store_id?: string, field_key: string, query: string, limit: number, };

export type CategoryFieldSource = "fixed" | "attribute";

export type CategoryFieldEditor = "text" | "integer" | "decimal" | "boolean" | "single_select" | "multi_select" | "dictionary_search" | "url" | "url_list";

export type CategoryFieldConstraints = { required: boolean, collection: boolean, max_value_count?: number, dictionary_id?: number, };

export type CategoryFieldOption = { id: number, value: string, info: string, picture: string, };

/** @aspect@ is Ozon's @is_aspect@: @true@/@false@ are Seller facts, and
 * @null@ means the category material predates it — the variant rule is
 * *unknown*, so it must ask for a refresh rather than read as "not a
 * dimension". Always present, never omitted, exactly as the Rust DTO
 * serializes it. */
export type CategoryFieldView = { key: string, name: string, description: string, group_name: string, source: CategoryFieldSource, editor: CategoryFieldEditor, raw_type?: string, attribute_id?: number, complex_id?: number, complex_group_collection: boolean, read_only: boolean, aspect: boolean | null, constraints: CategoryFieldConstraints, options: Array<CategoryFieldOption>, options_truncated: boolean, };

export type CategoryComplexGroup = { complex_id: number, name: string, collection: boolean, field_keys: Array<string>, };

export type CategorySchemaView = { description_category_id: number, type_id: number, language?: WorkflowLanguage, fields: Array<CategoryFieldView>, complex_groups: Array<CategoryComplexGroup>, };

export type WorkflowDraftSelection = { dictionary_value_id: number, value: string, };

export type WorkflowDraftValue = { "kind": "text", "value": string } | { "kind": "text_list", "value": Array<string> } | { "kind": "integer", "value": number } | { "kind": "integer_list", "value": Array<number> } | { "kind": "decimal", "value": number } | { "kind": "decimal_list", "value": Array<number> } | { "kind": "boolean", "value": boolean } | { "kind": "boolean_list", "value": Array<boolean> } | { "kind": "single_select", "value": WorkflowDraftSelection } | { "kind": "multi_select", "value": Array<WorkflowDraftSelection> } | { "kind": "url", "value": string } | { "kind": "url_list", "value": Array<string> };

export type WorkflowComplexDraftItem = { item_id?: string, values: { [key in string]: WorkflowDraftValue }, };

export type WorkflowComplexDraftGroup = { complex_id: number, items: Array<WorkflowComplexDraftItem>, };

export type WorkflowCategoryDraft = { values: { [key in string]: WorkflowDraftValue }, complex_values: Array<WorkflowComplexDraftGroup>, cleared?: Array<string>, };

export type ListingCardCreateMode = "blank" | "copyCard"

export type SaveWorkflowDraftRequest = { draft_id?: string, display_name?: string, schema: CategorySchemaRequest, draft: WorkflowCategoryDraft, ai_prompt_id: string, ai_prompt: string, ai_prompt_file_name: string, psd_template_asset_id: string, psd_template_file_name: string,
/**
 * New-card only. PATCH ignores this. `blank` is the default.
 */
createMode?: ListingCardCreateMode,
/**
 * The card is bound to exactly one Seller Store at creation time. An
 * empty value is accepted only by the legacy draft/editor path; card
 * creation supplies this field and the service validates it against the
 * local Store roster.
 */
target_store_id: string,
/**
 * Explicit AI allow-list. Protected and media-owned fields are removed
 * by the service before persistence, so a renderer cannot authorize
 * unsafe inference through prompt text or a forged request.
 */
ai_allowed_field_keys: Array<string>,
/**
 * Origin applied only to values that changed in this save. The Listing
 * Draft compares the previous snapshot and preserves every untouched
 * field's existing origin.
 */
value_origin_kind?: FieldValueOriginKind, value_origin_source_ref?: string,
/**
 * Field edits stay available while the queue owns the card: a running
 * batch freezes dispatch, not the operator's ability to correct the rows
 * it has not reached yet. The claim proves the caller belongs to the
 * current queue generation; without it a frozen card stays read-only.
 */
queue_claim_token?: string,
};

export type ListingCardSkuImportPreviewRequest = { draft_id: string, sku: string, };

export type SkuImportSelection = { dictionary_value_id: number, value: string, };

export type SkuImportValue = { "kind": "text", "value": string } | { "kind": "text_list", "value": Array<string> } | { "kind": "integer", "value": number } | { "kind": "integer_list", "value": Array<number> } | { "kind": "decimal", "value": number } | { "kind": "decimal_list", "value": Array<number> } | { "kind": "boolean", "value": boolean } | { "kind": "boolean_list", "value": Array<boolean> } | { "kind": "single_select", "value": SkuImportSelection } | { "kind": "multi_select", "value": Array<SkuImportSelection> } | { "kind": "url", "value": string } | { "kind": "url_list", "value": Array<string> };

export type SkuImportLocation = { "kind": "plain" } | { "kind": "complex", complex_id: number, item_index: number, };

export type SkuImportCandidate = { candidate_id: string, field_key: string, field_name: string, group_name: string, location: SkuImportLocation, value: SkuImportValue, };

export type SkuImportPreview = { source_sku: number, source_product_id: number, source_offer_id: string, source_name: string, source_description_category_id: number, source_type_id: number, category_matches: boolean, candidates: Array<SkuImportCandidate>, skipped_fields: number, };

export type WorkflowAiFieldPolicy = { allowed_field_keys: Array<string>, protected_field_keys: Array<string>, };

export type WorkflowAttachVideoRequest = { draft_id: string, metadata: WorkflowVideoMetadata,
/**
 * Present when the queue is claimed — a pooled video is attached from the
 * card surface that repairs frozen products.
 */
queue_claim_token?: string, };

export type ListingCardAttachVideoToProductsRequest = { card_draft_id: string, target_draft_ids: Array<string>, role: WorkflowVideoRole, video_identity: string, queue_claim_token?: string, };

export type WorkflowMediaBindingResult = { draft_id: string, lifecycle?: WorkflowProductLifecycle, error?: string, };

export type WorkflowPickVideoRequest = {
/**
 * New-card staging happens before a durable card ID exists. Staging is
 * local-only; queue fencing is required only when an existing Draft is
 * being edited.
 */
draft_id?: string, queue_claim_token?: string, role: WorkflowVideoRole, paths: Array<string>,
/**
 * Maximum number of files the renderer can still stage in this dialog.
 */
selection_limit: number, };

export type WorkflowPendingVideo = { asset_handle: string, metadata: WorkflowVideoMetadata, };

export type WorkflowUploadVideoRequest = { draft_id: string, role: WorkflowVideoRole, asset_handle: string, queue_claim_token?: string, };

export type WorkflowSetQueuePositionRequest = { draft_id: string, position: number,
/**
 * Reordering the not-yet-dispatched tail is a queue-owned edit, so it
 * carries the current queue claim like every other in-flight mutation.
 */
queue_claim_token?: string, };

export type WorkflowVideoUploadResult = { metadata: WorkflowVideoMetadata, public_url: string, object_key: string, lifecycle: WorkflowProductLifecycle, };

export type WorkflowVideoOrigin = "managed_upload" | "public_url";

export type WorkflowDraftKind = "template" | "instance";

export type WorkflowDraftValidationState = "draft" | "valid" | "invalid";

export type RowStage = components["schemas"]["RowStageView"];

export type FieldLayerView = components["schemas"]["FieldLayerView"];

export type WorkflowAiPhase = components["schemas"]["WorkflowAiPhase"];

export type WorkflowMediaPhase = components["schemas"]["WorkflowMediaPhase"];
export type WorkflowMediaStage = components["schemas"]["WorkflowMediaStage"];

export type WorkflowMediaUploadPhase = "queued" | "hashing" | "uploading" | "certifying" | "public_ready" | "failed";

export type WorkflowMediaUploadProgress = { draft_id: string, role: WorkflowVideoRole, phase: WorkflowMediaUploadPhase, bytes_sent: number, total_bytes: number, };

export type WorkflowImagePhase = "rendered" | "uploading" | "public_ready" | "failed";

export type WorkflowFieldPhase = components["schemas"]["WorkflowFieldPhase"];

export type WorkflowReadinessBlockerCode = components["schemas"]["WorkflowReadinessBlockerCode"];

export type WorkflowAllowedAction = components["schemas"]["WorkflowAllowedAction"];

export type WorkflowReadinessReport = components["schemas"]["WorkflowReadinessReport"];

export type WorkflowImageLifecycle = { index: number, file_name: string, content_hash: string,
/**
 * PSD top-level group this slice was exported from. It is the sole
 * authority for the slice's Seller media role (see `media_role_of`) and
 * the reason a delivery can be replayed after a restart without a
 * re-render. Records written before this field existed decode as `""`,
 * which reads as "role unknown — re-render required".
 */
group_name: string,
/**
 * Rendered pixel size. Persisted so a delivery can be replayed without
 * a re-render.
 */
width: number, height: number, byte_size?: number, phase: WorkflowImagePhase, public_url?: string,
/**
 * Media Object Key bound to the Content Lease (allowlisted).
 */
object_key?: string, account_id?: string, error_code?: string, };

export type WorkflowFailureStage = "ai" | "media" | "validation" | "publish" | "recovery";

export type WorkflowFailureLogEntry = { stage: WorkflowFailureStage, code: string, message: string, remediation?: string, image_index?: number, occurred_at_ms: number, };

export type WorkflowAiSummary = { tags: Array<string>, model: string, };

export type SubmissionReceipt = components["schemas"]["ListingSubmissionReceipt"];

export type ListingIssue = components["schemas"]["ListingIssue"];

/** Read-only progress of an unknown import. The server names the phase. */
export type ImportProbe = {
  phase: "checking" | "needs_manual"
  passes: number
  nextCheckAtMs?: number
}

/** Read-only progress after Ozon has accepted the import. The server names the phase. */
export type ImportFollowup = {
  phase: "pending" | "moderating" | "created" | "import_failed" | "moderation_failed" | "skipped"
  detail: string
}

export type WorkflowProductLifecycle = { revision: number, view_revision: number, stage: RowStage, ai: WorkflowAiPhase, media: WorkflowMediaPhase, media_failure_stage?: WorkflowMediaStage, image_total: number, image_completed: number, fields: WorkflowFieldPhase, images: Array<WorkflowImageLifecycle>,
/**
 * Bounded newest failure history. Entries contain only messages already
 * approved for CommandError; credentials, signed URLs and raw provider
 * bodies must never enter this projection.
 */
failure_log: Array<WorkflowFailureLogEntry>,
/**
 * Committed render directory name. It is a bare path segment, never a
 * filesystem path, and it is what lets the renderer ask for a local slice
 * thumbnail before (and after) delivery.
 */
output_directory_name?: string, queue_position?: number,
/**
 * Candidate edits are durable Product Instance evidence. Recognition
 * settles them locally; Listing sync and validation happen on send.
 */
ai_candidates: Array<WorkflowAiCandidate>,
/**
 * Recognition evidence with no Draft field of its own. Persisted so the
 * recognition rail still shows what the model saw after a restart.
 */
ai_summary?: WorkflowAiSummary,
/**
 * Listing-owned Draft identity used by send-time sync and validation.
 */
listing_draft_ref?: DraftRef,
/**
 * Source provenance for the Product Instance. These fields are safe to
 * persist (basename/opaque handle only) and let the recognition rail be
 * rebuilt after an application restart without React-owned truth.
 */
source_file_name?: string, source_asset_handle?: string,
/**
 * Product videos are ordered and repeatable. Ozon receives one semantic
 * complex-media item per certified public URL.
 */
product_videos: Array<WorkflowVideoMetadata>, video_cover?: WorkflowVideoMetadata,
submissionReceipt?: SubmissionReceipt,
taskId?: string,
/**
 * Derived read-only projection of the Publish Machine's durable Run
 * identity (populated when decoding, never persisted — the machine and
 * the Runs ledger stay authoritative). Used by the renderer to join
 * reconciliation entries to a Product Instance.
 */
run_id?: string,
/**
 * Positive Ozon storefront SKU projected from the latest Run's product
 * probe, including conflict. `persist_json` strips it so Runs stays the
 * sole receipt.
 */
ozon_sku?: number,
/**
 * Positive Ozon product_id from the same probe as `ozon_sku`. Needed for
 * post-listing stock writes. `persist_json` strips it.
 */
ozon_product_id?: number, last_error_code?: string,
/**
 * Operator-facing Chinese exception, projected from the Run ledger.
 * `persist_json` strips it so `last_error_code` remains the durable identity.
 */
last_error_detail?: string, submission_issue?: ListingIssue, importProbe?: ImportProbe, importFollowup?: ImportFollowup, };

export type WorkflowProductSaveResult = { saved: WorkflowDraftView; status: WorkflowProductStatusView };

export type WorkflowProductStatusView = { lifecycle: WorkflowProductLifecycle, readiness: WorkflowReadinessReport, target_store_id: string, draft?: WorkflowCategoryDraft, validation_state?: WorkflowDraftValidationState, issues?: Array<WorkflowValidationIssue>, /** Build sources flattened to plain field keys (`row-state.ts::buildSourceLayers`). */ source_layers?: Record<string, FieldLayerView>, };

export type WorkflowRestoredProductInstance = { draft_id: string, source?: PickedPsdAsset, status?: WorkflowProductStatusView, };

export type QueueHaltReason = "operator_pause" | "operator_stop" | "auth_expired" | "grant_blocked" | "store_busy" | "reconcile_required" | "operator_attested" | "lease_conflict" | "service_error";

export type WorkflowQueueState = { parent_card_id: string, target_store_id: string, paused: boolean, running: boolean, stop_after_current: boolean, next_position: number,
/**
 * Frozen Product Instance draft IDs. Stable draft IDs are used instead
 * of renderer row IDs so a restart can rebuild the same queue cohort.
 */
frozen_row_ids: Array<string>, updated_at_ms: number,
/**
 * Opaque lane claim for the current queue generation. It is not a
 * credential; it only fences stale callbacks and concurrent state writes.
 */
claim_token: string, revision: number,
/**
 * Lane generation owner. Copied from `store_dispatch_lease` liveness —
 * not a third lease. Empty / `owner_pid = 0` is a pre-lane row.
 */
owner_runtime_id: string, owner_pid: number,
/**
 * Why the queue halted. Present only while the queue is active
 * (`running || paused || stop_after_current`); cleared structurally by
 * `persist_queue_state` the moment the queue unlocks or a fresh lane
 * generation starts.
 */
halt_reason?: QueueHaltReason, };

export type WorkflowQueueStateRequest = { parent_card_id: string, paused: boolean, stop_after_current: boolean, next_position: number, frozen_row_ids: Array<string>, };

export type WorkflowPublishStartRequest = { parent_card_id: string, draft_ids: Array<string>, };

export type RowRevision = { row_id: string, revision: number, store_id?: string, };

/**
 * `automation_operation_id` rides `X-Automation-Operation` on the prepare
 * request — Cloud re-checks the command's row coverage at that paid boundary.
 * Absent is an ordinary manual run, never a fallback.
 */
export type WorkflowRowsActionRequest = { row_ids: Array<string>, expected_revisions: Array<RowRevision>, automation_operation_id?: string, };

export type WorkflowOperationOutcome = "noop" | "wait" | "start" | "blocked" | "needs_review" | "unknown";

/** Browser execution feedback; never changes the Cloud lifecycle or readiness. */
export type WorkflowPreparationProgress = {
  stage: "plan" | "ai" | "render" | "upload"
  state: "waiting" | "running" | "failed"
  message: string
  since_ms: number
}

export type WorkflowOperationRowResult = { row_id: string, outcome: WorkflowOperationOutcome, job_id?: string, noop_reason?: string,
submissionReceipt?: SubmissionReceipt,
taskId?: string,
/** Current browser stage details. Empty clears feedback after completion. */
preparation_progress?: WorkflowPreparationProgress[],
/**
 * One JSON-encoded blocker per condition (serde tag of
 * op_workflow::operations::OperationBlocker), e.g. "missing_template"
 * or {"target_store_mismatch": {...}}.
 */
blockers: Array<string>,
/**
 * The executor's projection of the row after a leg landed — lifecycle,
 * readiness and the Draft, so the names, 简介 and tags reach the table the
 * moment Cloud holds them rather than on the next card open.
 */
product?: WorkflowProductStatusView,
/**
 * This row's job is still running: the projection describes a leg that
 * settled (一键准备's recognition leg, or its start), not the row's verdict.
 * A listener paints it and does not settle the row on it.
 */
interim?: boolean,
/**
 * This row's job failure. `outcome` stays `Start`: the job did run, and
 * only this row failed — its siblings keep their own results.
 */
error?: CommandError, };

export type PublishLaneClaim = { claim_token: string, revision: number, };

export type PublishLaneOutcome = "sent" | "failed" | "skipped" | "pause" | "global_pause";

export type PublishRowStatus = "pending" | "sent" | "failed" | "exception";

export type WorkflowPublishProgress = { parent_card_id: string, draft_id: string, outcome: PublishLaneOutcome, next_position: number, queue: WorkflowQueueState, row_status: PublishRowStatus, row_log: string, replayed: boolean, };

export type DraftRef = { draft_id: string, draft_revision: number, schema_revision: string, };

export type WorkflowDraftView = { supplier_product_id?: string, draft_id: string, kind: WorkflowDraftKind, display_name: string, schema: CategorySchemaView, draft: WorkflowCategoryDraft, validation_state: WorkflowDraftValidationState, issues: Array<WorkflowValidationIssue>, ai_prompt_id: string, ai_prompt: string, ai_prompt_file_name: string, size?: string, psd_template_asset_id: string, psd_template_file_name: string, target_store_id: string, ai_field_policy: WorkflowAiFieldPolicy,
/**
 * Stable parent card identity for Product Instances. Templates and
 * standalone legacy instances have no parent.
 */
parent_card_id?: string, lifecycle: WorkflowProductLifecycle, updated_at_ms: number,
/** Build sources flattened to plain field keys; refreshed with the lifecycle. */
source_layers?: Record<string, FieldLayerView>,
/**
 * Field keys the operator typed on this Product Instance (`payload.handEditedKeys`
 * on the wire). Instance copies of card defaults are not typed values: a key
 * absent here inherits the card default at send, so the workbench shows that
 * default as the fallback instead of the seeded copy.
 */
hand_edited_keys?: string[], };

export type ListingCardSummary = { supplier_product_id?: string, supplier_unavailable?: boolean, draft_id: string, display_name: string, description_category_id: number, type_id: number, language: string, size?: string,
/**
 * Card default `price` as the operator typed it. Absent when the
 * default field is unset. Writes go straight onto `payload.defaults`.
 */
price?: string,
/** Card default `old_price` — same shape and write path as `price`. */
old_price?: string, ai_prompt_file_name: string, psd_template_file_name: string, target_store_id: string, video_count: number,
/**
 * Card default draft (`payload.defaults`). The card list's 主题 / JSON富内容
 * cells read their value from it and write one key back.
 */
defaults?: WorkflowCategoryDraft,
/**
 * Gallery Item id bound as this card's 主图. Reuses the card
 * lifecycle's `source_asset_handle` (templates never take
 * `SourceRegistered`). Absent when unbound.
 */
gallery_item_id?: string, updated_at_ms: number, };

export type FieldPackView = { id: string, name: string, description_category_id: number, type_id: number, language: string, library_id?: string, author_is_self: boolean, shared: boolean, active: boolean, source: string, updated_at_ms: number, };

export type FieldLibrarySummaryView = components["schemas"]["FieldLibrarySummary"];

export type FieldPackListRequest = { description_category_id: number, type_id: number, language?: WorkflowLanguage, };

export type FieldPackSaveRequest = { name: string, schema: CategorySchemaView, draft: WorkflowCategoryDraft, language?: WorkflowLanguage, };

export type FieldPackIdRequest = { pack_id: string, };

export type FieldPackShareRequest = { pack_id: string, shared: boolean, };

export type WorkflowAiRequest = { draft_id?: string, asset_handle: string, prompt: string, queue_claim_token?: string, };

export type WorkflowAnalyzeAssetsRequest = { items: Array<WorkflowAiRequest>, };

export type WorkflowAnalyzeAssetItemResult = { draft_id: string, product?: WorkflowDraftView, error?: CommandError,
/**
 * What Cloud charged for this row, in microfen.
 *
 * Zero whenever no answer reached us, which is not the same as "free": a
 * recognition that Cloud settled and this client then failed to persist was
 * bought and is reported here as nothing. The batch total is therefore a
 * floor on the spend, and the account-level usage panel remains the
 * authority on what the workspace was actually billed.
 */
cost_microfen: number, };

export type WorkflowClearGeneratedContentRequest = { draft_ids: Array<string>, };

export type WorkflowClearGeneratedContentItemResult = { draft_id: string, row?: ListingRowView, status?: WorkflowProductStatusView, error?: CommandError, };

export type WorkflowAiCandidateState = "proposed" | "confirmed" | "rejected" | "unresolved";

export type WorkflowAiCandidate = { address: FieldAddress, value: WorkflowDraftValue,
/**
 * Snapshot of the reviewed value at candidate arrival; this is display
 * evidence only and is never trusted for persistence.
 */
current_value?: WorkflowDraftValue, source: string, state: WorkflowAiCandidateState, issue?: string, };

export type WorkflowAiResult = { ru: string, tags: Array<string>, description: string, model: string,
/**
 * What Cloud charged for this recognition, in microfen.
 *
 * Every request is bought, and the account-level usage panel can only
 * answer "what did this workspace spend this week" — not "what did the batch I
 * just ran cost", which is the question an operator asks before running
 * another one. Carried per result so the batch can be totalled.
 */
cost_microfen: number, candidates: Array<WorkflowAiCandidate>, };

export type WorkflowPromptFile = { file_name: string, content: string, };

export type WorkflowPromptDirEntry = { l1_name: string, l2_name: string, type_name: string, name: string, file_name: string, content: string, };

export type WorkflowPromptDirScan = { root: string, entries: Array<WorkflowPromptDirEntry>, skipped: Array<string>, };

export type WorkflowCategoryPrompt = { prompt_id: string, name: string, file_name: string, content: string, fixed_tags: Array<string>, description_category_id: number, type_id: number, };

export type WorkflowPromptLeaf = { description_category_id: number, type_id: number, };

export type SaveCategoryPromptRequest = { prompt_id?: string, description_category_id: number, type_id: number, name: string, content: string, file_name: string, fixed_tags?: Array<string>, };

export type WorkflowCategoryVideo = { video_id: string, name: string, video_url: string, duration_ms: number, description_category_id: number, type_id: number, };

export type SaveCategoryVideoRequest = { video_id?: string, description_category_id: number, type_id: number, name: string, video_url: string, duration_ms: number, };

export type VideoPoolUploadRequest = { asset_handle: string, };

export type VideoPoolUpload = { file_name: string, public_url: string, duration_ms: number, };

export type WorkflowTemplatePsdAsset = { asset_id: string, asset: PickedPsdAsset, summary: PsdInspectSummary, };

export type WorkflowPickSourceBatchRequest = {
/**
 * Empty opens the browser multi-select dialog. A non-empty list is
 * staged-file handles already in this tab.
 */
paths: Array<string>,
/**
 * How many images the caller can still accept. Clamped again to
 * `MAX_SOURCE_BATCH`.
 */
selection_limit: number, };

export type WorkflowPickedSource = {
/**
 * Basename only — what the renderer shows on the row it just created.
 */
file_name: string,
/**
 * Staged-file handle for this tab, empty on a rejected slot.
 */
path: string, error?: string, };

export type WorkflowImportSourceBatchItem = { path: string, gallery_item_id?: string, target_store_id: string, };

export type WorkflowImportSourceBatchRequest = { card_draft_id: string, items: Array<WorkflowImportSourceBatchItem>, };

export type WorkflowImportSourceBatchItemResult = { input_index: number, product?: WorkflowDraftView, source?: PickedPsdAsset, status?: WorkflowProductStatusView, error?: CommandError, };

export type WorkflowVideoRole = "product" | "cover";

export type WorkflowVideoMetadata = { role: WorkflowVideoRole, origin: WorkflowVideoOrigin, file_name: string, content_type: string, size_bytes: number, duration_ms: number, public_url?: string, object_key?: string, content_hash?: string, };

export type WorkflowVideoValidation = { valid: boolean, reason: string | null, };

export type WorkflowValidationIssueCode = "required" | "type" | "cardinality" | "unknown_option" | "dictionary_id" | "unknown_field" | "range" | "coordinate" | "complex_placement";

export type WorkflowValidationIssue = { field_key: string, code: WorkflowValidationIssueCode, message: string, value_index?: number, complex_id?: number, item_index?: number, };
