import { INVITATION_SETTLED_COPY, INVITATION_STATUS_LABEL, formatDateTime, invitationRoleLabel, invitationState, isUnread } from "./notification-view"
import { Check, X } from "lucide-react"

import type { NotificationView } from "@/bindings/commands"
import type { AppScreen } from "@/lib/app-screens"
import { formatCents } from "@/lib/money"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { NotificationsController } from "./notifications"
import { cn } from "@/lib/utils"

/**
 * How one Notification reads and what it offers, shared by the notification
 * centre's surfaces — the addressable screen rows and the floating inbox's
 * reading pane — so the copy and the writes can never drift apart.
 */

/** The status chip a Notification carries: invitation state, else its kind. */
export function NotificationKindBadge({
  notification,
}: {
  notification: NotificationView
}) {
  const invitation = notification.invitation
  const state = invitation ? invitationState(invitation) : undefined
  return state ? (
    <Badge variant="outline">{INVITATION_STATUS_LABEL[state]}</Badge>
  ) : (
    <Badge variant="code">{notification.kind}</Badge>
  )
}

/** The body sentence: what this Notification actually says. */
export function NotificationBody({
  notification,
  className,
}: {
  notification: NotificationView
  className?: string
}) {
  const invitation = notification.invitation
  const commission = notification.commission
  const withdrawal = notification.withdrawal
  const delegateEvent = notification.delegate_event
  const state = invitation ? invitationState(invitation) : undefined
  const pending = state === "pending"
  if (invitation && state) {
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        <span className="font-mono text-foreground">
          {invitation.inviter_email}
        </span>{" "}
        邀请你以「{invitationRoleLabel(invitation.role)}」身份加入{" "}
        {invitation.workspace_name}
        {" · "}
        {pending
          ? `有效期至 ${formatDateTime(invitation.expires_at_ms)}`
          : INVITATION_SETTLED_COPY[state]}
      </p>
    )
  }
  if (commission) {
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        {formatCents(commission.amount_cents)}（订单{" "}
        <span className="font-mono text-foreground">
          {commission.payment_order_public_id}
        </span>
        ，被邀请人 {commission.invitee_email}）已进入你的佣金余额。
      </p>
    )
  }
  if (withdrawal) {
    const paid = notification.kind === "agent_withdrawal_paid"
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        提现 {formatCents(withdrawal.amount_cents)}（单号{" "}
        <span className="font-mono text-foreground">{withdrawal.public_id}</span>
        ）{paid ? "已打款到账。" : `被拒绝：${withdrawal.reject_reason ?? ""}，金额已退回可用余额。`}
      </p>
    )
  }
  const subscription = notification.subscription
  if (subscription && notification.kind === "subscription_renewal_due") {
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        续费订单{" "}
        <span className="font-mono text-foreground">{subscription.public_id}</span>
        （{formatCents(subscription.amount_cents ?? 0)}）已生成，到期前付款才会续上服务；不付款则到期后工作区冻结。
      </p>
    )
  }
  if (subscription && notification.kind === "subscription_frozen") {
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        工作区「{subscription.workspace_name}」的付费服务已到期，所有店铺已冻结。续费后恢复，配置和历史数据保留。
      </p>
    )
  }
  if (delegateEvent) {
    const posting = (
      <span className="font-mono text-foreground">
        {delegateEvent.posting_number}
      </span>
    )
    const factory = delegateEvent.source_name
    if (delegateEvent.event === "shipped") {
      return (
        <p className={cn("text-compact text-muted-foreground", className)}>
          厂家「{factory}」已发货委托单 {posting}
          {delegateEvent.tracking_no
            ? `，运单号 ${delegateEvent.tracking_no}`
            : ""}
          。
        </p>
      )
    }
    if (delegateEvent.event === "rejected") {
      return (
        <p className={cn("text-compact text-muted-foreground", className)}>
          厂家「{factory}」拒绝了委托单 {posting}：
          {delegateEvent.reject_reason ?? "未填写原因"}
          。改绑厂家或手动派发后才会重新派发。
        </p>
      )
    }
    return (
      <p className={cn("text-compact text-muted-foreground", className)}>
        委托单 {posting} 在 Ozon 已取消，委托单与派发包已核销划线。
      </p>
    )
  }
  return (
    <p className={cn("text-compact text-muted-foreground", className)}>
      当前版本还不能展开这条通知；升级后即可查看详情。
    </p>
  )
}

/**
 * The writes one Notification offers. Any write in flight locks every action:
 * a double-submit must not race Cloud's invitation state machine.
 */
export function NotificationActions({
  notification,
  controller,
  onNavigate,
}: {
  notification: NotificationView
  controller: NotificationsController
  onNavigate?: (screen: AppScreen) => void
}) {
  const invitation = notification.invitation
  const commission = notification.commission
  const state = invitation ? invitationState(invitation) : undefined
  const pending = state === "pending"
  const unread = isUnread(notification)
  const writing = controller.writing
  async function respond(accept: boolean) {
    if (!invitation || !pending || writing) return
    await (accept
      ? controller.acceptInvitation(invitation.uuid)
      : controller.declineInvitation(invitation.uuid))
  }

  return (
    <>
      {(commission || notification.withdrawal) && onNavigate ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onNavigate("agent")}
        >
          打开代理中心
        </Button>
      ) : null}
      {invitation && pending ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={writing || controller.overviewSyncFailed}
            onClick={() => void respond(true)}
          >
            {controller.pending === `accept:${invitation.uuid}` ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Check data-icon="inline-start" />
            )}
            接受
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={writing}
            onClick={() => void respond(false)}
          >
            {controller.pending === `decline:${invitation.uuid}` ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <X data-icon="inline-start" />
            )}
            拒绝
          </Button>
        </div>
      ) : unread ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={writing}
          onClick={() => void controller.markRead(notification.uuid)}
        >
          {controller.pending === `read:${notification.uuid}` ? (
            <Spinner data-icon="inline-start" />
          ) : null}
          标为已读
        </Button>
      ) : null}
    </>
  )
}
