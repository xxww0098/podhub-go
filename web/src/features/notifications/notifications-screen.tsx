import { isUnread, notificationHeadline, relativeTimeLabel } from "./notification-view"
import { useNotificationLiveToasts, useNotificationsController } from "./notifications"
import { notificationsSummary, NotificationToolbarActions } from "./notifications-toolbar"
import { Inbox } from "lucide-react"

import type { NotificationView } from "@/bindings/commands"
import type { AppScreen } from "@/lib/app-screens"
import { PageToolbar } from "@/components/page-toolbar"
import { Button } from "@/components/ui/button"
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
} from "@/features/notifications/notification-detail"
import {
  type NotificationsController,
} from "@/features/notifications/notifications"
import { cn } from "@/lib/utils"

/**
 * The Notification centre's addressable page — what `?screen=notifications`
 * and the no-Workspace gate render. The shell's floating inbox is the same
 * list in a window; both subscribe to the window's one Notification reader.
 * Tests inject a controller instead of mounting the poll.
 */
export function NotificationsScreen({
  notifications: injected,
  onNavigate,
}: {
  notifications?: NotificationsController
  onNavigate?: (screen: AppScreen) => void
}) {
  const controller = useNotificationsController(injected)
  const { notifications, hasMore, loaded, loadFailed, loadingMore, refreshing, writing } =
    controller

  useNotificationLiveToasts(controller, "notifications")

  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="sr-only">通知</h1>
      <PageToolbar
        primary={
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {notificationsSummary(controller)}
          </p>
        }
        secondary={<NotificationToolbarActions controller={controller} />}
      />

      {!loaded ? (
        loadFailed ? null : <LoadingList />
      ) : notifications.length === 0 ? (
        <Empty>
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
      ) : (
        <div className="flex flex-col gap-3">
          <ol
            aria-label="通知列表"
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.uuid}
                notification={notification}
                controller={controller}
                onNavigate={onNavigate}
              />
            ))}
          </ol>
          {hasMore ? (
            <Button
              className="self-center"
              variant="outline"
              size="sm"
              aria-busy={loadingMore}
              disabled={loadingMore || refreshing || writing}
              onClick={() => void controller.loadMore()}
            >
              {loadingMore ? <Spinner data-icon="inline-start" /> : null}
              {loadingMore ? "正在加载…" : "加载更多"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function NotificationRow({
  notification,
  controller,
  onNavigate,
}: {
  notification: NotificationView
  controller: NotificationsController
  onNavigate?: (screen: AppScreen) => void
}) {
  const unread = isUnread(notification)

  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              unread ? "bg-brand" : "bg-transparent",
            )}
          />
          <span className="sr-only">{unread ? "未读" : "已读"}</span>
          <span className="truncate text-sm font-medium">
            {notificationHeadline(notification)}
          </span>
          <NotificationKindBadge notification={notification} />
        </div>
        <NotificationBody notification={notification} className="mt-1 pl-3.5" />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {relativeTimeLabel(notification.created_at_ms)}
        </span>
        <NotificationActions
          notification={notification}
          controller={controller}
          onNavigate={onNavigate}
        />
      </div>
    </li>
  )
}

/** Rows the size of real rows, so the first list does not shove the page. */
function LoadingList() {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 first:border-t-0"
        >
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
