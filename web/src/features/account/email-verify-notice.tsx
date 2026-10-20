import { useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

export function EmailVerifyNotice({ overview }: { overview: AccountOverview }) {
  const [busy, setBusy] = useState(false)
  if (overview.session.email_verified !== false) return null

  async function resend() {
    setBusy(true)
    try {
      await accountHttp.accountResendVerification()
      notifySuccess("如果邮箱还未验证，我们已重新发送验证邮件。")
    } catch (reason) {
      notifyCommandError(reason, "无法发送验证邮件，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 border-b border-border bg-card px-4 py-2">
      <p className="text-sm text-muted-foreground">
        邮箱还没有验证。验证后才能接受工作空间邀请。
      </p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void resend()}>
        重新发送
      </Button>
    </div>
  )
}
