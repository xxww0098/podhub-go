import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { AccountOverview, NotificationView } from "@/bindings/commands"
import { NotificationsScreen } from "@/features/notifications/notifications-screen"
import type { NotificationsController } from "@/features/notifications/notifications"
import { NoWorkspaceGate } from "./no-workspace-gate"

const pendingInvitation: NotificationView = {
  uuid: "3a7b1c9d-2e4f-4a6b-8c1d-9e5f7a2b4c6d",
  kind: "workspace_invitation",
  created_at_ms: 1_755_000_000_000,
  invitation: {
    uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
    workspace_id: 42,
    workspace_name: "协作 Workspace",
    role: "member",
    inviter_email: "owner@example.invalid",
    status: "pending",
    expires_at_ms: 4_100_000_000_000,
  },
}

function controller(
  overrides: Partial<NotificationsController> = {},
): NotificationsController {
  return {
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
    ...overrides,
  }
}

const overview = {
  session: {
    authenticated: true,
    email: "invitee@example.invalid",
  },
  accounts: [
    {
      uuid: "5f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a22",
      email: "invitee@example.invalid",
      name: "受邀者",
      active: true,
    },
  ],
} as unknown as AccountOverview

function render(
  notifications: NotificationsController,
  props: Partial<Parameters<typeof NoWorkspaceGate>[0]> = {},
) {
  return renderToStaticMarkup(
    <NoWorkspaceGate
      overview={overview}
      notifications={notifications}
      onCreated={() => {}}
      onSignedOut={() => {}}
      {...props}
    />,
  )
}

test("a workspaceless account can reach a pending invitation from the gate", () => {
  // The gate replaces the Workspace-scoped shell, so if it did not carry the
  // Notification list an invited person would have no way to accept and no way
  // out except creating a Workspace they did not want. The pane mounts lazily
  // (it is a lazy screen), so the static render only shows its slot — the
  // pane's own render below proves the invitation it carries is reachable.
  const html = render(
    controller({ notifications: [pendingInvitation], unread: 1 }),
  )
  assert.match(html, /正在加载通知/)
  const pane = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [pendingInvitation],
        unread: 1,
      })}
    />,
  )
  assert.match(pane, /协作 Workspace/)
  assert.match(pane, /owner@example\.invalid/)
  assert.match(pane, /接受/)
})

test("the gate offers both creating a Workspace and waiting for an invitation", () => {
  const html = render(controller())
  assert.match(html, /创建工作空间/)
  assert.match(html, /等待邀请/)
  // The registered address is what an inviter must type, so it stays visible
  // even when the inbox is empty.
  assert.match(html, /invitee@example\.invalid/)
})

test("the gate always offers sign-out", () => {
  // Without a Workspace there is no account menu and no sidebar; losing sign-out
  // here would strand the account with no way to switch identities.
  assert.match(render(controller()), /退出登录/)
})
