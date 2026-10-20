/**
 * 管理面「厂家账号」屏 (ADR-0100)。
 *
 * `/admin?screen=supplier-accounts`：全部厂家成员按厂家分组（厂家名 / 成员
 * 邮箱 / 状态 / 开通时间）。开通与重置密码 = `super_admin`（服务端把守，
 * 界面只按会话角色收放入口）；停用/启用/解绑 = `admin` 及以上。开通/重置
 * 的一次性初始密码只在确认对话框里回显一次——关掉就再也拿不到，界面用
 * 复制按钮帮管理员转交。错误文案只走 toast，不进 DOM。
 */
import { useCallback, useEffect, useState } from "react"
import { KeyRound, Plus, UserMinus } from "lucide-react"

import type { AccountOverview } from "@/bindings/commands"
import {
  createSupplierAccount,
  deleteSupplierAccount,
  listSupplierAccounts,
  patchSupplierAccount,
  type SupplierAccountsGroup,
  type SupplierAccountMemberView,
} from "@/bindings/http-supplier-portal"
import { AdminSupplierWithdrawals } from "./admin-supplier-withdrawals"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { supplierDbsHttp } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyMedia } from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTimeShort } from "@/lib/format"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { isPlatformSuperAdminRole } from "@/lib/platform-role"

