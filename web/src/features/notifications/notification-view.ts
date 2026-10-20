import type { InvitationStatusView, NotificationInvitationView, NotificationView } from "@/bindings/commands"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"

export const INVITATION_STATUS_LABEL: Record<InvitationStatusView, string> = {
  pending: "待处理",
  accepted: "已接受",
  declined: "已拒绝",
  revoked: "已撤销",
  expired: "已过期",
}

/** What the settled row says happened, in the recipient's own terms. */
export const INVITATION_SETTLED_COPY: Record<
  Exclude<InvitationStatusView, "pending">,
  string
> = {
  accepted: "你已接受这个邀请",
  declined: "你已拒绝这个邀请",
  revoked: "邀请方已撤销这个邀请",
  expired: "邀请已过期",
}

const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  manager: "主管",
  member: "运营",
}

export function invitationRoleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role
}

export function isUnread(notification: NotificationView): boolean {
  return notification.read_at_ms == null
}

/**
 * Cloud owns the status, but a pending invitation whose window has already
 * closed is dead in both places — offering 接受 on it only buys the operator a
 * refusal. Expiry is the one transition readable off the clock, so it is the
 * one the client anticipates instead of waiting for the next poll.
 */
export function invitationState(
  invitation: NotificationInvitationView,
  now = Date.now(),
): InvitationStatusView {
  return invitation.status === "pending" && invitation.expires_at_ms <= now
    ? "expired"
    : invitation.status
}

/** The one-line name of a Notification, shared by the bell and the list. */
export function notificationHeadline(notification: NotificationView): string {
  const invitation = notification.invitation
  if (invitation) return `${invitation.workspace_name} 的加入邀请`
  const commission = notification.commission
  if (commission) {
    return `代理佣金 ${formatCents(commission.amount_cents)} 已到账`
  }
  return "新通知"
}

export function relativeTimeLabel(atMs: number, now = Date.now()): string {
  const elapsed = now - atMs
  if (elapsed < 60_000) return "刚刚"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return formatDateTimeShort(atMs)
}

export { formatDateTimeShort as formatDateTime }

