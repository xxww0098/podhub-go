import { appendNotificationPage, readNotificationPages } from "./notifications-read"
import { invitationState, relativeTimeLabel } from "./notification-view"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  InvitationStatusView,
  NotificationInvitationView,
  NotificationView,
  NotificationsView,
} from "@/bindings/commands"
import { NotificationBell } from "./notification-bell"
import { toast } from "@/components/ui/toast"
import { setErrorTelemetryContext } from "@/lib/error-telemetry"

// Toasted refusals queue fire-and-forget error-feedback receipts; drop the
// session at file end so no late flush escapes into a later file.
test.after(() => {
  setErrorTelemetryContext({ sessionKey: null })
})

import {
  POLL_INTERVAL_MS,
  arrivedInvitationHeadline,
  isLatestNotificationRead,
  runNotificationWrite,
  sameNotificationsView,
  settleAcceptInvitation,
  settleNotificationAction,
  shouldAnnounceReadFailure,
  type NotificationsController,
} from "./notifications"
import { NotificationsScreen } from "./notifications-screen"
import { NotificationsInbox } from "./notifications-dialog"

const NOW = Date.now()

const invitation: NotificationInvitationView = {
  uuid: "9b1c4f30-1e5a-4a4f-8a2b-8c1f4f0d1a11",
  workspace_id: 7,
  workspace_name: "演示 Workspace",
  role: "manager",
  inviter_email: "owner@example.invalid",
  status: "pending",
  expires_at_ms: NOW + 86_400_000,
}

const invitationNotification: NotificationView = {
  uuid: "3a2d0f11-77b1-4b64-9f0c-2a2f7d5b6c01",
  kind: "workspace_invitation",
  created_at_ms: NOW - 600_000,
  invitation,
}

function controller(
  overrides: Partial<NotificationsController> = {},
): NotificationsController {
  const notifications = overrides.notifications ?? []
  return {
    notifications,
    unread: 0,
    total: notifications.length,
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

function captureToasts() {
  const added: Array<{ title?: unknown; id?: unknown; timeout?: unknown }> = []
  const stop = toast[" subscribe"]((event) => {
    if (event.action === "add") added.push(event.options)
  })
  return { added, stop }
}

function renderedButton(html: string, label: string): string {
  const labelIndex = html.indexOf(`>${label}</button>`)
  assert.notEqual(labelIndex, -1)
  const start = html.lastIndexOf("<button", labelIndex)
  return html.slice(start, html.indexOf("</button>", labelIndex) + 9)
}

test("the bell names the unread count for both eyes and assistive tech", () => {
  const html = renderToStaticMarkup(
    <NotificationBell notifications={controller({ unread: 3 })} />,
  )

  assert.match(html, /通知（3 条未读）/)
  assert.match(html, />3</)
  assert.doesNotMatch(
    renderToStaticMarkup(<NotificationBell notifications={controller()} />),
    /条未读/,
  )
})

test("the bell reports the inbox total instead of the loaded page size", () => {
  const html = renderToStaticMarkup(
    <NotificationBell
      notifications={controller({
        notifications: Array.from({ length: 50 }, (_, index) => ({
          ...invitationNotification,
          uuid: `notification-${index}`,
          read_at_ms: NOW,
        })),
        total: 101,
        hasMore: true,
      })}
    />,
  )

  assert.match(html, /aria-label="通知（共 101 条）"/)
  assert.doesNotMatch(html, /通知（共 50 条）/)
})

test("the icon-only bell says its name on hover and yields while the popover is open", () => {
  const source = readFileSync(
    new URL("./notification-bell.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<Tooltip>[\s\S]*<TooltipTrigger[\s\S]*DropdownMenuTrigger/)
  assert.match(source, /<TooltipContent side="bottom"[\s\S]*hidden=\{open\}/)

  // The name is one string for both readers; the copy stays in the popup, so
  // it never doubles up in the button's markup.
  const html = renderToStaticMarkup(
    <NotificationBell notifications={controller({ unread: 3 })} />,
  )
  assert.match(html, /aria-label="通知（3 条未读）"/)
  assert.doesNotMatch(html, /data-slot="tooltip-content"/)
})

test("a pending invitation offers both actions with the seat it is offering", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [invitationNotification],
        unread: 1,
      })}
    />,
  )

  assert.match(html, />接受</)
  assert.match(html, />拒绝</)
  assert.match(html, /演示 Workspace/)
  assert.match(html, /owner@example.invalid/)
  assert.match(html, /主管/)
  assert.match(html, /待处理/)
  assert.match(html, /有效期至/)
  assert.match(html, /1 条未读/)
})

