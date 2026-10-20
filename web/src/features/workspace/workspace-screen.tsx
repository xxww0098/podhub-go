import { useEffect, useMemo, useRef, useState } from "react"
import { Copy, Eye, MailPlus, RefreshCw, Search, UserX, X } from "lucide-react"

import type { AccountOverview, CreateWorkspaceInvitationRequest, WorkspaceDirectoryView, WorkspaceInvitationView, WorkspaceMemberStatusView, WorkspaceMemberView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { IdentityMark } from "@/components/identity-mark"
import { PlanMark, formatRole } from "@/components/workspace-display"
import { WorkspaceMark } from "@/components/workspace-switcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { invalidateStoreRoster } from "@/features/stores/store-roster-cache"
import { invalidateWallet } from "@/features/usage/wallet-cache"
import { invalidateUsageStats } from "@/features/usage/usage-cache"
import { invalidateUsageSummary } from "@/features/usage/usage-summary-cache"
import { formatDateTimeShort } from "@/lib/format"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { WorkspaceInviteDialog } from "./workspace-invite-dialog"

export { invitationOutcome } from "./workspace-invite-dialog"

type MemberStatus = WorkspaceMemberStatusView
type MemberRole = "owner" | "manager" | "member"
type Member = Omit<WorkspaceMemberView, "role"> & { role: MemberRole }

/**
 * 两种停用不是同一件事：`manual_disabled` 是有人按的，`quota_suspended` 是席位
 * 不够被系统挤下去的——运营据此决定是恢复权限还是加购席位。
 */
const STATUS_LABEL: Record<MemberStatus, string> = {
  active: "已启用",
  manual_disabled: "已停用",
  quota_suspended: "已停用 · 超出成员名额",
}

/** 筛选按钮里 STATUS_LABEL 太长，只留能分辨的那一半。 */
const STATUS_TAB_LABEL: Record<MemberStatus, string> = {
  active: "已启用",
  manual_disabled: "已停用",
  quota_suspended: "超出成员名额",
}

const WORKSPACE_NAME_MAX = 64
const WORKSPACE_DIRECTORY_LIVE = "workspace-directory-load"
const TEXT_ACTION =
  "w-fit text-xs font-medium text-muted-foreground underline-offset-2 cursor-pointer hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground disabled:hover:no-underline"

async function copyText(text: string, label = "邮箱") {
  try {
    await navigator.clipboard.writeText(text)
    notifySuccess(`已复制${label}`, { description: text })
  } catch (reason) {
    notifyCommandError(reason, `无法复制${label}`)
  }
}

export function WorkspaceScreen({
  overview: overviewProp,
  onOverviewChange,
}: {
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  const overview = useAccountOverview() ?? overviewProp
  return (
    <WorkspacePanel
      key={`${overview?.active_workspace?.id ?? "none"}:${overview?.active_workspace?.role ?? "none"}:${overview?.session.email ?? ""}`}
      overview={overview}
      onOverviewChange={onOverviewChange}
    />
  )
}

function WorkspacePanel({ overview, onOverviewChange }: {
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  const activeWorkspace = overview?.active_workspace
  const entitlement = overview?.entitlement
  const limits = entitlement?.limits
  const plan = activeWorkspace?.plan ?? entitlement?.plan
  const workspaceName = activeWorkspace?.name ?? "当前 Workspace"
  const role = activeWorkspace?.role
  const [directory, setDirectory] = useState<WorkspaceDirectoryView>()
  const [loading, setLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState("")
  const mounted = useRef(false)
  const directoryRequest = useRef(0)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | MemberStatus>("all")
  const [inviteOpen, setInviteOpen] = useState(false)
  const [activeMember, setActiveMember] = useState<Member>()
  const [confirmRemove, setConfirmRemove] = useState<Member>()
  const [confirmRevoke, setConfirmRevoke] = useState<WorkspaceInvitationView>()
  const [removing, setRemoving] = useState<number>()
  const [changingRole, setChangingRole] = useState(false)
  const [revoking, setRevoking] = useState<string>()
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [nameBusy, setNameBusy] = useState(false)
  const seatsUsed = directory?.seats_used ?? limits?.seats_used ?? 0
  const seatsLimit = limits?.seats ?? 0
  const workspacePermissions = directory?.permissions
  const directoryReady = !!directory && !loading && !directoryError
  const inviteRoles = workspacePermissions?.invite_roles ?? []
  const canInvite = directoryReady && inviteRoles.length > 0
  const canRevokeInvitation = directoryReady && !!workspacePermissions?.revoke_invitation
  const canEditProfile = directoryReady && !!workspacePermissions?.edit_profile
  const canDissolve = directoryReady && !!workspacePermissions?.dissolve
  const canLeave = directoryReady && !!workspacePermissions?.leave
  const inviteRefusal = !directoryReady
    ? directoryError
      ? "无法读取成员目录，请重试后再邀请。"
      : "正在读取成员信息，请稍候。"
    : !limits || !directory
      ? "读取成员信息后可邀请。"
      : !canInvite
        ? "当前账号没有邀请成员权限。"
      : seatsUsed >= seatsLimit
        ? (seatsLimit <= 1 ? "当前工作空间仅限本人使用，加购成员名额后可邀请。" : "成员名额已满，移除成员或加购更多名额后可邀请。")
        : directory.pending_used >= directory.pending_limit
          ? "待接受的邀请已达上限，撤销旧邀请或等待对方处理后再邀请。"
          : undefined
  const nameTrimmed = nameDraft.trim()
  const nameValid =
    nameTrimmed.length > 0 && nameTrimmed.length <= WORKSPACE_NAME_MAX && nameTrimmed !== workspaceName

  async function reloadDirectory() {
    if (!mounted.current || !activeWorkspace) return
    const request = ++directoryRequest.current
    setLoading(true)
    setDirectoryError("")
    clearLive(WORKSPACE_DIRECTORY_LIVE)
    try {
      const next = await accountHttp.accountGetWorkspaceDirectory()
      if (mounted.current && request === directoryRequest.current) setDirectory(next)
    } catch (reason) {
      if (!mounted.current || request !== directoryRequest.current) return
      setDirectory(undefined)
      const message = errorMessage(reason, "无法读取成员目录，请重试。")
      setDirectoryError(message)
      notifyLive({
        id: WORKSPACE_DIRECTORY_LIVE,
        type: "error",
        reason,
        title: message,
        action: { label: "重试", onClick: () => void reloadDirectory() },
      })
    } finally {
      if (mounted.current && request === directoryRequest.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void reloadDirectory()
    return () => {
      mounted.current = false
      directoryRequest.current += 1
      clearLive(WORKSPACE_DIRECTORY_LIVE)
    }
    // The panel is remounted when the Workspace, account or role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const members = useMemo(
    () => (directory?.members ?? []).map(projectMember),
    [directory?.members]
  )
  const invitations = directory?.invitations ?? []
  const visibleMembers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return members.filter((member) => {
      const matchesQuery =
        !needle ||
        `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle)
      return matchesQuery && (statusFilter === "all" || member.status === statusFilter)
    })
  }, [members, query, statusFilter])

  function startRename() {
    setNameDraft(workspaceName)
    setRenaming(true)
  }

  /** 解散 and 离开 both end this session's access to the Workspace's stores. */
  function handleWorkspaceExit(next: AccountOverview) {
    if (!mounted.current) return
    invalidateStoreRoster()
    invalidateWallet()
    invalidateUsageStats()
    invalidateUsageSummary()
    onOverviewChange?.(next)
  }

  async function commitRename() {
    if (!canEditProfile || !nameValid || nameBusy) return
    setNameBusy(true)
    try {
      const next = await accountHttp.accountRenameWorkspace(nameTrimmed)
      if (!mounted.current) return
      onOverviewChange?.(next)
      setRenaming(false)
      notifySuccess("工作空间名称已更新")
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法修改工作空间名称，请稍后重试。")
    } finally {
      setNameBusy(false)
    }
  }

  async function replaceWorkspaceAvatar(image: Blob, signal?: AbortSignal) {
    if (!canEditProfile || avatarBusy || activeWorkspace?.id == null) return
    setAvatarBusy(true)
    try {
      const next = await accountHttp.accountSetAvatar({
        subject: { workspace: { workspace_id: activeWorkspace.id } },
        image, signal,
      })
      if (!mounted.current) return
      onOverviewChange?.(next)
      notifySuccess("工作空间头像已更新")
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法更新工作空间头像，请稍后重试。")
    } finally {
      setAvatarBusy(false)
    }
  }

  async function createInvitation(request: CreateWorkspaceInvitationRequest) {
    if (!mounted.current || inviteRefusal || loading) throw new Error(inviteRefusal ?? "正在刷新工作空间，请稍后重试。")
    const result = await accountHttp.accountCreateWorkspaceInvitation(request)
    await reloadDirectory()
    return result
  }

  async function revokeInvitation(invitation: WorkspaceInvitationView) {
    if (!canRevokeInvitation || revoking) return false
    setRevoking(invitation.uuid)
    try {
      await accountHttp.accountRevokeWorkspaceInvitation(invitation.uuid)
      if (!mounted.current) return false
      notifySuccess("邀请已撤销", {
        description: `${invitation.email} 的通知列表里不再有这条邀请。`,
      })
      await reloadDirectory()
      return true
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法撤销邀请，请稍后重试。")
      return false
    } finally {
      setRevoking(undefined)
    }
  }

  async function removeMember(member: Member) {
    if (removing != null || !directoryReady || member.permissions?.remove !== true) return false
    setRemoving(member.id)
    try {
      await accountHttp.accountRemoveWorkspaceMember(member.id)
      if (!mounted.current) return false
      setActiveMember(undefined)
      notifySuccess("成员已移除", {
        description: `${member.email} 已离开工作空间，其名下店铺仍归工作空间所有。`,
      })
      // The seat is back and a suspended member may have been restored.
      invalidateStoreRoster()
      await reloadDirectory()
      // Membership changed on Cloud; refresh workspaces rather than projecting the
      // cached session.
      try {
        const next = await accountHttp.accountListWorkspaces()
        if (mounted.current) onOverviewChange?.(next)
      } catch (reason) {
        if (mounted.current) notifyCommandError(reason, "成员已移除，但工作空间信息刷新失败，请刷新页面。")
      }
      return true
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法移除成员，请稍后重试。")
      return false
    } finally {
      setRemoving(undefined)
    }
  }

  /**
   * Owner-only roster edit (Cloud re-checks under the Workspace lock). The
   * directory's `changeRoles` is the gate: it is empty unless the session is
   * the Owner looking at a 主管/运营 row that is not her own.
   */
  async function changeMemberRole(member: Member, role: MemberRole) {
    if (changingRole || !directoryReady || !member.permissions?.change_roles?.includes(role)) {
      return false
    }
    setChangingRole(true)
    try {
      await accountHttp.accountChangeWorkspaceMemberRole(member.id, role)
      if (!mounted.current) return false
      setActiveMember(undefined)
      notifySuccess("成员角色已调整", {
        description: `${member.email} 现在是${formatRole(role)}，调整即时生效。`,
      })
      await reloadDirectory()
      return true
    } catch (reason) {
      if (mounted.current) notifyCommandError(reason, "无法调整成员角色，请稍后重试。")
      return false
    } finally {
      setChangingRole(false)
    }
  }

  if (!activeWorkspace) {
    return (
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5" aria-labelledby="workspace-unavailable-title">
        <h1 id="workspace-unavailable-title" className="text-lg font-semibold">{overview?.account_mode === "member" ? "工作空间访问受限" : "尚未选择工作空间"}</h1>
        <p className="text-sm text-muted-foreground">{overview?.account_mode === "member"
          ? "你的工作空间成员资格当前不可用，可能是被停用或超出成员名额。请联系工作空间所有者恢复访问；也可以离开工作空间，重新接受邀请。"
          : "请在侧栏选择或创建工作空间。"}</p>
        {overview?.account_mode === "member" ? (
          <SuspendedWorkspaceExits
            workspaces={overview?.unusable_workspaces ?? []}
            onLeft={handleWorkspaceExit}
          />
        ) : null}
      </section>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <h1 className="sr-only">工作空间</h1>
      <header className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <WorkspaceMark
            name={workspaceName}
            workspaceId={activeWorkspace?.id}
            workspaceIds={overview?.workspaces?.map((workspace) => workspace.id)}
            imageUrl={activeWorkspace?.avatar_url}
            editable={canEditProfile}
            disabled={avatarBusy}
            inputId="workspace-owner-avatar"
            className="size-10 shrink-0"
            onPick={(image, signal) => replaceWorkspaceAvatar(image, signal)}
          />
          {canEditProfile && renaming ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <NameField
                value={nameDraft}
                disabled={nameBusy}
                onChange={setNameDraft}
                onCommit={() => void commitRename()}
                onCancel={() => setRenaming(false)}
              />
              <Button
                size="sm"
                disabled={nameBusy || !nameValid}
                onClick={() => void commitRename()}
              >
                {nameBusy ? "保存中…" : "保存"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={nameBusy}
                onClick={() => setRenaming(false)}
              >
                取消
              </Button>
              <p id="workspace-name-hint" className="w-full text-xs text-muted-foreground">
                {!nameTrimmed ? "请输入工作空间名称。" : `最多 ${WORKSPACE_NAME_MAX} 个字符，当前 ${nameTrimmed.length} 个。`}
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {canEditProfile ? (
                <button
                  type="button"
                  className="max-w-full truncate text-md font-semibold text-foreground hover:underline hover:underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer"
                  title="修改工作空间名称"
                  onClick={startRename}
                >
                  {workspaceName}
                </button>
              ) : (
                <span className="max-w-full truncate text-md font-semibold text-foreground">
                  {workspaceName}
                </span>
              )}
              <PlanMark plan={plan} />
              {role ? (
                <Badge variant="outline">{formatRole(role)}</Badge>
              ) : null}
              {canDissolve || canLeave ? (
                <>
                  <span aria-hidden className="hidden h-3 w-px bg-border md:block" />
                  {canDissolve ? (
                    <DissolveWorkspaceAction workspaceName={workspaceName} onDissolved={handleWorkspaceExit} />
                  ) : (
                    <LeaveWorkspaceAction workspaceName={workspaceName} workspaceId={activeWorkspace?.id} onLeft={handleWorkspaceExit} />
                  )}
                </>
              ) : null}
            </div>
          )}
          {/* 席位是「邀请成员」的门槛，所以贴着按钮读。 */}
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
            {limits ? (
              <span className="font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                {`成员 ${seatsUsed} / ${limits.seats}`}
              </span>
            ) : null}
            {/* The refusal is the button's disabled reason (DESIGN §5), so it
                rides a Tooltip instead of a second paragraph under the header. */}
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button disabled={loading || !!inviteRefusal} aria-label={inviteRefusal ? `邀请成员：${inviteRefusal}` : undefined} onClick={() => setInviteOpen(true)}>
                  <MailPlus data-icon="inline-start" />邀请成员
                </Button>
              </TooltipTrigger>
              {inviteRefusal ? <TooltipContent>{inviteRefusal}</TooltipContent> : null}
            </Tooltip>
          </div>
        </div>
        <details className="text-sm">
          <summary className="w-fit cursor-pointer text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">角色与权限</summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <dt className="text-sm font-semibold text-foreground">所有者</dt>
              <dd className="mt-1.5 text-xs leading-relaxed text-muted-foreground">运营全部店铺；登记和更换密钥；决定指派人能否管理该店密钥；邀请与移除主管和运营；在主管和运营之间调整成员角色（成员详情内操作，即时生效）；修改工作空间资料、解散工作空间。</dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-sm font-semibold text-foreground">主管</dt>
              <dd className="mt-1.5 text-xs leading-relaxed text-muted-foreground">运营全部店铺、改派；改派会关掉该店「允许指派人管理密钥」。不能因角色管理密钥。</dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-sm font-semibold text-foreground">运营</dt>
              <dd className="mt-1.5 text-xs leading-relaxed text-muted-foreground">运营自己负责的店铺；不默认管理密钥；可查看成员、可自行退出。</dd>
            </div>
          </dl>
        </details>
      </header>

      {directoryError ? (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void reloadDirectory()}>重新加载</Button>
        </div>
      ) : (
      <section
        aria-label="成员与邀请"
        className="flex flex-col"
      >
        <div className="mb-3 flex items-center gap-3">
          <InputGroup className="min-w-0 flex-1 md:max-w-sm">
            <InputGroupAddon>
              <InputGroupText>
                <Search />
              </InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              className="placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名或邮箱"
              aria-label="搜索成员"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <button
                  type="button"
                  aria-label="清空搜索"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground inline-flex items-center"
                  onClick={() => setQuery("")}
                >
                  <X className="size-3.5" />
                </button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  className="md:ml-auto"
                  variant="outline"
                  size="icon-sm"
                  aria-label="刷新"
                  onClick={() => void reloadDirectory()}
                  disabled={loading}
                />
              }
            >
              {loading ? <Spinner aria-hidden /> : <RefreshCw aria-hidden />}
            </TooltipTrigger>
            <TooltipContent>刷新</TooltipContent>
          </Tooltip>
        </div>
        {statusFilter !== "all" || members.some((member) => member.status !== "active") ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-2" aria-label="按状态筛选">
            {(["all", "active", "manual_disabled", "quota_suspended"] as const).map(
              (status) => (
                <Button
                  key={status}
                  variant={statusFilter === status ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                >
                  {statusTabLabel(status, members)}
                </Button>
              )
            )}
          </div>
        ) : null}

        <MembersTable
          members={visibleMembers}
          loading={loading}
          onOpen={setActiveMember}
          onExit={directoryReady ? (member) => setConfirmRemove(member) : undefined}
          removing={removing}
        />

        <h2 className="mt-4 border-t border-border pt-4 text-sm font-semibold">
          {directory
            ? `待接受的邀请 · ${directory.pending_used} / ${directory.pending_limit}`
            : "待接受的邀请"}
        </h2>
        <InvitationsTable
          invitations={invitations}
          loading={loading}
          onRevoke={canRevokeInvitation ? (invitation) => setConfirmRevoke(invitation) : undefined}
          revoking={revoking}
        />
      </section>
      )}

      <WorkspaceInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={createInvitation}
        inviteRoles={inviteRoles}
      />
      <MemberSheet
        key={activeMember?.id}
        member={activeMember}
        onClose={() => setActiveMember(undefined)}
        onExit={directoryReady ? (member) => setConfirmRemove(member) : undefined}
        onChangeRole={directoryReady ? changeMemberRole : undefined}
        changingRole={changingRole}
      />
      <ConfirmDialog
        open={confirmRemove !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(undefined)
        }}
        title="移除工作空间成员？"
        description={
          confirmRemove &&
          `确定要将 ${confirmRemove.email} 移出工作空间吗？对方会立即失去本工作空间的访问权限（登录不受影响，将落回自己其余的工作空间），其名下店铺仍归工作空间所有，占用的成员名额随即释放。`
        }
        confirmText="移除成员"
        cancelText="取消"
        variant="destructive"
        icon={<UserX className="size-4" />}
        busy={confirmRemove ? removing === confirmRemove.id : false}
        onConfirm={async () => {
          if (!confirmRemove) return
          if (await removeMember(confirmRemove)) setConfirmRemove(undefined)
        }}
      />
      <ConfirmDialog
        open={confirmRevoke !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmRevoke(undefined)
        }}
        title="撤销工作空间邀请？"
        description={
          confirmRevoke &&
          `确定要撤销对 ${confirmRevoke.email} 的邀请吗？撤销后，该邀请将从对方的通知列表中移除。`
        }
        confirmText="撤销邀请"
        cancelText="取消"
        variant="destructive"
        icon={<UserX className="size-4" />}
        busy={confirmRevoke ? revoking === confirmRevoke.uuid : false}
        onConfirm={async () => {
          if (!confirmRevoke) return
          if (await revokeInvitation(confirmRevoke)) setConfirmRevoke(undefined)
        }}
      />
    </div>
  )
}

function NameField({
  value,
  disabled,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <Input
      value={value}
      maxLength={WORKSPACE_NAME_MAX}
      disabled={disabled}
      aria-label="工作空间名称"
      aria-describedby="workspace-name-hint"
      autoFocus
      className="w-full min-w-0 font-medium sm:w-64"
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault()
          onCommit()
        }
        if (event.key === "Escape" && !disabled) {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function projectMember(member: WorkspaceMemberView): Member {
  return { ...member, role: projectRole(member.role) }
}

function statusTabLabel(status: "all" | MemberStatus, members: Member[]) {
  if (status === "all") return `全部 ${members.length}`
  const count = members.filter((member) => member.status === status).length
  return `${STATUS_TAB_LABEL[status]} ${count}`
}

/**
 * Dissolve sits with the other owner-only identity actions, not in a separate
 * danger zone — the irreversible cost is named in the confirm dialog, where the
 * owner reads it at the moment it applies.
 */
export function DissolveWorkspaceAction({
  workspaceName,
  onDissolved,
}: {
  workspaceName: string
  onDissolved: (overview: AccountOverview) => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const typedTrimmed = typed.trim()
  const nameMatches = typedTrimmed === workspaceName

  async function confirmDissolve() {
    if (!nameMatches || busy) return
    setBusy(true)
    try {
      const next = await accountHttp.accountDissolveWorkspace(typedTrimmed)
      if (!mounted.current) return
      setOpen(false)
      setTyped("")
      notifySuccess("工作空间已解散")
      onDissolved(next)
    } catch (reason) {
      notifyCommandError(reason, "无法解散工作空间，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(TEXT_ACTION, "text-destructive hover:text-destructive")}
        disabled={busy}
        onClick={() => {
          setTyped("")
          setOpen(true)
        }}
      >
        解散工作空间
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          setOpen(next)
          if (!next) setTyped("")
        }}
        title={`解散「${workspaceName}」？`}
        description="解散后无法恢复。成员立即失去访问；店铺密钥会被清除；未用完的店铺位作废；创建者的钱包余额保留；待支付订单会取消。"
        confirmText="解散工作空间"
        cancelText="取消"
        variant="destructive"
        size="md"
        busy={busy}
        disabled={!nameMatches}
        onConfirm={() => void confirmDissolve()}
      >
        <Field>
          <FieldLabel htmlFor="dissolve-workspace-name">工作空间名称</FieldLabel>
          <Input
            id="dissolve-workspace-name"
            value={typed}
            maxLength={WORKSPACE_NAME_MAX}
            disabled={busy}
            autoComplete="off"
            placeholder={workspaceName}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void confirmDissolve()
              }
            }}
          />
          <FieldDescription>输入 {workspaceName} 以启用确认。</FieldDescription>
        </Field>
      </ConfirmDialog>
    </>
  )
}

/**
 * The leave exits of the degraded shell: one named action per unusable seat,
 * because a no-target leave would have to guess which Workspace to leave. An
 * empty list falls back to the no-target action — the single-seat case Cloud
 * still resolves, kept so a stale overview never strands the member.
 */
export function SuspendedWorkspaceExits({
  workspaces,
  onLeft,
}: {
  workspaces: Array<{ id: number; name: string }>
  onLeft: (overview: AccountOverview) => void
}) {
  if (workspaces.length === 0) {
    return <LeaveWorkspaceAction workspaceName="当前工作空间" onLeft={onLeft} />
  }
  return (
    <div className="flex flex-col gap-2">
      {workspaces.length > 1 ? (
        <p className="text-xs text-muted-foreground">你在多个工作空间的成员资格都不可用，请选择要离开哪一个。</p>
      ) : null}
      {workspaces.map((workspace) => (
        <LeaveWorkspaceAction
          key={workspace.id}
          workspaceName={workspace.name}
          workspaceId={workspace.id}
          onLeft={onLeft}
        />
      ))}
    </div>
  )
}

/**
 * Leaving asks once and takes no typed name: a fresh invitation undoes it,
 * which is exactly what 解散 can never offer. `workspaceId` names the
 * Workspace to leave; omitted means the Active Workspace (or, for a suspended
 * member, the single suspended seat Cloud resolves).
 */
export function LeaveWorkspaceAction({
  workspaceName,
  workspaceId,
  onLeft,
}: {
  workspaceName: string
  workspaceId?: number
  onLeft: (overview: AccountOverview) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function confirmLeave() {
    if (busy) return
    setBusy(true)
    try {
      const next = await accountHttp.accountLeaveWorkspace(workspaceId)
      if (!mounted.current) return
      setOpen(false)
      notifySuccess("已离开工作空间")
      onLeft(next)
    } catch (reason) {
      notifyCommandError(reason, "无法离开工作空间，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(TEXT_ACTION, "text-destructive hover:text-destructive")}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        离开工作空间
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          setOpen(next)
        }}
        title={`离开「${workspaceName}」？`}
        description="离开后立即失去该工作空间的店铺和数据访问权限；你经手的店铺仍归工作空间所有。你会切换到其他工作空间，重新加入需要工作空间再次邀请。"
        confirmText="离开工作空间"
        cancelText="取消"
        variant="destructive"
        busy={busy}
        onConfirm={() => void confirmLeave()}
      />
    </>
  )
}

/** 已入座的席位。还没入座的邀请是另一张表，两者状态集合不相交。 */
export function MembersTable({
  members,
  loading,
  onOpen,
  onExit,
  removing,
}: {
  members: Member[]
  loading: boolean
  onOpen: (member: Member) => void
  /** Omitted when the session's role may not manage the roster. */
  onExit?: (member: Member) => void
  removing?: number
}) {
  return (
    <Table className="min-w-3xl">
      <TableHeader>
        <TableRow>
          <TableHead className="text-muted-foreground">成员</TableHead>
          <TableHead className="text-muted-foreground">角色</TableHead>
          <TableHead className="text-muted-foreground">状态</TableHead>
          <TableHead className="text-muted-foreground">加入时间</TableHead>
          <TableHead className="w-32 text-right text-muted-foreground">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.length === 0 ? (
          <EmptyRow
            loading={loading}
            label={loading ? "正在读取成员目录…" : "没有符合当前条件的成员"}
            hint="试试清空搜索或切换状态。"
          />
        ) : (
          members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <button
                  type="button"
                  onClick={() => onOpen(member)}
                  className="group flex cursor-pointer items-center gap-3 text-left focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Avatar name={member.name} status={member.status} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium group-hover:underline group-hover:underline-offset-4">
                      {member.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{member.email}</span>
                  </span>
                </button>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground">{formatRole(member.role)}</span>
              </TableCell>
              <TableCell>
                {member.status === "active" ? (
                  <span className="text-xs text-muted-foreground">{STATUS_LABEL.active}</span>
                ) : (
                  <MemberStatusBadge status={member.status} />
                )}
              </TableCell>
              <TableCell>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTimeShort(member.joined_at_ms)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="inline-flex items-center justify-end gap-1.5">
                  <CopyEmailAction email={member.email} />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`查看 ${member.name} 的详情`}
                          onClick={() => onOpen(member)}
                        />
                      }
                    >
                      <Eye aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>查看详情</TooltipContent>
                  </Tooltip>
                  {onExit && member.permissions?.remove === true ? (
                    <RowAction
                      label={`将 ${member.email} 移出工作空间`}
                      tooltip="移除成员"
                      busy={removing === member.id}
                      onClick={() => onExit(member)}
                    />
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

/** 还没入座的邀请。撤销把它从对方的通知列表里拿掉，席位从未被占用。 */
export function InvitationsTable({
  invitations,
  loading,
  onRevoke,
  revoking,
}: {
  invitations: WorkspaceInvitationView[]
  loading: boolean
  /** Omitted when the session's role may not manage the roster. */
  onRevoke?: (invitation: WorkspaceInvitationView) => void
  revoking?: string
}) {
  return (
    <Table className="min-w-3xl">
      <TableHeader>
        <TableRow>
          <TableHead className="text-muted-foreground">邮箱</TableHead>
          <TableHead className="text-muted-foreground">角色</TableHead>
          <TableHead className="text-muted-foreground">邀请人</TableHead>
          <TableHead className="text-muted-foreground">有效期至</TableHead>
          <TableHead className="w-32 text-right text-muted-foreground">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.length === 0 ? (
          <EmptyRow
            compact
            loading={loading}
            label={loading ? "正在读取邀请…" : "没有等待接受的邀请"}
          />
        ) : (
          invitations.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell className="font-medium">{invitation.email}</TableCell>
              <TableCell>
                <span className="text-muted-foreground">{formatRole(projectRole(invitation.role))}</span>
              </TableCell>
              <TableCell>
                <span className="text-xs text-muted-foreground">
                  {invitation.invited_by_email}
                </span>
              </TableCell>
              <TableCell>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTimeShort(invitation.expires_at_ms)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="inline-flex items-center justify-end gap-1.5">
                  <CopyEmailAction email={invitation.email} />
                  {onRevoke ? (
                    <RowAction
                      label={`撤销 ${invitation.email} 的邀请`}
                      tooltip="撤销邀请"
                      busy={revoking === invitation.uuid}
                      onClick={() => onRevoke(invitation)}
                    />
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

function CopyEmailAction({ email }: { email: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`复制 ${email}`}
            onClick={() => void copyText(email)}
          />
        }
      >
        <Copy aria-hidden />
      </TooltipTrigger>
      <TooltipContent>复制邮箱</TooltipContent>
    </Tooltip>
  )
}

/** 释放一个席位的那一下：成员是移除，邀请是撤销。 */
function RowAction({
  label,
  tooltip,
  busy,
  onClick,
}: {
  label: string
  tooltip: string
  busy: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={onClick}
          />
        }
      >
        {busy ? <Spinner aria-hidden /> : <UserX aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function EmptyRow({
  label,
  loading = false,
  hint,
  compact = false,
}: {
  label: string
  loading?: boolean
  hint?: string
  compact?: boolean
}) {
  return (
    <TableRow>
      <TableCell colSpan={5}>
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 text-center",
            compact ? "min-h-16" : "min-h-36",
          )}
        >
          {compact ? null : <Search className="size-5 text-muted-foreground" />}
          <p className="text-sm font-medium">{label}</p>
          {loading || !hint ? null : (
            <p className="text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function Avatar({ name, status }: { name: string; status: MemberStatus }) {
  return (
    <div className="relative">
      <IdentityMark
        kind="user"
        name={name}
        className={cn("size-8", status === "manual_disabled" && "opacity-60 grayscale")}
      />
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-card",
          status === "active" && "bg-st-good",
          status === "quota_suspended" && "bg-st-attest",
          status === "manual_disabled" && "bg-st-idle"
        )}
      />
    </div>
  )
}

function MemberStatusBadge({ status }: { status: MemberStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "active" && "border-st-good/25 text-st-good-ink",
        status === "quota_suspended" &&
          "border-st-attest/25 text-st-attest-ink",
        status === "manual_disabled" && "text-muted-foreground"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "active" && "bg-st-good",
          status === "quota_suspended" && "bg-st-attest",
          status === "manual_disabled" && "bg-st-idle"
        )}
      />
      {STATUS_LABEL[status]}
    </Badge>
  )
}

function MemberSheet({
  member,
  onClose,
  onExit,
  onChangeRole,
  changingRole = false,
}: {
  member?: Member
  onClose: () => void
  onExit?: (member: Member) => void
  /** Present when the session may manage the roster; the per-row `changeRoles`
   * gate decides whether the adjuster renders at all. */
  onChangeRole?: (member: Member, role: MemberRole) => Promise<boolean>
  changingRole?: boolean
}) {
  if (!member) return null
  const removable = onExit !== undefined && member.permissions?.remove === true
  return (
    <MemberRoleSheet
      member={member}
      removable={removable}
      onExit={onExit}
      onChangeRole={onChangeRole}
      changingRole={changingRole}
      onClose={onClose}
    />
  )
}

/**
 * The Owner's role switcher for one member row. The per-row `changeRoles`
 * grant sizes it: empty (or a session that may not manage the roster) renders
 * nothing, one assignable role renders it with the current role plus that one
 * option and a save button that appears only once the draft differs.
 */
export function MemberRoleAdjuster({
  member,
  onChangeRole,
  disabled = false,
}: {
  member: Member
  /** Present when the session may manage the roster; Cloud re-checks under the
   * Workspace lock. */
  onChangeRole?: (member: Member, role: MemberRole) => Promise<boolean>
  disabled?: boolean
}) {
  const adjustable = (onChangeRole !== undefined
    ? (member.permissions?.change_roles ?? [])
    : []
  ).filter((role): role is MemberRole => role === "manager" || role === "member")
  const options: MemberRole[] = adjustable.length > 0 ? [member.role, ...adjustable] : []
  const [draft, setDraft] = useState<MemberRole>(member.role)
  if (options.length === 0) return null
  const dirty = draft !== member.role
  return (
    <fieldset disabled={disabled} className="mt-4 flex flex-col gap-3 border-t border-border py-3">
      <legend className="text-sm font-medium">调整角色</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">
        仅所有者可调整；调整立即生效，对方无需重新登录。
      </p>
      <div className="flex flex-col gap-2">
        {options.map((role) => (
          <label
            key={role}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm has-[:checked]:border-brand/40 has-[:checked]:bg-brand-soft/45 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/25"
          >
            <input
              type="radio"
              name="member-role"
              value={role}
              checked={draft === role}
              onChange={() => setDraft(role)}
              className="mt-0.5 accent-brand"
            />
            <span>
              <span className="block">{formatRole(role)}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {role === "manager"
                  ? "运营全部店铺、调整指派。管理密钥须被指派到该店，且由所有者授权。"
                  : "只运营被指派的店铺。密钥默认由所有者登记。"}
              </span>
            </span>
          </label>
        ))}
      </div>
      {dirty && onChangeRole ? (
        <Button
          type="button"
          size="sm"
          className="w-fit"
          aria-label={`将 ${member.email} 的角色调整为${formatRole(draft)}`}
          disabled={disabled}
          onClick={() => void onChangeRole(member, draft)}
        >
          {disabled ? <Spinner data-icon="inline-start" /> : null}
          保存角色
        </Button>
      ) : null}
    </fieldset>
  )
}

/**
 * The sheet body, split so the role draft can mount fresh per member: the
 * parent keys this component by membership id and `useState` seeds from the
 * row that opened it.
 */
function MemberRoleSheet({
  member,
  removable,
  onExit,
  onChangeRole,
  changingRole,
  onClose,
}: {
  member: Member
  removable: boolean
  onExit?: (member: Member) => void
  onChangeRole?: (member: Member, role: MemberRole) => Promise<boolean>
  changingRole: boolean
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-5/6 flex-col sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar name={member.name} status={member.status} />
            <div className="min-w-0">
              <DialogTitle className="truncate text-base font-semibold">{member.name}</DialogTitle>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate">{member.email}</span>
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground inline-flex items-center"
                  title="复制邮箱"
                  aria-label={`复制 ${member.email}`}
                  onClick={() => void copyText(member.email)}
                >
                  <Copy className="size-3" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col">
            <DetailRow label="状态">
              {member.status === "active" ? (
                <span className="text-sm text-muted-foreground">{STATUS_LABEL.active}</span>
              ) : (
                <MemberStatusBadge status={member.status} />
              )}
            </DetailRow>
            <DetailRow label="角色">
              <span className="text-sm">{formatRole(member.role)}</span>
            </DetailRow>
            <DetailRow label="加入时间">
              <span className="font-mono text-xs text-muted-foreground">{formatDateTimeShort(member.joined_at_ms)}</span>
            </DetailRow>
          </div>
          <MemberRoleAdjuster member={member} onChangeRole={onChangeRole} disabled={changingRole} />
        </div>
        <DialogFooter className="sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyText(member.email)}
            >
              <Copy data-icon="inline-start" />
              复制邮箱
            </Button>
            {removable ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                aria-label={`将 ${member.email} 移出工作空间`}
                onClick={() => {
                  onClose()
                  onExit?.(member)
                }}
              >
                <UserX data-icon="inline-start" />
                移除成员
              </Button>
            ) : null}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function projectRole(role: string): MemberRole {
  return role === "owner" || role === "manager" ? role : "member"
}
