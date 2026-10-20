import { CheckCheck, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => void controller.markAllRead()}
        disabled={unread === 0 || writing}
      >
        {markingAllRead ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <CheckCheck data-icon="inline-start" />
        )}
        全部已读
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="刷新通知"
              aria-busy={refreshing}
              disabled={refreshing || writing}
              onClick={() => void controller.refresh()}
            />
          }
        >
          {refreshing ? <Spinner /> : <RefreshCw aria-hidden />}
        </TooltipTrigger>
        <TooltipContent>刷新</TooltipContent>
      </Tooltip>
    </>
  )
}
