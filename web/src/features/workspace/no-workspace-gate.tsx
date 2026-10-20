import { lazy, Suspense, useEffect, useState } from "react"
import { ChevronsUpDown, LogOut, UserPlus } from "lucide-react"

import type { AccountOverview, WorkspaceStandingView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import type { NotificationsController } from "@/features/notifications/notifications"
import { NoWorkspaceScreen } from "@/features/workspace/no-workspace-screen"
import {
  StackedAccountItems,
  clearPendingWorkspaceCreate,
} from "@/components/workspace-switcher"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SCREEN_LOADERS } from "@/app/screen-loaders"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { notifyCommandError } from "@/lib/notify"

/**
 * What a signed-in account with no Workspace sees. It replaces the workspace shell
 * because every module below it is Workspace-scoped, but it must still carry the
 * Notification list: an invitation is delivered there, and accepting it is the
 * only way out of this state that does not involve creating a Workspace — or
 * switching to another signed-in account, which is why the account menu is
 * reachable from the gate's header too.
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
  onSwitchAccount,
  onLogoutAccount,
  onAddAccount,
  onSignedOut,
}: {
  overview: AccountOverview
  notifications?: NotificationsController
  onCreated: (standing: WorkspaceStandingView) => void
  onSwitchAccount?: (uuid: string) => void | Promise<void>
  onLogoutAccount?: (uuid: string) => void | Promise<void>
  onAddAccount?: () => void
  onSignedOut: () => void
}) {
  const [busy, setBusy] = useState(false)
  const email = overview.session.email
  const accounts = overview.accounts ?? []

  /* Landing on the gate means the account is unaffiliated — this page already
     is the join-or-create surface, so a switcher's pending intent is consumed
     here instead of replaying later once a Workspace exists. */
  useEffect(() => {
    clearPendingWorkspaceCreate()
  }, [])

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
    <div className="min-h-screen w-full bg-background">
      <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <span className="text-sm font-medium">工作空间</span>
        <div className="flex items-center gap-3">
          {accounts.length > 1 || onAddAccount ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="账号"
                    className="gap-1.5"
                  />
                }
              >
                {email ? (
                  <span className="font-mono text-compact text-muted-foreground">
                    {email}
                  </span>
                ) : null}
                <ChevronsUpDown aria-hidden className="size-3.5 text-faint-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64 rounded-xl border border-border/80 p-1.5 shadow-overlay"
              >
                <DropdownMenuGroup className="flex flex-col gap-0.5">
                  <DropdownMenuLabel className="sr-only">
                    已登录账号
                  </DropdownMenuLabel>
                  <StackedAccountItems
                    accounts={accounts}
                    onSwitch={onSwitchAccount}
                    onRemove={onLogoutAccount}
                  />
                  {onAddAccount ? (
                    <DropdownMenuItem
                      className="cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium"
                      onClick={onAddAccount}
                    >
                      <UserPlus aria-hidden className="size-4 text-muted-foreground" />
                      <span>添加账号</span>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="my-1.5 bg-border/60" />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={busy}
                  className="cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium"
                  onClick={() => void signOut()}
                >
                  <LogOut aria-hidden className="size-4" />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              {email ? (
                <span className="text-compact text-muted-foreground">{email}</span>
              ) : null}
              <Button variant="ghost" size="sm" onClick={signOut} disabled={busy}>
                退出登录
              </Button>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
        <NoWorkspaceScreen email={email} onCreated={onCreated} />
        <Suspense
          fallback={
            <div className="grid min-h-32 place-items-center">
              <Spinner aria-label="正在加载通知" />
            </div>
          }
        >
          <GateNotificationsScreen notifications={notifications} />
        </Suspense>
      </main>
    </div>
  )
}
