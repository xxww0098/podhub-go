import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { clearInvitationCredential, useInvitationCredential } from "@/lib/invitation-link"
import { NotificationActions, NotificationBody, NotificationKindBadge } from "./notification-detail"
import { type NotificationsController } from "./notifications"

/** Link opening only reads metadata; membership changes require a button press. */
export function WorkspaceInvitationPrompt({ controller }: { controller: NotificationsController }) {
  const credential = useInvitationCredential()
  const notification = credential
    ? controller.notifications.find((item) => item.invitation?.uuid === credential.uuid) : undefined
  useEffect(() => {
    if (credential && !notification && controller.loaded && controller.hasMore
      && !controller.loadingMore && !controller.loadFailed && !controller.writing) {
      void controller.loadMore()
    }
  }, [credential, notification, controller])
  if (!credential) return null
  const reading = !controller.loaded || (!notification && (controller.hasMore || controller.loadingMore))
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !controller.writing) clearInvitationCredential() }}>
      <DialogContent showCloseButton={!controller.writing}>
        <DialogHeader>
          <DialogTitle>确认工作空间邀请</DialogTitle>
          <DialogDescription>请核对目标工作空间和权限，再选择接受或拒绝。</DialogDescription>
        </DialogHeader>
        {notification ? (
          <div className="flex flex-col gap-3">
            <NotificationKindBadge notification={notification} />
            <NotificationBody notification={notification} />
            <NotificationActions key={credential.uuid} notification={notification} controller={controller} credential={credential} />
          </div>
        ) : reading && !controller.loadFailed ? (
          <Spinner aria-label="正在读取邀请" />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">当前账户的通知中尚未找到该邀请。请使用收件邮箱登录；旧邀请可请创建者撤销重发。</p>
            <Button variant="outline" disabled={controller.refreshing} onClick={() => void controller.refresh()}>刷新通知</Button>
          </div>
        )}
        <Button variant="outline" disabled={controller.writing} onClick={() => clearInvitationCredential()}>退出确认</Button>
      </DialogContent>
    </Dialog>
  )
}