export function SupplierAccountsScreen({
  overview,
  embedded = false,
}: {
  overview: AccountOverview
  /** Render inside the settings pane, whose own heading already names the page. */
  embedded?: boolean
}) {
  const superAdmin = isPlatformSuperAdminRole(overview.session.role)
  const [groups, setGroups] = useState<SupplierAccountsGroup[]>()
  const [dbs, setDbs] = useState<SupplierDb[]>()
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [unboundId, setUnboundId] = useState<string>()
  /** 重置密码的目标成员；对话框里可自定义密码，留空才自动生成。 */
  const [resetTarget, setResetTarget] = useState<SupplierAccountMemberView>()
  /** 一次性密码回显：只在这里出现一次，关闭即清空。 */
  const [issuedPassword, setIssuedPassword] = useState<{
    email: string
    password: string
  }>()

  const refresh = useCallback(async () => {
    try {
      const [accounts, catalog] = await Promise.all([
        listSupplierAccounts(),
        supplierDbsHttp.supplierDbsList().then(
          (data) => data.dbs as SupplierDb[],
          () => [] as SupplierDb[],
        ),
      ])
      setGroups(accounts.groups)
      setDbs(catalog)
    } catch (reason) {
      notifyCommandError(reason, "厂家账号列表读取失败，请稍后重试。")
      setGroups((current) => current ?? [])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const markPending = useCallback((memberId: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current)
      if (pending) next.add(memberId)
      else next.delete(memberId)
      return next
    })
  }, [])

  const toggleStatus = useCallback(
    async (member: SupplierAccountMemberView, active: boolean) => {
      markPending(member.member_id, true)
      try {
        await patchSupplierAccount(member.member_id, {
          status: active ? "active" : "disabled",
        })
        await refresh()
      } catch (reason) {
        notifyCommandError(reason, "厂家成员状态修改失败。")
      } finally {
        markPending(member.member_id, false)
      }
    },
    [markPending, refresh],
  )

  const resetPassword = useCallback(
    async (member: SupplierAccountMemberView, password: string) => {
      markPending(member.member_id, true)
      try {
        await patchSupplierAccount(member.member_id, { password })
        setIssuedPassword({ email: member.email, password })
        await refresh()
      } catch (reason) {
        notifyCommandError(reason, "密码重置失败。")
      } finally {
        markPending(member.member_id, false)
      }
    },
    [markPending, refresh],
  )

  const unbind = useCallback(async () => {
    if (!unboundId) return
    markPending(unboundId, true)
    try {
      await deleteSupplierAccount(unboundId)
      notifySuccess("已解绑厂家成员")
      setUnboundId(undefined)
      await refresh()
    } catch (reason) {
      notifyCommandError(reason, "解绑厂家成员失败。")
    } finally {
      markPending(unboundId, false)
    }
  }, [unboundId, markPending, refresh])

  if (groups === undefined) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        <Spinner className="size-5" aria-label="正在读取厂家账号" />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div
        className={
          embedded
            ? "flex flex-wrap items-center justify-end gap-3"
            : "flex flex-wrap items-center justify-between gap-3"
        }
      >
        {embedded ? null : (
          <div>
            <h1 className="text-md font-semibold tracking-tight">
              厂家账号
            </h1>
            <p className="text-compact text-muted-foreground">
              厂家成员共享该厂的排单队列；开通与重置密码需要超级管理员。
            </p>
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden />
          开通厂家成员
        </Button>
      </div>
      {groups.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <KeyRound />
          </EmptyMedia>
          <EmptyContent>还没有厂家成员。先开通一个，厂家才能登录排单面。</EmptyContent>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-col gap-4 overflow-auto">
          {groups.map((group) => (
            <section
              key={group.source.source_id}
              className="rounded-xl border border-border bg-card"
            >
              <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <span className="text-compact font-medium">
                  {group.source.name || group.source.source_id}
                </span>
                <Badge variant="outline">{group.members.length} 名成员</Badge>
              </header>
              <Table aria-label={`厂家 ${group.source.name} 的成员`}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>成员邮箱</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>开通时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.members.map((member) => (
                    <TableRow key={member.member_id}>
                      <TableCell className="font-mono text-compact">
                        {member.email}
                      </TableCell>
                      <TableCell className="text-compact">
                        {member.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Switch
                          size="sm"
                          checked={member.status === "active"}
                          disabled={pendingIds.has(member.member_id)}
                          aria-label={`${member.email}：启用`}
                          onCheckedChange={(checked) =>
                            void toggleStatus(member, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell className="text-meta whitespace-nowrap text-muted-foreground">
                        {formatDateTimeShort(member.created_at_ms)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {superAdmin ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={pendingIds.has(member.member_id)}
                              onClick={() => setResetTarget(member)}
                            >
                              <KeyRound data-icon="inline-start" />
                              重置密码
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="destructive"
                            size="icon-sm"
                            title="解绑"
                            aria-label={`解绑 ${member.email}`}
                            disabled={pendingIds.has(member.member_id)}
                            onClick={() => setUnboundId(member.member_id)}
                          >
                            <UserMinus aria-hidden />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ))}
        </div>
      )}
      <AdminSupplierWithdrawals />
      <CreateMemberDialog
        open={createOpen}
        superAdmin={superAdmin}
        dbs={dbs ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={(email, password) => {
          setCreateOpen(false)
          if (password) setIssuedPassword({ email, password })
          else notifySuccess("已绑定既有账号为厂家成员")
          void refresh()
        }}
      />
      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => setResetTarget(undefined)}
        onReset={resetPassword}
      />
      <ConfirmDialog
        open={unboundId !== undefined}
        title="解绑厂家成员"
        description="解绑后该账号立即失去排单面访问。绑定关系可随时重新开通。"
        confirmText="解绑"
        onConfirm={unbind}
        onOpenChange={(open) => {
          if (!open) setUnboundId(undefined)
        }}
      />
      <IssuedPasswordDialog
        issued={issuedPassword}
        onClose={() => setIssuedPassword(undefined)}
      />
    </div>
  )
}

function ResetPasswordDialog({
  target,
  onClose,
  onReset,
}: {
  target?: SupplierAccountMemberView
  onClose: () => void
  onReset: (member: SupplierAccountMemberView, password: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (target) setPassword("")
  }, [target])

  async function submit() {
    if (!target || busy) return
    setBusy(true)
    try {
      const next =
        password.trim() === "" ? `dzp-${crypto.randomUUID()}` : password
      await onReset(target, next)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={target !== undefined}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription className="break-words">
            为 {target ? target.email : ""} 设置新密码。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="supplier-reset-password">新密码</FieldLabel>
            <FieldDescription>自定义发给厂家的密码；留空将自动生成。</FieldDescription>
            <Input
              id="supplier-reset-password"
              type="text"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            重置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateMemberDialog({
  open,
  superAdmin,
  dbs,
  onClose,
  onCreated,
}: {
  open: boolean
  superAdmin: boolean
  dbs: SupplierDb[]
  onClose: () => void
  onCreated: (email: string, password?: string) => void
}) {
  const [sourceId, setSourceId] = useState("")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (sourceId === "" || email.trim() === "") {
      notifyError("请选择厂家并填写邮箱")
      return
    }
    setBusy(true)
    try {
      const created = await createSupplierAccount({
        sourceId,
        email: email.trim(),
        name: name.trim() === "" ? undefined : name.trim(),
        password: password === "" ? undefined : password,
      })
      onCreated(
        created.member.email,
        created.initial_password ?? undefined,
      )
      setSourceId("")
      setEmail("")
      setName("")
      setPassword("")
    } catch (reason) {
      notifyCommandError(reason, "开通厂家成员失败。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>开通厂家成员</DialogTitle>
          <DialogDescription className="break-words">
            已有账号直接绑定，新账号的初始密码仅显示一次。{superAdmin ? null : "开通需要超级管理员。"}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="supplier-member-source">厂家</FieldLabel>
            <Select
              value={sourceId}
              onValueChange={(next) => {
                if (typeof next === "string") setSourceId(next)
              }}
            >
              <SelectTrigger id="supplier-member-source" aria-label="厂家">
                <SelectValue>
                  {() =>
                    dbs.find((db) => db.sourceId === sourceId)?.name ?? "选择厂家…"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {dbs.map((db) => (
                  <SelectItem key={db.sourceId} value={db.sourceId}>
                    {db.name || db.sourceId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-member-email">邮箱</FieldLabel>
            <Input
              id="supplier-member-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-member-password">初始密码</FieldLabel>
            <FieldDescription>自定义发给厂家的密码；留空将自动生成。</FieldDescription>
            <Input
              id="supplier-member-password"
              type="text"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-member-name">名称（可选）</FieldLabel>
            <Input
              id="supplier-member-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            开通
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function IssuedPasswordDialog({
  issued,
  onClose,
}: {
  issued?: { email: string; password: string }
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setCopied(false)
  }, [issued])
  return (
    <Dialog
      open={issued !== undefined}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>一次性初始密码</DialogTitle>
          <DialogDescription className="break-words">
            只显示这一次——关闭后无法再看。请立即复制并安全转交给
            {issued ? ` ${issued.email}` : ""}。
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <p className="rounded-md border border-border px-3 py-3 font-mono break-all text-compact">
            {issued.password}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (issued) void navigator.clipboard.writeText(issued.password)
              setCopied(true)
            }}
          >
            {copied ? "已复制" : "复制密码"}
          </Button>
          <Button type="button" onClick={onClose}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
