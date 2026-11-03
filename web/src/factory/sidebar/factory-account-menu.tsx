import { useRef, useState } from "react"
import { ChevronsUpDown, KeyRound, LogOut, Mail, Settings } from "lucide-react"

import { accountHttp } from "@/bindings/http-account"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { ChangeEmailDialog } from "@/components/change-email-dialog"
import { IdentityMark } from "@/components/identity-mark"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

export function FactoryAccountMenu({
  name,
  email,
  onSignedOut,
}: {
  name: string
  email?: string
  onSignedOut: () => void
}) {
  const { state, isMobile } = useSidebar()
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const sideRef = useRef<"top" | "right">("top")
  const accountName = name.trim() || email?.trim() || "工厂成员"

  async function changePassword(currentPassword: string, newPassword: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await accountHttp.accountChangePassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      setPasswordOpen(false)
      notifySuccess("密码已更新", { description: "其他设备上的登录已失效。" })
    } catch (reason) {
      notifyCommandError(reason, "无法修改密码，请稍后重试。")
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <div className="shell-account-card">
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            if (open) sideRef.current = !isMobile && state === "collapsed" ? "right" : "top"
            setMenuOpen(open)
          }}
        >
          <DropdownMenuTrigger
            aria-label={`账号菜单，${accountName}`}
            render={<button type="button" className={`shell-account-trigger flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 text-left outline-none hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 ${!isMobile && state === "collapsed" ? "min-h-11" : "min-h-16"}`} />}
          >
            <IdentityMark kind="user" name={accountName} className={`${!isMobile && state === "collapsed" ? "size-8" : "size-10"} shrink-0 bg-brand text-brand-foreground`} />
            <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <span className="truncate text-base font-semibold" title={accountName}>{accountName}</span>
              <span className="truncate text-sm text-muted-foreground">工厂成员</span>
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={sideRef.current} align="start" sideOffset={8} className="w-60 p-2">
            <div className="flex items-center gap-3 px-2.5 py-3">
              <IdentityMark kind="user" name={accountName} className="size-12 shrink-0 bg-brand text-brand-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-base font-semibold" title={accountName}>{accountName}</span>
                <span className="truncate text-sm text-muted-foreground">工厂成员</span>
              </span>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11" onClick={() => setSettingsOpen(true)}>
              <Settings aria-hidden className="mr-1.5 size-5" /><span className="text-base">账号设置</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onClick={onSignedOut}>
              <LogOut aria-hidden className="mr-1.5 size-5" /><span className="text-base">退出登录</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>账号设置</DialogTitle>
            <DialogDescription>查看账号资料并管理登录方式。</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-3">
            <IdentityMark kind="user" name={accountName} className="size-11 shrink-0" />
            <div className="min-w-0">
              <p className="truncate font-medium" title={accountName}>{accountName}</p>
              {email?.trim() ? <p className="break-all text-sm text-muted-foreground">{email.trim()}</p> : null}
              <p className="text-xs text-muted-foreground">工厂成员</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => { setSettingsOpen(false); setEmailOpen(true) }}>
              <Mail data-icon="inline-start" />更换邮箱
            </Button>
            <Button variant="outline" onClick={() => { setSettingsOpen(false); setPasswordOpen(true) }}>
              <KeyRound data-icon="inline-start" />修改密码
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {passwordOpen ? (
        <ChangePasswordDialog
          open
          busy={busy}
          onOpenChange={(open) => { if (!busy) setPasswordOpen(open) }}
          onSubmit={(currentPassword, newPassword) => void changePassword(currentPassword, newPassword)}
        />
      ) : null}
      {emailOpen ? <ChangeEmailDialog open onOpenChange={setEmailOpen} /> : null}
    </>
  )
}
