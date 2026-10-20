import type { AccountOverview } from "../src/bindings/commands"
import type { NotificationsController } from "../src/features/notifications/notifications"

export const ownerWorkspace = {
  id: 1,
  uuid: "3f2b6c1a-9d84-4a1e-8f52-71c0a9e4d6b3",
  name: "示例工作空间",
  plan: "pro",
  role: "owner",
  is_owned: true,
}
export const overview: AccountOverview = {
  session: {
    authenticated: true,
    email: "seller@example.invalid",
    name: "Seller",
    role: "user",
    supplier_id: undefined,
  },
  entitlement: {
    plan: "pro",
    features: {
      ai_relay: true,
      ocr: true,
      batch_listing: true,
      field_package: false,
    },
    limits: {
      stores: 3,
      stores_used: 0,
      seats: 8,
      seats_used: 1,
      s3_upload_bytes_monthly: 21474836480,
      s3_upload_bytes_used: 0,
      ai_tokens_monthly: 1000000,
      ai_tokens_used: 0,
      ai_calls_per_day: 100,
    },
  },
  active_workspace: ownerWorkspace,
  workspaces: [ownerWorkspace],
  account_mode: "owner",
  owned_count: 1,
  owned_limit: 3,
}

/** A quiet inbox: these cases assert navigation chrome, not notifications. */
export const noNotifications: NotificationsController = {
  notifications: [],
  unread: 0,
  total: 0,
  hasMore: false,
  loaded: true,
  loadFailed: false,
  refreshing: false,
  loadingMore: false,
  markingAllRead: false,
  writing: false,
  overviewSyncFailed: false,
  refresh: async () => {},
  loadMore: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
  acceptInvitation: async () => false,
  declineInvitation: async () => false,
}
