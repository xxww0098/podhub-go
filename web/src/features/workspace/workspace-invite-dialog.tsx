import { useId, useState, type FormEvent } from "react"
import { createWorkspaceInvitation } from "@/bindings/http-workspace-invitations"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { formatRole } from "@/components/workspace-display"
import { errorMessage } from "@/lib/error-message"
import { notifySuccess } from "@/lib/notify"

export function WorkspaceInviteDialog({ roles, workspaceName, onCreated, onClose }: {
  roles: string[]
  workspaceName: string
  onCreated: () => void
  onClose: () => void
}) {
  const id = useId()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState(roles.includes("member") ? "member" : roles[0] ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !roles.includes(role)) return
    setBusy(true)
    setError("")
    try {
      await createWorkspaceInvitation(email.trim(), role)
      onCreated()
      onClose()
      notifySuccess("邀请已发送，对方可在通知中处理")
    } catch (reason) {
      setError(errorMessage(reason, "无法创建邀请，请刷新邀请列表后重试。"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>邀请成员</DialogTitle>
          <DialogDescription>{workspaceName}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>收件邮箱</FieldLabel>
            <Input id={`${id}-email`} type="email" required maxLength={320} autoComplete="email"
              value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
            <FieldDescription>收件人需先注册账号，邀请将发送至站内通知。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-role`}>角色</FieldLabel>
            <Select value={role} disabled={busy} onValueChange={(value) => { if (value && roles.includes(value)) setRole(value) }}>
              <SelectTrigger id={`${id}-role`} className="w-full"><SelectValue>{(value) => formatRole(String(value))}</SelectValue></SelectTrigger>
              <SelectContent>{roles.map((allowed) => <SelectItem key={allowed} value={allowed}>{formatRole(allowed)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || !email.trim() || !roles.includes(role)}>
              {busy ? <Spinner aria-hidden /> : null}{busy ? "发送中…" : "发送邀请"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
