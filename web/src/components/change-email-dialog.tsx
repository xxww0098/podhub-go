import { useRef, useState } from "react"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

export function ChangeEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  function close() {
    if (pending.current) return
    setEmail("")
    setPassword("")
    onOpenChange(false)
  }

  async function submit() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await accountHttp.accountRequestEmailChange(email.trim(), password)
      setEmail("")
      setPassword("")
      onOpenChange(false)
      notifySuccess("确认邮件已提交发送，请前往新邮箱查收。")
    } catch (reason) {
      notifyCommandError(reason, "无法申请更换邮箱，请稍后重试。")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更换邮箱</DialogTitle>
          <DialogDescription>请使用新邮箱中的链接确认。确认后所有设备需要重新登录。</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <Field>
            <FieldLabel htmlFor="change-email-address">新邮箱</FieldLabel>
            <Input id="change-email-address" type="email" autoComplete="email" required maxLength={320} value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="change-email-password">当前密码</FieldLabel>
            <Input id="change-email-password" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : null}{busy ? "正在提交" : "发送确认邮件"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
