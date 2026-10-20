import { useEffect, useState } from "react"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { replaceAddress } from "@/lib/address"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

const VERIFY = "email_verify"
const RESET = "password_reset"

/**
 * Mail links land in the URL fragment. Verification posts immediately. A reset
 * link opens a password dialog on whatever page is already showing.
 */
export function EmailLinkHost() {
  const [resetToken, setResetToken] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const verify = params.get(VERIFY)
    const reset = params.get(RESET)
    if (!verify && !reset) return
    params.delete(VERIFY)
    params.delete(RESET)
    const remainder = params.toString()
    replaceAddress({ hash: remainder ? `#${remainder}` : "" })
    if (verify) {
      void accountHttp.accountVerifyEmail(verify).then(
        () => {
          notifySuccess("邮箱已验证")
          window.location.reload()
        },
        (reason: unknown) => {
          notifyCommandError(reason, "无法验证邮箱，请重新发送验证邮件。")
        },
      )
    }
    if (reset) setResetToken(reset)
  }, [])

  async function submitReset() {
    if (!resetToken) return
    if (password.length < 8) {
      notifyError("密码至少需要 8 个字符")
      return
    }
    setBusy(true)
    try {
      await accountHttp.accountResetPassword(resetToken, password)
      setPassword("")
      setResetToken(null)
      notifySuccess("密码已重置，请使用新密码登录。")
    } catch (reason) {
      notifyCommandError(reason, "无法重置密码，请重新申请重置邮件。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={resetToken !== null} onOpenChange={(open) => { if (!open) setResetToken(null) }}>
      <DialogContent>
        <DialogTitle>设置新密码</DialogTitle>
        <DialogDescription>链接只能使用一次。设置完成后请用新密码登录。</DialogDescription>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submitReset()
          }}
        >
          <Field>
            <FieldLabel htmlFor="reset-password">新密码</FieldLabel>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              保存新密码
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
