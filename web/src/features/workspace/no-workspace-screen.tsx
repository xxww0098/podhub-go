import { useId, useState } from "react"
import { Plus } from "lucide-react"

import type { WorkspaceStandingView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { DialogFooter } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

const NAME_MAX = 64

/**
 * The `unaffiliated` Account Mode: owning no Workspace and holding no
 * Membership — reachable by dissolving and leaving everything. It is a normal
 * signed-in state with two ways forward: create a Workspace, or wait for a
 * Workspace Invitation to arrive as a Notification.
 */
export function NoWorkspaceScreen({
  email,
  onCreated,
}: {
  /** The registered address an inviter must address; shown so it can be passed on. */
  email?: string
  onCreated: (standing: WorkspaceStandingView) => void
}) {
  return (
    <div className="flex w-full flex-col gap-5">
      <h1 className="sr-only">工作空间</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>创建工作空间</CardTitle>
            <CardDescription>
              你将成为所有者，使用 Free 套餐；创建后自动进入。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateWorkspaceForm onCreated={onCreated} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>等待邀请</CardTitle>
            <CardDescription>
              加入已有工作空间，由工作空间所有者或管理员向你发送邀请。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-compact leading-relaxed text-muted-foreground">
            {email ? (
              <p className="break-all rounded-lg border border-border px-3 py-2 font-mono text-meta text-foreground select-all">
                {email}
              </p>
            ) : (
              <p>使用你注册时填写的邮箱地址。</p>
            )}
            <p>邀请送达后会出现在通知列表里，接受后即可加入工作空间。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * The single create-Workspace control: this screen renders it inline, the Workspace
 * switcher renders it in a dialog. Cloud owns the refusal (`WORKSPACE_LIMIT_REACHED`)
 * and writes the next step into the message it returns; the host carries the code
 * through, so `notifyCommandError` holds it on screen rather than flashing a next
 * step nobody can act on in six seconds.
 */
export function CreateWorkspaceForm({
  onCreated,
  onCancel,
  inDialog = false,
}: {
  onCreated: (standing: WorkspaceStandingView) => void
  onCancel?: () => void
  inDialog?: boolean
}) {
  const nameId = useId()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && trimmed.length <= NAME_MAX

  async function submit() {
    setBusy(true)
    try {
      const standing = await accountHttp.accountCreateWorkspace(trimmed)
      notifySuccess("工作空间已创建", {
        description: `${trimmed} 已经是当前工作空间。`,
      })
      setName("")
      onCreated(standing)
    } catch (reason) {
      notifyCommandError(reason, "无法创建工作空间，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !busy) void submit()
      }}
    >
      <Field>
        <FieldLabel htmlFor={nameId}>工作空间名称</FieldLabel>
        <Input
          id={nameId}
          name="name"
          required
          maxLength={NAME_MAX}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：枝枝楠楠"
          className="placeholder:text-muted-foreground"
          autoFocus={inDialog}
        />
      </Field>

      {inDialog ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          加入已有工作空间，请联系对方发送邀请，再从通知中接受。
        </p>
      ) : null}

      {inDialog ? (
        <DialogFooter className="mt-2">
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={busy}
            >
              取消
            </Button>
          ) : null}
          <Button type="submit" disabled={!valid || busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            创建工作空间
          </Button>
        </DialogFooter>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" disabled={!valid || busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            创建工作空间
          </Button>
          {onCancel ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={busy}
            >
              取消
            </Button>
          ) : null}
        </div>
      )}
    </form>
  )
}
