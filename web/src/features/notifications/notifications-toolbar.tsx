import { CheckCheck, Loader2Icon, RefreshCw } from "lucide-react"

import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"
import type { NotificationsController } from "@/features/notifications/notifications"

/** The reading-standing line the addressable screen and the inbox window share. */
export function notificationsSummary(
  controller: Pick<
    NotificationsController,
    "notifications" | "unread" | "total" | "hasMore" | "loaded" | "loadFailed"
  >,
): string {
  const { notifications, unread, total, hasMore, loaded, loadFailed } = controller
  if (!loaded) {
    return loadFailed ? "读取失败" : "正在读取通知…"
  }
  return `${unread > 0 ? `${unread} 条未读 · ` : ""}${hasMore ? `已加载 ${notifications.length} / ` : ""}共 ${total} 条`
}

/** 全部已读 + 刷新 — the write actions every Notification surface carries. */
export function NotificationToolbarActions({
  controller,
}: {
  controller: NotificationsController
}) {
  const { unread, refreshing, markingAllRead, writing } = controller
  return (
    <>
      <IconButton
        icon={markingAllRead ? Loader2Icon : CheckCheck}
        label="全部已读"
        variant="outline"
        size="icon-sm"
        className={cn(markingAllRead && "[&_svg]:animate-spin")}
        aria-busy={markingAllRead}
        onClick={() => void controller.markAllRead()}
        disabled={unread === 0 || writing}
      />
      <IconButton
        icon={refreshing ? Loader2Icon : RefreshCw}
        label="刷新通知"
        variant="outline"
        size="icon-sm"
        className={cn(refreshing && "[&_svg]:animate-spin")}
        aria-busy={refreshing}
        disabled={refreshing || writing}
        onClick={() => void controller.refresh()}
      />
    </>
  )
}