test("a bounded inbox exposes load-more and passive reads preserve its depth", async () => {
  const first: NotificationsView = {
    notifications: [invitationNotification],
    unread: 2,
    total: 2,
    next_cursor: "123:1",
  }
  const older = { ...invitationNotification, uuid: "older-notification" }
  const merged = appendNotificationPage(first, {
    notifications: [invitationNotification, older],
    unread: 1,
    total: 2,
  })
  assert.deepEqual(
    merged.notifications.map((item) => item.uuid),
    [invitationNotification.uuid, older.uuid],
  )
  assert.equal(merged.unread, 1)
  assert.equal(merged.next_cursor, undefined)

  const calls: Array<string | undefined> = []
  const refreshed = await readNotificationPages(async (cursor) => {
    calls.push(cursor)
    return cursor
      ? {
          notifications: [
            {
              ...older,
              invitation: { ...invitation, status: "declined" },
            },
          ],
          unread: 1,
          total: 2,
        }
      : first
  }, 2)
  assert.deepEqual(calls, [undefined, first.next_cursor])
  assert.equal(refreshed.view.notifications.length, 2)
  assert.equal(refreshed.view.notifications[1]?.invitation?.status, "declined")

  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: first.notifications,
        unread: first.unread,
        total: first.total,
        hasMore: true,
      })}
    />,
  )
  assert.match(html, /已加载 1 \/ 共 2 条/)
  assert.match(html, />加载更多</)
})

test("decline owns the busy indicator while it settles", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [invitationNotification],
        unread: 1,
        pending: `decline:${invitation.uuid}`,
        writing: true,
      })}
    />,
  )

  assert.doesNotMatch(renderedButton(html, "接受"), /data-slot="spinner"/)
  assert.match(renderedButton(html, "拒绝"), /data-slot="spinner"/)
})

test("a settled invitation states what happened and offers nothing", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [
          {
            ...invitationNotification,
            read_at_ms: NOW - 60_000,
            invitation: { ...invitation, status: "revoked" },
          },
        ],
      })}
    />,
  )

  assert.match(html, /已撤销/)
  assert.match(html, /邀请方已撤销这个邀请/)
  assert.doesNotMatch(html, />接受</)
  assert.doesNotMatch(html, />拒绝</)
})

test("only a pending, unexpired invitation is presented as actionable", () => {
  for (const status of [
    "accepted",
    "declined",
    "revoked",
    "expired",
  ] satisfies InvitationStatusView[]) {
    assert.notEqual(invitationState({ ...invitation, status }, NOW), "pending")
  }
  assert.equal(invitationState(invitation, NOW), "pending")
  // Cloud has not polled the clock yet; the client refuses to offer the seat.
  assert.equal(
    invitationState({ ...invitation, expires_at_ms: NOW - 1 }, NOW),
    "expired",
  )
})

test("an unknown kind renders as a generic row instead of vanishing", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [
          {
            uuid: "0f9c1a22-4d6e-4b21-9c33-5c6a7b8d9e10",
            // A kind this build's generated union does not know yet: the
            // screen must still render the row, so the cast is the test.
            kind: "plan_expiring" as NotificationView["kind"],
            created_at_ms: NOW - 3_600_000,
          },
          invitationNotification,
        ],
        unread: 2,
      })}
    />,
  )

  assert.match(html, /新通知/)
  assert.match(html, /plan_expiring/)
  assert.match(html, /当前版本还不能展开这条通知/)
  assert.match(html, /共 2 条/)
  assert.match(html, /演示 Workspace/)
})

