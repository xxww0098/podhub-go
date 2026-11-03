import { useEffect, useRef, useState } from "react"
import type { CloudRefusal } from "@/api/client"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError, notifyError, notifyInfo } from "@/lib/notify"

export const PASSWORD_RECOVERY_ACCEPTED = "若该邮箱可用于找回，你将收到重置邮件。未收到可稍后重试或联系管理员。"

/** Shared by workspace, platform and factory sign-in. Acceptance is not delivery. */
export function PasswordRecoveryButton({ email = "", disabled = false }: { email?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retryUntil, setRetryUntil] = useState(0)
  const pending = useRef(false)
  const emailInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!retryUntil) return
    const timer = window.setTimeout(() => setRetryUntil(0), Math.max(0, retryUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [retryUntil])

  async function submit() {
    if (pending.current || Date.now() < retryUntil) return
    if (!address.trim()) {
      setInvalid(true)
      notifyError("请输入邮箱")
      emailInput.current?.focus()
      return
    }
    pending.current = true
    setBusy(true)
    try {
      await accountHttp.accountForgotPassword(address.trim())
      setOpen(false)
      notifyInfo(PASSWORD_RECOVERY_ACCEPTED, { timeout: 8_000 })
    } catch (reason) {
      const refusal = reason as Partial<CloudRefusal> | null
      if (refusal?.status === 429) {
        const delay = refusal.retryAfterMs
        setRetryUntil(Date.now() + (typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2_147_483_647) : 60_000))
      }
      notifyCommandError(reason, "找回申请未被确认，请稍后重试；若问题持续，请联系管理员。")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} className="h-auto min-h-0 px-0 py-0 text-sm font-normal leading-snug hover:bg-transparent max-md:min-h-6" onClick={() => {
        setAddress(email)
        setInvalid(false)
        setOpen(true)
      }}>忘记密码？</Button>
      <Dialog open={open} onOpenChange={(next) => { if (!pending.current) setOpen(next) }}>
        <DialogContent>
          <DialogTitle>找回密码</DialogTitle>
          <DialogDescription>输入账户邮箱以申请重置链接。邮件可能需要几分钟送达。</DialogDescription>
          <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor="password-recovery-email">邮箱</FieldLabel>
              <Input ref={emailInput} id="password-recovery-email" type="email" autoComplete="email" value={address} aria-invalid={invalid} disabled={busy} onChange={(event) => {
                setAddress(event.target.value)
                setInvalid(false)
              }} />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={busy || retryUntil > Date.now()}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "正在申请" : retryUntil > Date.now() ? "请稍后重试" : "申请重置邮件"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
