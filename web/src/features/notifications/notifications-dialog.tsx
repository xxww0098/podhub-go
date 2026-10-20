import { formatDateTime, isUnread, notificationHeadline, relativeTimeLabel } from "./notification-view"
import { useNotificationLiveToasts, useNotificationsController } from "./notifications"
import { notificationsSummary, NotificationToolbarActions } from "./notifications-toolbar"
import { useState } from "react"
import { Inbox } from "lucide-react"

import type { NotificationView } from "@/bindings/commands"
import type { AppScreen } from "@/lib/app-screens"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  NotificationActions,
  NotificationBody,
  NotificationKindBadge,
} from "./notification-detail"
import {
  type NotificationsController,
} from "./notifications"
import { cn } from "@/lib/utils"

/**
 * The notification centre as a floating window — the mail reader over the
 * bell's glance: a list rail on the left (title + received time), the selected
 * notification's full reading pane on the right. It floats instead of
 * navigating so a glance at the inbox never costs the module underneath.
 *
 * Subscribes to the window's one Notification reader (same list as the bell
 * and the screen). Tests inject a controller and can render `NotificationsInbox`
 * directly — the Dialog portal does not paint under SSR.
 */
export function NotificationsDialog({
  open,
  onOpenChange,
  focusUuid,
  notifications: injected,
  onNavigate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A bell row can open the inbox already pointing at itself. */
  focusUuid?: string
  notifications?: NotificationsController
  onNavigate?: (screen: AppScreen) => void
}) {
  const controller = useNotificationsController(injected)
  /* The dialog stays mounted after its first open; a closed window must not
     double-report failures the addressable screen already carries. */
  useNotificationLiveToasts(controller, "notifications-dialog", open)

  /* A drill-in leaves the floating window behind rather than stacking a
     screen change under it. */
  const drillIn = onNavigate
    ? (screen: AppScreen) => {
        onOpenChange(false)
        onNavigate(screen)
      }
    : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(32rem,calc(100dvh-3rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border py-3 pl-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <DialogTitle>通知</DialogTitle>
            <p
              aria-live="polite"
              className="truncate text-meta text-muted-foreground"
            >
              {notificationsSummary(controller)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <NotificationToolbarActions controller={controller} />
          </div>
        </DialogHeader>
        <NotificationsInbox
          controller={controller}
          focusUuid={focusUuid}
          onNavigate={drillIn}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The two columns inside the floating window — also the piece tests render
 * without a portal. `focusUuid` only names the opening selection; the popup
 * unmounts on close, so the next open re-derives it.
 */
export function NotificationsInbox({
  controller,
  focusUuid,
  onNavigate,
}: {
  controller: NotificationsController
  focusUuid?: string
  onNavigate?: (screen: AppScreen) => void
}) {
  const { notifications, hasMore, loaded, loadingMore, refreshing, writing } =
    controller
  const [pickedUuid, setPickedUuid] = useState(focusUuid)
  const selected =
    notifications.find((item) => item.uuid === pickedUuid) ?? notifications[0]

  function select(notification: NotificationView) {
    setPickedUuid(notification.uuid)
    if (isUnread(notification)) void controller.markRead(notification.uuid)
  }

  if (!loaded) {
    return <InboxSkeleton />
  }
  if (notifications.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>还没有通知</EmptyTitle>
          <EmptyDescription>
            Workspace 邀请会出现在这里；收到后可以直接接受或拒绝。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <div className="flex shrink-0 flex-col border-border max-sm:max-h-44 max-sm:min-h-0 max-sm:border-b sm:w-60 lg:w-64 sm:border-r">
        <ol aria-label="通知列表" className="min-h-0 flex-1 overflow-y-auto">
          {notifications.map((notification) => {
            const active = selected?.uuid === notification.uuid
            const unread = isUnread(notification)
            return (
              <li
                key={notification.uuid}
                className="border-t border-border/60 first:border-t-0"
              >
                <button
                  type="button"
                  aria-current={active || undefined}
                  onClick={() => select(notification)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    active && "bg-accent",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        unread ? "bg-brand" : "bg-transparent",
                      )}
                    />
                    <span className="sr-only">{unread ? "未读" : "已读"}</span>
                    <span
                      className={cn(
                        "truncate text-compact",
                        unread && "font-medium",
                      )}
                    >
                      {notificationHeadline(notification)}
                    </span>
                  </span>
                  <span className="truncate pl-3 text-meta text-muted-foreground tabular-nums">
                    {relativeTimeLabel(notification.created_at_ms)}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {hasMore ? (
          <div className="shrink-0 border-t border-border p-1.5">
            <Button
              className="w-full"
              variant="ghost"
              size="sm"
              aria-busy={loadingMore}
              disabled={loadingMore || refreshing || writing}
              onClick={() => void controller.loadMore()}
            >
              {loadingMore ? <Spinner data-icon="inline-start" /> : null}
              {loadingMore ? "正在加载…" : "加载更多"}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <article className="flex min-h-full flex-col gap-3 px-5 py-4">
            <header className="flex flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="min-w-0 truncate text-sm font-medium">
                  {notificationHeadline(selected)}
                </h2>
                <NotificationKindBadge notification={selected} />
              </div>
              <p className="text-meta text-muted-foreground tabular-nums">
                {formatDateTime(selected.created_at_ms)}
              </p>
            </header>
            <NotificationBody
              notification={selected}
              className="leading-relaxed"
            />
            <div className="flex items-center gap-2 pt-1 empty:hidden">
              <NotificationActions
                notification={selected}
                controller={controller}
                onNavigate={onNavigate}
              />
            </div>
          </article>
        ) : null}
      </div>
    </div>
  )
}

/** Two shimmer columns so the first list does not shove the window. */
function InboxSkeleton() {
  return (
    <div aria-hidden className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <div className="shrink-0 border-border max-sm:border-b sm:w-60 sm:border-r lg:w-64">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2.5 first:border-t-0"
          >
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 px-5 py-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
      </div>
    </div>
  )
}