/**
 * The shape asserted here is the one the host actually rejects with: Cloud
 * answers 403 + `WORKSPACE_LIMIT_REACHED`, the client rewrites the code into
 * its own namespace, and `remediation` stays null because Cloud wrote the next
 * step into the sentence.
 */
const CAP_REJECT = {
  code: "cloud_workspace_limit_reached",
  message: "自建工作空间已达上限（3/3）；解散一个不再使用的自建空间可腾出名额，或换一个邮箱注册",
  remediation: null,
}

test("a cap refusal surfaces Cloud's own copy and still re-reads the list", async () => {
  const { added, stop } = captureToasts()
  let reloads = 0

  try {
    const settled = await settleNotificationAction(
      () => Promise.reject(CAP_REJECT),
      async () => {
        reloads += 1
      },
      "无法创建工作空间，请稍后重试。",
    )

    assert.equal(settled, false)
    // A refusal is news about what this row now points at, so the re-read runs.
    assert.equal(reloads, 1)
    assert.equal(added.length, 1)
    assert.equal(added[0].title, CAP_REJECT.message)
    // The cap is the one refusal a retry can never clear: the toast is keyed
    // and held rather than flashed, so the next step survives long enough to
    // act on.
    assert.equal(added[0].id, "cloud_workspace_limit_reached")
    assert.equal(added[0].timeout, 20_000)
  } finally {
    stop()
    toast.close()
  }
})

test("a plain validation refusal stays an ordinary flash", async () => {
  const { added, stop } = captureToasts()

  try {
    await settleNotificationAction(
      () =>
        Promise.reject({
          code: "cloud_validation_failed",
          message: "邀请已被撤销",
          remediation: null,
        }),
      async () => {},
      "无法接受邀请，请稍后重试。",
    )

    assert.equal(added.length, 1)
    assert.equal(added[0].title, "邀请已被撤销")
    // Not keyed by its code, so two different 400s stack rather than replace,
    // and it clears on the ordinary error beat.
    assert.notEqual(added[0].id, "cloud_validation_failed")
    assert.equal(added[0].timeout, 6_000)
  } finally {
    stop()
    toast.close()
  }
})

test("accepting reaches the shell, or the operator stays on the no-Workspace gate", async () => {
  const { added, stop } = captureToasts()
  const order: string[] = []

  try {
    const joined = await settleAcceptInvitation(
      async () => order.push("write"),
      async () => {
        order.push("reload")
      },
      async () => {
        order.push("accepted")
      },
    )

    assert.equal(joined, true)
    // The session re-read hangs off this call; without it the shell keeps
    // rendering the gate for an account that now holds a seat.
    assert.deepEqual(order, ["write", "reload", "accepted"])
    assert.equal(added.length, 1)
    assert.equal(added[0].title, "已加入工作空间")
  } finally {
    stop()
    toast.close()
  }
})

test("an accepted membership never gets resubmitted when overview sync fails", async () => {
  const { stop } = captureToasts()
  const order: string[] = []

  try {
    await assert.rejects(
      settleAcceptInvitation(
        async () => {
          order.push("write")
        },
        async () => {
          order.push("reload")
        },
        async () => {
          order.push("sync")
          throw new Error("overview unavailable")
        },
      ),
      /overview unavailable/,
    )
    assert.deepEqual(order, ["write", "reload", "sync"])
  } finally {
    stop()
    toast.close()
  }
})

test("the shared visible poll keeps the notification cadence bounded", () => {
  assert.equal(POLL_INTERVAL_MS, 5_000)
})

