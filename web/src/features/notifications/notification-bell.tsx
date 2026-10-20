import { INVITATION_STATUS_LABEL, invitationRoleLabel, invitationState, isUnread, notificationHeadline, relativeTimeLabel } from "./notification-view"
import { useNotificationsController } from "./notifications"
import { useState } from "react"
import { Bell, CheckCheck, Inbox } from "lucide-react"

import type { NotificationView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  type NotificationsController,
} from "./notifications"
import { cn } from "@/lib/utils"

/** The popover is a glance, not the inbox; the rest lives on the screen. */
const RECENT_LIMIT = 6

/**
 * The header's unread readout. It subscribes to the window's one Notification
 * reader so a poll paints this button, not the module canvas. Tests inject a
 * controller instead of mounting the poll.
 *
 * The popover previews and marks read; accepting or declining a Workspace Invitation
 * happens in the floating inbox, where the Workspace, the inviter, the role and the
 * expiry are all in view — a seat is not something to agree to from a dropdown row.
 */
export function NotificationBell({
  notifications: injected,
  onOpenNotifications,
  className,
}: {
  notifications?: NotificationsController
  /** Opens the floating inbox; a uuid focuses that row's reading pane. */
  onOpenNotifications?: (notificationUuid?: string) => void
  className?: string
}) {
  const controller = useNotificationsController(injected)
  const {
    notifications,
    unread,
    total,
    loaded,
    loadFailed,
    markingAllRead,
    writing,
  } = controller
  const recent = notifications.slice(0, RECENT_LIMIT)
  const countLabel = unread > 0 ? `${unread} 条未读` : `共 ${total} 条`
  /* The bell is icon-only, so its name is also its tooltip — one string, two
     readers. The popover hides the tooltip while it is open. */
  const label = loaded ? `通知（${countLabel}）` : "通知"
  const [open, setOpen] = useState(false)

  function openNotification(notification: NotificationView) {
    if (isUnread(notification)) void controller.markRead(notification.uuid)
    onOpenNotifications?.(notification.uuid)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn("relative", className)}
                  aria-label={label}
                />
              }
            />
          }
        >
          <Bell aria-hidden />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-mono text-meta leading-none font-semibold text-brand-foreground tabular-nums"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8} hidden={open}>
          {label}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" sideOffset={8} className="w-80">
        <div className="px-1.5 py-1.5 text-meta text-muted-foreground">
          {!loaded
            ? loadFailed
              ? "通知读取失败"
              : "正在读取通知…"
            : countLabel}
        </div>

        <DropdownMenuSeparator />

        {!loaded ? (
          <p className="px-1.5 py-4 text-center text-compact text-muted-foreground">
            {loadFailed ? "通知读取失败，请打开通知页重试。" : "正在读取通知…"}
          </p>
        ) : recent.length === 0 ? (
          <p className="px-1.5 py-4 text-center text-compact text-muted-foreground">
            还没有通知
          </p>
        ) : (
          recent.map((notification) => (
            <DropdownMenuItem
              key={notification.uuid}
              className="items-start gap-2 py-1.5"
              onClick={() => openNotification(notification)}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  isUnread(notification) ? "bg-brand" : "bg-transparent",
                )}
              />
              <span className="sr-only">
                {isUnread(notification) ? "未读" : "已读"}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    "truncate text-compact",
                    isUnread(notification) && "font-medium",
                  )}
                >
                  {notificationHeadline(notification)}
                </span>
                <span className="truncate text-meta text-muted-foreground">
                  {summarize(notification)}
                </span>
              </span>
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          closeOnClick={false}
          disabled={unread === 0 || writing}
          onClick={() => void controller.markAllRead()}
        >
          {markingAllRead ? <Spinner /> : <CheckCheck />}
          全部已读
        </DropdownMenuItem>
        {onOpenNotifications ? (
          <DropdownMenuItem onClick={() => onOpenNotifications()}>
            <Inbox />
            查看全部通知
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function summarize(notification: NotificationView): string {
  const time = relativeTimeLabel(notification.created_at_ms)
  const invitation = notification.invitation
  if (!invitation) return time
  const state = invitationState(invitation)
  return [
    invitation.inviter_email,
    invitationRoleLabel(invitation.role),
    INVITATION_STATUS_LABEL[state],
    time,
  ].join(" · ")
}
