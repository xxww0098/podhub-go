import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import type { NotificationView, NotificationsView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  clearLive,
  notifyLive,
  notifyCommandError,
  notifyInfo,
  notifySuccess,
} from "@/lib/notify"
import { isUnread, notificationHeadline } from "./notification-view"
import { WorkspaceInvitationPrompt } from "./workspace-invitation-prompt"
import { useInvitationCredential } from "@/lib/invitation-link"
import { appendNotificationPage, readNotificationPages } from "./notifications-read"
import { useVisiblePolling } from "@/lib/visible-polling"

/** Cloud has no push channel; the surfaces re-read on focus and on this beat. */
export const POLL_INTERVAL_MS = 5_000

/** A newly arrived invitation, after the first list, so mount does not toast history. */
export function arrivedInvitationHeadline(
  previous: NotificationsView | undefined,
  next: NotificationsView,
): string | undefined {
  if (!previous) return undefined
  const seen = new Set(previous.notifications.map((item) => item.uuid))
  const arrived = next.notifications.find(
    (item) => item.invitation != null && isUnread(item) && !seen.has(item.uuid),
  )
  return arrived ? notificationHeadline(arrived) : undefined
}

/** Unchanged unread / identity / invitation status must not `setView`. */
export function sameNotificationsView(
  current?: NotificationsView,
  next?: NotificationsView,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  if (
    current.unread !== next.unread ||
    current.total !== next.total ||
    current.next_cursor !== next.next_cursor ||
    current.notifications.length !== next.notifications.length
  ) {
    return false
  }
  return current.notifications.every((item, index) => {
    const other = next.notifications[index]
    return (
      other !== undefined &&
      item.uuid === other.uuid &&
      item.read_at_ms === other.read_at_ms &&
      item.invitation?.status === other.invitation?.status &&
      item.invitation?.expires_at_ms === other.invitation?.expires_at_ms
    )
  })
}

/** Only `refresh` is operator-initiated; other reads reconcile the window. */
export type NotificationsReadTrigger =
  | "mount"
  | "beat"
  | "focus"
  | "visible"
  | "settle"
  | "refresh"
  | "more"

/** Report one outage per poll, but always answer an operator's refresh. */
export function shouldAnnounceReadFailure(
  trigger: NotificationsReadTrigger,
  alreadyFailing: boolean,
): boolean {
  return trigger === "refresh" || trigger === "more" || !alreadyFailing
}

export function isLatestNotificationRead(version: number, latest: number): boolean {
  return version === latest
}

export async function runNotificationWrite<T>(
  gate: { current: boolean },
  action: () => Promise<T>,
): Promise<T | undefined> {
  if (gate.current) return undefined
  gate.current = true
  try {
    return await action()
  } finally {
    gate.current = false
  }
}

/** Re-read on success and refusal: Cloud owns the invitation's current status. */
export async function settleNotificationAction(
  write: () => Promise<unknown>,
  reload: () => Promise<void>,
  fallback: string,
): Promise<boolean> {
  let settled = true
  try {
    await write()
  } catch (reason) {
    notifyCommandError(reason, fallback)
    settled = false
  }
  await reload()
  return settled
}

/** Only a committed accept refreshes Membership in the shell. */
export async function settleAcceptInvitation(
  write: () => Promise<unknown>,
  reload: () => Promise<void>,
  onAccepted?: () => Promise<void>,
): Promise<boolean> {
  const joined = await settleNotificationAction(write, reload, "无法接受邀请，请稍后重试。")
  if (joined) {
    notifySuccess("已加入工作空间")
    await onAccepted?.()
  }
  return joined
}

export type NotificationsController = {
  /** Newest first. */
  notifications: NotificationView[]
  unread: number
  total: number
  hasMore: boolean
  /** False until the first list lands; surfaces show skeletons, not "no notifications". */
  loaded: boolean
  loadFailed: boolean
  loadReason?: unknown
  refreshing: boolean
  loadingMore: boolean
  /** The concrete write whose busy indicator is in flight. */
  pending?: string
  markingAllRead: boolean
  writing: boolean
  overviewSyncFailed: boolean
  overviewSyncReason?: unknown
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  markRead: (notificationUuid: string) => Promise<void>
  markAllRead: () => Promise<void>
  /** Takes `invitation.uuid` — the Notification is the envelope, not the target. */
  acceptInvitation: (invitationUuid: string, token: string) => Promise<boolean>
  declineInvitation: (invitationUuid: string, token: string) => Promise<boolean>
}

