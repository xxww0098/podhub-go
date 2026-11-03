import { useId, useState, type FormEvent } from "react"
import { Check, Copy } from "lucide-react"
import type { WorkspaceInvitationCreatedView } from "@/bindings/commands"
import { createWorkspaceInvitation } from "@/bindings/http-workspace-invitations"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { formatRole } from "@/components/workspace-display"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeShort } from "@/lib/format"
import { privateInvitationLink } from "@/lib/invitation-link"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

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
  const [created, setCreated] = useState<WorkspaceInvitationCreatedView>()
  const [copied, setCopied] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || created || !roles.includes(role)) return
    setBusy(true)
    setError("")
    try {
      const next = await createWorkspaceInvitation(email.trim(), role)
      privateInvitationLink(next, window.location.origin)
      setCreated(next)
      onCreated()
    } catch (reason) {
      setError(errorMessage(reason, "无法创建邀请，请刷新邀请列表后重试。"))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(privateInvitationLink(created, window.location.origin))
      setCopied(true)
      notifySuccess("已复制私密邀请链接")
    } catch (reason) {
      notifyCommandError(reason, "无法复制，请从私密链接输入框手动复制。")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{created ? "邀请已创建" : "邀请成员"}</DialogTitle>
          <DialogDescription>{workspaceName}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex min-w-0 flex-col gap-4">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">邮箱</dt><dd className="break-all">{created.email}</dd>
              <dt className="text-muted-foreground">角色</dt><dd>{formatRole(created.role)}</dd>
              <dt className="text-muted-foreground">有效期至</dt><dd>{formatDateTimeShort(created.expires_at_ms)}</dd>
            </dl>
            <Field>
              <FieldLabel htmlFor={`${id}-link`}>私密邀请链接</FieldLabel>
              <Input id={`${id}-link`} type="password" autoComplete="off" readOnly
                value={privateInvitationLink(created, window.location.origin)} />
              <FieldDescription>链接仅本次可复制。请私下发给收件人，由对方登录该邮箱后确认加入。</FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>完成</Button>
              <Button type="button" onClick={() => void copy()}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "再次复制链接" : "复制私密邀请链接"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>收件邮箱</FieldLabel>
              <Input id={`${id}-email`} type="email" required maxLength={320} autoComplete="email"
                value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
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
                {busy ? <Spinner aria-hidden /> : null}{busy ? "创建中…" : "创建邀请"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