test("a later poll names only an invitation that was not on the previous list", () => {
  const view: NotificationsView = {
    unread: 1,
    total: 1,
    notifications: [invitationNotification],
  }
  assert.equal(arrivedInvitationHeadline(undefined, view), undefined)
  assert.equal(arrivedInvitationHeadline(view, view), undefined)
  const newer: NotificationView = {
    ...invitationNotification,
    uuid: "7c1e0a22-88c2-4c75-8d1d-3b3e8e6c7d02",
    invitation: { ...invitation, workspace_name: "华南工厂" },
  }
  assert.equal(
    arrivedInvitationHeadline(view, { unread: 2, total: 2, notifications: [newer, invitationNotification] }),
    "华南工厂 的加入邀请",
  )
})

test("an unchanged notification snapshot keeps view identity", () => {
  const view: NotificationsView = {
    unread: 1,
    total: 1,
    notifications: [invitationNotification],
  }
  assert.equal(sameNotificationsView(view, { ...view, notifications: [...view.notifications] }), true)
  assert.equal(sameNotificationsView(view, { ...view, unread: 0 }), false)
  assert.equal(
    sameNotificationsView(view, {
      ...view,
      notifications: [{ ...invitationNotification, read_at_ms: NOW }],
    }),
    false,
  )
  assert.equal(
    sameNotificationsView(view, {
      ...view,
      notifications: [
        {
          ...invitationNotification,
          invitation: { ...invitation, status: "revoked" },
        },
      ],
    }),
    false,
  )
  assert.equal(sameNotificationsView(undefined, view), false)
})

test("an unreachable Cloud is reported once per outage, not once per beat", () => {
  assert.equal(shouldAnnounceReadFailure("beat", false), true)
  // Twenty minutes of a dead Cloud is twenty toasts without this.
  assert.equal(shouldAnnounceReadFailure("beat", true), false)
  assert.equal(shouldAnnounceReadFailure("focus", true), false)
  // Whoever pressed 刷新 is owed an answer even mid-outage.
  assert.equal(shouldAnnounceReadFailure("refresh", true), true)
})

test("relative timestamps stay coarse and fall back to a date", () => {
  assert.equal(relativeTimeLabel(NOW - 30_000, NOW), "刚刚")
  assert.equal(relativeTimeLabel(NOW - 600_000, NOW), "10 分钟前")
  assert.equal(relativeTimeLabel(NOW - 7_200_000, NOW), "2 小时前")
  assert.equal(relativeTimeLabel(NOW - 172_800_000, NOW), "2 天前")
  assert.match(relativeTimeLabel(NOW - 2_592_000_000, NOW), /2026/)
})

test("an older notification read cannot overwrite a newer snapshot", async () => {
  let latest = 0
  const applied: string[] = []
  let resolveOld!: (value: string) => void
  let resolveNew!: (value: string) => void
  const old = new Promise<string>((resolve) => {
    resolveOld = resolve
  })
  const next = new Promise<string>((resolve) => {
    resolveNew = resolve
  })
  const read = async (request: Promise<string>) => {
    const version = ++latest
    const value = await request
    if (isLatestNotificationRead(version, latest)) applied.push(value)
  }

  const oldRead = read(old)
  const newRead = read(next)
  resolveNew("new")
  await newRead
  resolveOld("old")
  await oldRead
  assert.deepEqual(applied, ["new"])
})

test("notification writes are synchronous single-flight", async () => {
  const gate = { current: false }
  let calls = 0
  let active = 0
  let peak = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runNotificationWrite(gate, async () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    await blocked
    active -= 1
    return true
  })
  const second = await runNotificationWrite(gate, async () => {
    calls += 1
    return true
  })

  assert.equal(second, undefined)
  assert.equal(gate.current, true)
  assert.equal(calls, 1)
  assert.equal(peak, 1)
  release()
  assert.equal(await first, true)
  assert.equal(gate.current, false)
})