export type UseNotificationsOptions = {
  /** Off before sign-in: an unauthenticated poll can only produce refusals. */
  enabled?: boolean
  /**
   * Accepting is the only action here that changes Membership, so session and
   * Workspace state go stale the moment it lands. The shell owns that reload.
   */
  onAccepted?: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsController | null>(null)

/**
 * Failure copy lives in the toast host, never in the surface; the live rows
 * carry their own retry and clear the moment the read or sync succeeds. The
 * scope keeps two surfaces mounted at once — the screen and the dialog — from
 * fighting over one live id.
 */
export function useNotificationLiveToasts(
  controller: Pick<
    NotificationsController,
    "loadFailed" | "loadReason" | "overviewSyncFailed" | "overviewSyncReason" | "refresh"
  >,
  scope: string,
  /** A surface that stays mounted while hidden reports only when looked at. */
  enabled = true,
) {
  const { loadFailed, loadReason, overviewSyncFailed, overviewSyncReason, refresh } = controller
  useEffect(() => {
    const id = `${scope}-read`
    if (!enabled || !loadFailed) {
      clearLive(id)
      return
    }
    notifyLive({
      id,
      type: "error",
      title: "通知读取失败",
      reason: loadReason,
      description: "现有内容可能不是最新，请使用刷新重试。",
      action: { label: "重试", onClick: () => void refresh() },
    })
    return () => clearLive(id)
  }, [enabled, loadFailed, loadReason, refresh, scope])

  useEffect(() => {
    const id = `${scope}-overview-sync`
    if (!enabled || !overviewSyncFailed) {
      clearLive(id)
      return
    }
    notifyLive({
      id,
      type: "error",
      title: "已加入工作空间，但工作台尚未同步",
      reason: overviewSyncReason,
      description: "请使用刷新重试，不要再次接受邀请。",
      action: { label: "重试", onClick: () => void refresh() },
    })
    return () => clearLive(id)
  }, [enabled, overviewSyncFailed, overviewSyncReason, refresh, scope])
}

/**
 * One reader for the window. The provider owns the poll so a beat only
 * re-renders surfaces that subscribe (bell, inbox), not the module canvas.
 */
export function NotificationsProvider({
  children,
  enabled,
  onAccepted,
}: { children: ReactNode } & UseNotificationsOptions) {
  const controller = useNotifications({ enabled, onAccepted })
  const credential = useInvitationCredential()
  useNotificationLiveToasts(controller, "invitation-link", Boolean(credential))
  return createElement(NotificationsContext.Provider, { value: controller },
    children, createElement(WorkspaceInvitationPrompt, { controller }))
}

/** Injected controller wins so tests do not have to mount the poll. */
export function useNotificationsController(
  injected?: NotificationsController,
): NotificationsController {
  const fromContext = useContext(NotificationsContext)
  const controller = injected ?? fromContext
  if (!controller) {
    throw new Error("useNotificationsController requires NotificationsProvider")
  }
  return controller
}
/** The provider shares one poll between the bell and both notification surfaces. */
export function useNotifications(
  options: UseNotificationsOptions = {},
): NotificationsController {
  const { enabled = true, onAccepted } = options
  const [view, setView] = useState<NotificationsView>()
  const [pending, setPending] = useState<string>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadReason, setLoadReason] = useState<unknown>()
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [overviewSyncFailed, setOverviewSyncFailed] = useState(false)
  const [overviewSyncReason, setOverviewSyncReason] = useState<unknown>()
  const viewRef = useRef(view)
  viewRef.current = view
  const failing = useRef(false)
  const readVersion = useRef(0)
  const loadedPages = useRef(1)
  const writeInFlight = useRef(false)
  const refreshInFlight = useRef(false)
  const loadMoreInFlight = useRef(false)
  const pollInFlight = useRef(false)
  const overviewSyncFailedRef = useRef(false)
  const accepted = useRef(onAccepted)
  accepted.current = onAccepted

  const load = useCallback(
    async (trigger: NotificationsReadTrigger, cursor?: string) => {
      const version = ++readVersion.current
      try {
        const loaded = cursor
          ? {
              view: await accountHttp.accountListNotifications(cursor),
              pages: loadedPages.current + 1,
            }
          : await readNotificationPages(
              (nextCursor) => accountHttp.accountListNotifications(nextCursor),
              loadedPages.current,
            )
        if (!isLatestNotificationRead(version, readVersion.current)) return
        const current = viewRef.current
        const next =
          cursor && current
            ? appendNotificationPage(current, loaded.view)
            : loaded.view
        if (!cursor) {
          const headline = arrivedInvitationHeadline(current, next)
          if (headline) {
            notifyInfo(headline, { description: "打开通知，粘贴创建者私下提供的邀请链接后接受或拒绝。" })
          }
        }
        if (!sameNotificationsView(current, next)) {
          viewRef.current = next
          setView(next)
        }
        loadedPages.current = loaded.pages
        setLoadFailed(false)
        setLoadReason(undefined)
        failing.current = false
      } catch (reason) {
        if (!isLatestNotificationRead(version, readVersion.current)) return
        if (shouldAnnounceReadFailure(trigger, failing.current)) {
          notifyCommandError(reason, "无法读取通知，请稍后重试。")
        }
        failing.current = true
        setLoadReason(() => reason)
        setLoadFailed(true)
      }
    },
    [],
  )

  const reload = useCallback(() => load("settle"), [load])
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      await load("refresh")
      if (overviewSyncFailedRef.current && accepted.current) {
        try {
          await accepted.current()
          overviewSyncFailedRef.current = false
          setOverviewSyncFailed(false)
          setOverviewSyncReason(undefined)
        } catch (reason) {
          setOverviewSyncReason(() => reason)
          notifyCommandError(reason, "已加入工作空间，但工作台同步失败；请再次刷新通知。")
        }
      }
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [load])

  const loadMore = useCallback(async () => {
    const cursor = view?.next_cursor
    if (!cursor || loadMoreInFlight.current) return
    loadMoreInFlight.current = true
    setLoadingMore(true)
    try {
      await load("more", cursor)
    } finally {
      loadMoreInFlight.current = false
      setLoadingMore(false)
    }
  }, [load, view?.next_cursor])

  useEffect(
    () => () => {
      readVersion.current += 1
    },
    [],
  )

  useVisiblePolling({
    enabled,
    intervalMs: POLL_INTERVAL_MS,
    onPoll: (trigger) => {
      // A beat slower than the network must not stack reads: the manual
      // refresh path stays open, only poll-fired reads dedup.
      if (pollInFlight.current) return
      pollInFlight.current = true
      void load(trigger).finally(() => {
        pollInFlight.current = false
      })
    },
  })

  /** Hold the action-specific pending marker while its write settles. */
  const settleRow = useCallback(
    async (pendingKey: string, settle: () => Promise<boolean>) => {
      return (
        (await runNotificationWrite(writeInFlight, async () => {
          setPending(pendingKey)
          try {
            return await settle()
          } finally {
            setPending(undefined)
          }
        })) ?? false
      )
    },
    [],
  )

  const markRead = useCallback(
    async (notificationUuid: string) => {
      await settleRow(`read:${notificationUuid}`, () =>
        settleNotificationAction(
          () => accountHttp.accountMarkNotificationRead(notificationUuid),
          reload,
          "无法标为已读，请稍后重试。",
        ),
      )
    },
    [reload, settleRow],
  )

  const markAllRead = useCallback(async () => {
    await settleRow("all", () =>
      settleNotificationAction(
        () => accountHttp.accountMarkAllNotificationsRead(),
        reload,
        "无法全部标为已读，请稍后重试。",
      ),
    )
  }, [reload, settleRow])

  const acceptInvitation = useCallback(
    async (invitationUuid: string, token: string) => {
      try {
        const joined = await settleRow(`accept:${invitationUuid}`, () =>
          settleAcceptInvitation(
            () => accountHttp.accountAcceptWorkspaceInvitation(invitationUuid, token),
            reload,
            accepted.current,
          ),
        )
        if (joined) {
          overviewSyncFailedRef.current = false
          setOverviewSyncFailed(false)
          setOverviewSyncReason(undefined)
        }
        return joined
      } catch (reason) {
        overviewSyncFailedRef.current = true
        setOverviewSyncReason(() => reason)
        setOverviewSyncFailed(true)
        notifyCommandError(reason, "已加入工作空间，但工作台同步失败；请刷新通知重试。")
        return true
      }
    },
    [reload, settleRow],
  )

  const declineInvitation = useCallback(
    async (invitationUuid: string, token: string) => {
      const declined = await settleRow(`decline:${invitationUuid}`, () =>
        settleNotificationAction(
          () => accountHttp.accountDeclineWorkspaceInvitation(invitationUuid, token),
          reload,
          "无法拒绝邀请，请稍后重试。",
        ),
      )
      if (declined) notifySuccess("已拒绝邀请")
      return declined
    },
    [reload, settleRow],
  )

  const notifications = view?.notifications ?? []
  const markingAllRead = pending === "all"
  const writing = pending !== undefined

  return {
    notifications,
    unread: view?.unread ?? 0,
    total: view?.total ?? notifications.length,
    hasMore: Boolean(view?.next_cursor),
    loaded: view !== undefined,
    loadFailed,
    loadReason,
    refreshing,
    loadingMore,
    pending,
    markingAllRead,
    writing,
    overviewSyncFailed,
    overviewSyncReason,
    refresh,
    loadMore,
    markRead,
    markAllRead,
    acceptInvitation,
    declineInvitation,
  }
}
