import { lazy, Suspense, useState } from "react"
import { Bell, Building2, LogOut } from "lucide-react"
import { motion } from "motion/react"

import type { AccountOverview, WorkspaceStandingView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import type { NotificationsController } from "@/features/notifications/notifications"
import { NoWorkspaceScreen } from "@/features/workspace/no-workspace-screen"
import { IconButton } from "@/components/ui/icon-button"
import { Spinner } from "@/components/ui/spinner"
import { SCREEN_LOADERS } from "@/app/screen-loaders"
import { notifyCommandError } from "@/lib/notify"

/**
 * What a signed-in account with no Workspace sees. It replaces the workspace shell
 * because every module below it is Workspace-scoped, but it must still carry the
 * Notification list: an invitation is delivered there, and accepting it is the
 * only way out of this state that does not involve creating a Workspace.
 */
/* The gate is main-bundle code while the notification pane is a lazy screen;
   importing it statically would drag the whole screen back into the entry
   chunk, so it mounts through the shared loader like the catalog does. */
const GateNotificationsScreen = lazy(async () => ({
  default: (await SCREEN_LOADERS.notifications()).NotificationsScreen,
}))

export function NoWorkspaceGate({
  overview,
  notifications,
  onCreated,
  onSignedOut,
}: {
  overview: AccountOverview
  notifications?: NotificationsController
  onCreated: (standing: WorkspaceStandingView) => void
  onSignedOut: () => void
}) {
  const [busy, setBusy] = useState(false)
  const email = overview.session.email

  async function signOut() {
    setBusy(true)
    try {
      await accountHttp.accountLogout()
      onSignedOut()
    } catch (reason) {
      notifyCommandError(reason, "无法退出登录，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/80 bg-card/60 px-4 backdrop-blur-sm sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
            <Building2 className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">PodHub</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-xs font-medium text-muted-foreground">工作空间</span>
        </div>
        <div className="flex items-center gap-3">
          {email ? (
            <span className="max-w-48 truncate font-mono text-xs text-muted-foreground sm:max-w-none">
              {email}
            </span>
          ) : null}
          <IconButton
            icon={LogOut}
            label="退出登录"
            size="icon-sm"
            onClick={signOut}
            disabled={busy}
            className="cursor-pointer hover:text-foreground"
          />
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center p-4 sm:p-6 lg:p-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="flex w-full max-w-4xl flex-col gap-6"
        >
          <NoWorkspaceScreen email={email} onCreated={onCreated} />

          <div className="flex flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-xs">
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-xs font-medium text-foreground">
              <Bell className="size-3.5 text-muted-foreground" />
              <span>通知与待处理邀请</span>
            </div>
            <div className="p-3 sm:p-4">
              <Suspense
                fallback={
                  <div className="grid min-h-32 place-items-center">
                    <Spinner aria-label="正在加载通知" />
                  </div>
                }
              >
                <GateNotificationsScreen notifications={notifications} />
              </Suspense>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
