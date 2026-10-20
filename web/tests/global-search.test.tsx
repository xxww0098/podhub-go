/**
 * AppShell ↔ 全局搜索接线 — 壳层挂上命令面板（combobox 语义、全站 placeholder），
 * 并用可播种的模块级 store（roster 缓存、上架工作台）验证订阅缝不炸。纯函数
 * （命中/排序/上限/降级/导航目标）在 src/app/global-search.test.tsx；真键入
 * 交互按仓库惯例走浏览器检查页。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { AccountOverview, OzonStoresOverview } from "../src/bindings/commands"
import { AppShell } from "../src/app/app-shell"
import { GlobalSearch } from "../src/app/global-search"
import type { NotificationsController } from "../src/features/notifications/notifications"
import { rememberStoreRoster } from "../src/features/stores/store-roster-cache"
import { patchListingWorkbench } from "../src/features/workflow/workbench/listing-workbench-store"

const ownerWorkspace = {
  id: 1,
  uuid: "3f2b6c1a-9d84-4a1e-8f52-71c0a9e4d6b3",
  name: "示例工作空间",
  plan: "pro",
  role: "owner",
  is_owned: true,
}

const overview: AccountOverview = {
  session: {
    authenticated: true,
    email: "seller@example.invalid",
    name: "Seller",
    role: "user",
    supplier_id: undefined,
  },
  entitlement: {
    plan: "pro",
    features: { ai_relay: true, ocr: true, batch_listing: true, field_package: false },
    limits: {
      stores: 3,
      stores_used: 1,
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

const noNotifications: NotificationsController = {
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

const roster: OzonStoresOverview = {
  active_id: "uuid-store-1",
  stores: [
    {
      active: false,
      advertising_client_id: "",
      advertising_configured: false,
      assignee_key_manage: false,
      can_edit_credential: true,
      can_manage: true,
      client_id: "4877007",
      configured: true,
      id: "uuid-store-1",
      label: "Ozon 4877007",
      needs_reentry: false,
      permissions: {
        delete_store: true,
        edit_name: true,
        manage_key: true,
        manage_key_grants: false,
        manage_store: true,
        manage_tags: true,
        test_key: true,
      },
      ref_id: "123456",
      secret_status: "present",
      updated_at_ms: 0,
      watermark_name: "",
    },
  ],
}

const noop = () => {}

test("AppShell 挂上命令面板：combobox + 全站 placeholder，旧「搜索」占位不再出现", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="console"
      onScreenChange={noop}
      overview={overview}
      notifications={noNotifications}
      onSignedOut={noop}
    >
      <p>pane</p>
    </AppShell>,
  )
  assert.match(html, /placeholder="搜索页面与业务数据"/)
  assert.match(html, /aria-label="搜索页面与业务数据"/)
  assert.match(html, /role="combobox"/)
  // 旧占位只是一个字「搜索」，全站语义升级后不应再出现。
  assert.doesNotMatch(html, /placeholder="搜索"/)
})

test("AppShell 的 /admin 面也挂同一命令面板入口", () => {
  const html = renderToStaticMarkup(
    <AppShell
      screen="supplier-dbs"
      onScreenChange={noop}
      adminSurface
      overview={overview}
      notifications={noNotifications}
      onSignedOut={noop}
    >
      <p>pane</p>
    </AppShell>,
  )
  assert.match(html, /placeholder="搜索页面与业务数据"/)
})

test("GlobalSearch 订阅模块级 store：播种 roster 与打开中的方案后渲染不炸且保持闭合", () => {
  rememberStoreRoster(roster, 1)
  patchListingWorkbench({ cardId: "card_7", cardName: "圣诞马克杯方案" })
  try {
    const html = renderToStaticMarkup(
      <GlobalSearch
        audience={{ isAgent: false, isStaff: true }}
        workspaceId={1}
        onScreenChange={noop}
        onOpenSettings={noop}
      />,
    )
    assert.match(html, /role="combobox"/)
    // 未聚焦：不弹 listbox，也不把业务数据提前渲染进闭合态。
    assert.doesNotMatch(html, /role="listbox"/)
    assert.doesNotMatch(html, /4877007/)
    assert.doesNotMatch(html, /圣诞马克杯方案/)
  } finally {
    patchListingWorkbench({ cardId: undefined, cardName: "" })
  }
})
