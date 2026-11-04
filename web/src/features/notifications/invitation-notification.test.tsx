import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { NotificationView } from "@/bindings/commands"
import { NotificationActions, NotificationBody } from "./notification-detail"
import type { NotificationsController } from "./notifications"

const notification: NotificationView = {
  uuid: "9b1c4f30-1e5a-4a4f-8a2b-8c1f4f0d1a11", kind: "workspace_invitation", created_at_ms: Date.now(),
  invitation: { uuid: "550e8400-e29b-41d4-a716-446655440000", workspace_id: 7, workspace_name: "目标工作空间", role: "manager",
    inviter_email: "owner@example.invalid", status: "pending", expires_at_ms: Date.now() + 60_000 },
}

test("a pending notification shows the invitation and direct actions", () => {
  let writes = 0
  const controller = {
    writing: false, overviewSyncFailed: false,
    acceptInvitation: async () => { writes++; return true },
    declineInvitation: async () => { writes++; return true },
  } as unknown as NotificationsController
  const html = renderToStaticMarkup(<><NotificationBody notification={notification} />
    <NotificationActions notification={notification} controller={controller} /></>)
  assert.match(html, /目标工作空间/)
  assert.match(html, /主管/)
  assert.match(html, /接受/)
  assert.match(html, /拒绝/)
  assert.doesNotMatch(html, /凭据|链接|<input| disabled=""/)
  assert.equal(writes, 0)
})

test("a write in progress disables both invitation actions", () => {
  const controller = { writing: true } as NotificationsController
  const html = renderToStaticMarkup(<NotificationActions notification={notification} controller={controller} />)
  assert.equal((html.match(/ disabled=""/g) ?? []).length, 2)
})
