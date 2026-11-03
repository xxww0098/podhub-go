import { useEffect, useRef, useState } from "react"
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
import { Spinner } from "@/components/ui/spinner"
import { replaceAddress } from "@/lib/address"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

const RESET = "password_reset"
const EMAIL_CHANGE = "email_change"

/**
 * Email links carry their one-time token in the URL fragment.
 */
export function EmailLinkHost() {
  const [resetToken, setResetToken] = useState<string | null>(null)
  const [emailToken, setEmailToken] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  useEffect(() => {
    function readLink() {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const reset = params.get(RESET)
      const emailChange = params.get(EMAIL_CHANGE)
      if (!reset && !emailChange) return
      params.delete(RESET)
      params.delete(EMAIL_CHANGE)
      const remainder = params.toString()
      replaceAddress({ hash: remainder ? `#${remainder}` : "" })
      if (reset) {
        setEmailToken(null)
        setResetToken(reset)
      } else {
        setResetToken(null)
        setEmailToken(emailChange)
      }
    }
    readLink()
    window.addEventListener("hashchange", readLink)
    return () => window.removeEventListener("hashchange", readLink)
  }, [])

  async function submitReset() {
    if (!resetToken || pending.current) return
    if ([...password].length < 8) {
      notifyError("密码至少需要 8 个字符")
      return
    }
    if (new TextEncoder().encode(password).length > 72) {
      notifyError("密码过长，请缩短后重试。")
      return
    }
    pending.current = true
    setBusy(true)
    try {
      await accountHttp.accountResetPassword(resetToken, password)
      setPassword("")
      setResetToken(null)
      notifySuccess("密码已重置，请使用新密码登录。")
    } catch (reason) {
      notifyCommandError(reason, "无法重置密码，请重新申请重置邮件。")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function confirmEmail() {
    if (!emailToken || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await accountHttp.accountConfirmEmailChange(emailToken)
      setEmailToken(null)
      notifySuccess("邮箱已更换，请使用新邮箱登录。")
    } catch (reason) {
      notifyCommandError(reason, "无法更换邮箱，请重新申请确认邮件。")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <>
    <Dialog open={resetToken !== null} onOpenChange={(open) => {
      if (!open && !pending.current) { setPassword(""); setResetToken(null) }
    }}>
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
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {busy ? "正在保存" : "保存新密码"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={emailToken !== null} onOpenChange={(open) => {
      if (!open && !pending.current) setEmailToken(null)
    }}>
      <DialogContent>
        <DialogTitle>确认更换邮箱</DialogTitle>
        <DialogDescription>确认后原邮箱不能再用于登录，所有设备需要重新登录。</DialogDescription>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setEmailToken(null)}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void confirmEmail()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "正在确认" : "确认更换"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