test("a first-read failure is persistent and does not pretend the inbox is empty", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({ loaded: false, loadFailed: true })}
    />,
  )
  assert.match(html, /读取失败/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /还没有通知|共 0 条|正在读取通知/)

  const source = readFileSync(
    new URL("./notifications.ts", import.meta.url),
    "utf8",
  )
  assert.match(source, /notifyLive\(\{/)
  assert.match(source, /`\$\{scope\}-read`/)
  assert.match(source, /action: \{ label: "重试"/)
})

const olderNotification: NotificationView = {
  uuid: "0f9c1a22-4d6e-4b21-9c33-5c6a7b8d9e10",
  // A kind this build's generated union does not know yet: the
  // inbox must still render the row, so the cast is the test.
  kind: "plan_expiring" as NotificationView["kind"],
  created_at_ms: NOW - 3_600_000,
}

test("the floating inbox reads like mail: a list rail and a reading pane", () => {
  const html = renderToStaticMarkup(
    <NotificationsInbox
      controller={controller({
        notifications: [invitationNotification, olderNotification],
        unread: 2,
        total: 2,
      })}
    />,
  )

  // The rail lists every title with its received time…
  assert.match(html, /aria-label="通知列表"/)
  assert.match(html, /演示 Workspace 的加入邀请/)
  assert.match(html, /新通知/)
  assert.match(html, /10 分钟前/)
  assert.match(html, /1 小时前/)
  // …and the reading pane opens on the newest with its detail and actions.
  assert.match(html, /<article/)
  assert.match(html, /owner@example\.invalid/)
  assert.match(html, />接受</)
  assert.match(html, />拒绝</)
})

test("the inbox opens on the notification the bell row named", () => {
  const html = renderToStaticMarkup(
    <NotificationsInbox
      controller={controller({
        notifications: [invitationNotification, olderNotification],
      })}
      focusUuid={olderNotification.uuid}
    />,
  )

  const current = html.indexOf('aria-current="true"')
  assert.notEqual(current, -1)
  const focusedRow = html.slice(current, html.indexOf("</button>", current))
  assert.match(focusedRow, /新通知/)
  // The reading pane follows the selection, not the newest row.
  assert.match(html, /当前版本还不能展开这条通知/)
  assert.doesNotMatch(html, /邀请你以/)
})

test("a bounded floating inbox paginates from the rail", () => {
  const html = renderToStaticMarkup(
    <NotificationsInbox
      controller={controller({
        notifications: [invitationNotification],
        total: 2,
        hasMore: true,
      })}
    />,
  )
  assert.match(html, />加载更多</)
})

test("the centre is a floating window the shell opens, not a navigation", () => {
  const dialog = readFileSync(
    new URL("./notifications-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(dialog, /<Dialog open=\{open\}/)
  assert.match(dialog, /DialogContent/)
  assert.match(dialog, /DialogTitle/)

  const shell = readFileSync(
    new URL("../../app/app-shell.tsx", import.meta.url),
    "utf8",
  )
  assert.match(shell, /NotificationsDialog/)
  assert.match(shell, /onOpenNotifications=\{openNotifications\}/)
  // Neither the bell nor the settings pane navigates to the screen any more.
  assert.doesNotMatch(shell, /onScreenChange\("notifications"\)/)
})

test("a joined-but-unsynced account cannot respond without proof; other writes remain open", () => {
  const html = renderToStaticMarkup(
    <NotificationsScreen
      notifications={controller({
        notifications: [
          invitationNotification,
          {
            ...invitationNotification,
            uuid: "ad4dd255-d499-4f24-a870-174a456b18ea",
            invitation: { ...invitation, status: "accepted" },
          },
        ],
        unread: 2,
        overviewSyncFailed: true,
      })}
    />,
  )
  assert.match(renderedButton(html, "接受"), / disabled=""/)
  assert.match(renderedButton(html, "拒绝"), / disabled=""/)
  for (const label of ["标为已读", "全部已读"]) {
    assert.doesNotMatch(renderedButton(html, label), / disabled=""/)
  }
  // The sync failure copy now rides the toast host; the page keeps only the
  // disabled action that would repeat the accept.
  const source = readFileSync(
    new URL("./notifications.ts", import.meta.url),
    "utf8",
  )
  assert.match(source, /已加入工作空间，但工作台尚未同步/)
  assert.match(source, /不要再次接受邀请/)
  assert.doesNotMatch(source, /role="alert"/)
})
