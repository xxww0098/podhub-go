import { useEffect, useRef, useState } from "react"
import { Check, MailPlus } from "lucide-react"

import type {
  CreateWorkspaceInvitationRequest,
  WorkspaceInvitationCreatedView,
} from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { formatDateTimeShort } from "@/lib/format"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { formatRole } from "@/components/workspace-display"
import { privateInvitationLink } from "@/lib/invitation-link"

type MemberRole = "owner" | "manager" | "member"

export function invitationOutcome(created: WorkspaceInvitationCreatedView) {
  return {
    title: "邀请已创建",
    description: `请将私密链接只发给 ${created.email}。对方在浏览器登录该邮箱或注册后，确认工作空间与权限再接受；通知列表中也可粘贴链接处理。`,
  }
}

export function WorkspaceInviteDialog({
  open,
  onOpenChange,
  onInvite,
  inviteRoles,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInvite: (request: CreateWorkspaceInvitationRequest) => Promise<WorkspaceInvitationCreatedView>
  inviteRoles: string[]
}) {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [created, setCreated] = useState<WorkspaceInvitationCreatedView>()
  const [privateLink, setPrivateLink] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<MemberRole>("member")
  const [emailTouched, setEmailTouched] = useState(false)
  const emailTrimmed = email.trim()
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)
  const outcome = created ? invitationOutcome(created) : undefined

  function setOpen(next: boolean) {
    if (submitting.current) return
    if (!next) {
      setCreated(undefined)
      setPrivateLink("")
      setEmail("")
      setRole("member")
      setEmailTouched(false)
    }
    onOpenChange(next)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !emailValid || !inviteRoles.includes(role) || !inviteRoles.length || !event.currentTarget.reportValidity()) return
    submitting.current = true
    setBusy(true)
    try {
      const result = await onInvite({ email: emailTrimmed, role })
      if (!mounted.current) return
      const link = privateInvitationLink(result, window.location.origin)
      setPrivateLink(link)
      setCreated(result)
      const nextOutcome = invitationOutcome(result)
      notifySuccess(nextOutcome.title, { description: nextOutcome.description })
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法创建邀请，请稍后重试。")
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={!busy} className="max-h-5/6 overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{outcome ? outcome.title : "邀请成员"}</DialogTitle>
          <DialogDescription>
            {outcome
              ? outcome.description
              : "填写邮箱并选择角色；接受邀请后才占用成员名额。"}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-start gap-3 rounded-lg border border-st-good/25 bg-st-good-soft p-4 text-st-good-ink">
              <Check className="mt-0.5 size-5" aria-hidden />
              <div className="min-w-0">
                <p className="break-all text-compact font-medium">{created.email}</p>
                <p className="text-meta">
                  {formatRole(created.role)} · 有效期至 {formatDateTimeShort(created.expires_at_ms)}
                </p>
              </div>
            </div>
            <Field>
              <label htmlFor="invite-private-link" className="text-compact font-medium">私密邀请链接</label>
              <Input id="invite-private-link" value={privateLink} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.target.select()} />
              <FieldDescription>链接只在此次创建后显示。仅私下发给收件人；任何持有链接的人都可能使用邀请，请勿公开转发。</FieldDescription>
              <Button type="button" variant="outline" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(privateLink)
                  notifySuccess("已复制私密邀请链接")
                } catch { notifyError("复制失败，请选中链接手动复制。") }
              }}>复制私密链接</Button>
            </Field>
            <p className="text-compact text-muted-foreground">
              可在「待接受的邀请」中随时撤销，撤销后从对方的通知中消失。
            </p>
          </div>
        ) : (
          <form className="flex min-w-0 flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-4">
              <Field>
                <label htmlFor="invite-email" className="text-compact font-medium">邮箱地址</label>
                <Input
                  id="invite-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="invite-email-hint"
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onBlur={() => {
                    setEmailTouched(true)
                    if (emailTrimmed && !emailValid) notifyError("请输入有效的邮箱地址。")
                  }}
                  aria-invalid={emailTouched && !emailValid}
                  placeholder="name@company.com"
                  className="placeholder:text-muted-foreground"
                  disabled={busy}
                />
                <FieldDescription id="invite-email-hint">通知会送达该邮箱的账户；接受或拒绝还需要你私下提供的邀请链接。</FieldDescription>
              </Field>
              <FieldSet disabled={busy}>
                <FieldLegend variant="label">成员角色</FieldLegend>
                <div className={inviteRoles.length > 1 ? "grid grid-cols-1 gap-2 sm:grid-cols-2" : "grid grid-cols-1 gap-2"}>
                  {inviteRoles.map((memberRole) => (
                    <label key={memberRole} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-compact has-[:checked]:border-brand/40 has-[:checked]:bg-brand-soft/45 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/25">
                      <input
                        type="radio"
                        name="role"
                        value={memberRole}
                        checked={role === memberRole}
                        onChange={() => setRole(memberRole as MemberRole)}
                        className="mt-0.5 accent-brand"
                      />
                      <span>
                        <span className="block">{formatRole(memberRole)}</span>
                        <span className="mt-1 block text-meta text-muted-foreground">
                          {memberRole === "manager"
                            ? "运营全部店铺、调整指派。管理密钥须被指派到该店，且由所有者授权。"
                            : "只运营被指派的店铺。密钥默认由所有者登记。"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </FieldSet>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>取消</Button>
              <Button type="submit" disabled={busy || !emailValid || !inviteRoles.length || !inviteRoles.includes(role)}>
                {busy ? <Spinner data-icon="inline-start" /> : <MailPlus aria-hidden />}
                创建邀请
              </Button>
            </DialogFooter>
          </form>
        )}
        {created ? <DialogFooter><Button type="button" onClick={() => setOpen(false)}>完成</Button></DialogFooter> : null}
      </DialogContent>
    </Dialog>
  )
}
