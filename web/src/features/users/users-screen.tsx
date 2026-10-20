import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Building2,
  Check,
  Copy,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  Lock,
  Pencil,
  Search,
  ShieldCheck,
  Store,
  Trash2,
  User,
  UserPlus,
  Users,
  X,
} from "lucide-react"

import type {
  AdminDirectoryPersonView,
  AdminDirectoryWorkspaceView,
  AdminUsersOverview,
} from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { IdentityMark } from "@/components/identity-mark"
import { PlatformAdminEmpty, PlatformAdminFact, PlatformAdminFilter, PlatformAdminRefresh, PlatformAdminSearch, PlatformAdminSummary, PlatformAdminSurface, PlatformAdminTab } from "@/components/platform-admin-surface"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { formatCompactQuota } from "@/components/workspace-quota-facts"
import { formatRole, PlanMark } from "@/components/workspace-display"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  asAccountStatus,
  filterDirectoryMembers,
  flattenDirectoryMembers,
  type AccountStatus,
  type DirectoryFilter,
  type DirectoryMemberRow,
} from "@/features/users/directory-members"
import { formatDateTimeShort } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { platformRoleLabel } from "@/lib/platform-role"

/** Roles the UI may assign — never `super_admin`; that rank is created once
 * by the server-side `admin init` and stored in the system. */
type AssignableRole = "admin" | "user"

function assignableRoles(actorRole: string | null | undefined): AssignableRole[] {
  if (actorRole === "super_admin") return ["admin", "user"]
  return ["user"]
}

const STATUS_LABEL: Record<AccountStatus, string> = {
  active: "已启用",
  disabled: "已停用",
}

function asStatus(person: Pick<AdminDirectoryPersonView, "disabled" | "status">): AccountStatus {
  return asAccountStatus(person)
}

function membershipLabel(role?: string | null) {
  if (role === "owner" || role === "manager" || role === "member") {
    return formatRole(role)
  }
  return undefined
}

function PasswordVisibilityField({
  id,
  name,
  value,
  onChange,
  visible,
  onToggle,
  placeholder,
  required,
  minLength,
  invalid,
  className,
}: {
  id: string
  name?: string
  value: string
  onChange: (value: string) => void
  visible: boolean
  onToggle: () => void
  placeholder?: string
  required?: boolean
  minLength?: number
  invalid?: boolean
  className?: string
}) {
  return (
    <InputGroup className={className}>
      <InputGroupInput
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        required={required}
        minLength={minLength}
        aria-invalid={invalid}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="placeholder:text-muted-foreground"
      />
      <InputGroupAddon align="inline-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <InputGroupButton
                size="icon-xs"
                aria-label={visible ? "隐藏密码" : "显示密码"}
                aria-pressed={visible}
                onClick={onToggle}
              />
            }
          >
            {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </TooltipTrigger>
          <TooltipContent>{visible ? "隐藏密码" : "显示密码"}</TooltipContent>
        </Tooltip>
      </InputGroupAddon>
    </InputGroup>
  )
}

type ViewMode = "members" | "workspaces"

/**
 * Platform SuperAdmin directory: account authorization and read-only
 * workspace standing. Plan seats and wallet grants move through 兑换码 —
 * this panel only assigns platform roles (admin/user) and login status.
 * Cloud: GET /api/admin/users returns workspaces + unaffiliated Users.
 */
export function UsersScreen({
  actorRole,
  onSessionMayChange,
}: {
  actorRole?: string | null
  /** Refresh AppShell after mutations that change the signed-in session, Active Workspace plan, or standing. */
  onSessionMayChange?: () => void | Promise<void>
} = {}) {
  const [viewMode, setViewMode] = useState<ViewMode>("members")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<DirectoryFilter>("all")
  const [workspaceFilter, setWorkspaceFilter] = useState("all")
  const [directory, setDirectory] = useState<AdminUsersOverview>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AdminDirectoryPersonView>()
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<AdminDirectoryWorkspaceView>()
  const [resetting, setResetting] = useState<AdminDirectoryPersonView>()
  const [pendingDisable, setPendingDisable] = useState<AdminDirectoryPersonView>()
  const [selectedUuids, setSelectedUuids] = useState<ReadonlySet<string>>(new Set())
  const [bulkDisableOpen, setBulkDisableOpen] = useState(false)

  const directoryRequest = useRef(0)
  const reload = useCallback(async (soft = false) => {
    const request = ++directoryRequest.current
    if (!soft) setLoading(true)
    try {
      const next = await adminHttp.adminListUsers()
      if (request === directoryRequest.current) setDirectory(next)
    } catch (reason) {
      if (request === directoryRequest.current) notifyCommandError(reason, "无法加载平台账户，请稍后重试。")
    } finally {
      if (request === directoryRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const workspaces = directory?.workspaces ?? []
  const unaffiliated = directory?.unaffiliated ?? []
  const memberRows = useMemo(() => flattenDirectoryMembers(directory), [directory])
  const uniquePeople = useMemo(() => {
    const byUuid = new Map<string, AdminDirectoryPersonView>()
    for (const row of memberRows) byUuid.set(row.person.uuid, row.person)
    return Array.from(byUuid.values())
  }, [memberRows])

  const visibleMembers = useMemo(() => {
    return filterDirectoryMembers(memberRows, query, statusFilter).filter((row) => {
      if (workspaceFilter === "all") return true
      if (workspaceFilter === "unaffiliated") return row.workspace == null
      return row.workspace?.uuid === workspaceFilter
    })
  }, [memberRows, query, statusFilter, workspaceFilter])

  const visibleMemberIds = visibleMembers.map((row) => row.person.uuid)
  // 选集按账户 UUID 去重：同一个人出现在多个工作空间时，两行同勾。
  const selectedPeople = useMemo(() => {
    const byUuid = new Map<string, AdminDirectoryPersonView>()
    for (const row of memberRows) {
      if (selectedUuids.has(row.person.uuid)) byUuid.set(row.person.uuid, row.person)
    }
    return Array.from(byUuid.values())
  }, [memberRows, selectedUuids])
  const disableSelectedPeople = selectedPeople.filter(
    (person) => person.manageable && asStatus(person) === "active",
  )
  const allVisibleSelected =
    visibleMemberIds.length > 0 && visibleMemberIds.every((uuid) => selectedUuids.has(uuid))
  const someVisibleSelected = visibleMemberIds.some((uuid) => selectedUuids.has(uuid))

  function toggleSelectAll(checked: boolean) {
    setSelectedUuids((current) => {
      const next = new Set(current)
      for (const uuid of visibleMemberIds) {
        if (checked) next.add(uuid)
        else next.delete(uuid)
      }
      return next
    })
  }

  function toggleSelectRow(uuid: string, checked: boolean) {
    setSelectedUuids((current) => {
      const next = new Set(current)
      if (checked) next.add(uuid)
      else next.delete(uuid)
      return next
    })
  }

  // 没有批量端点：确认一次后逐个停用；失败的那些留在列表里，下次可重试。
  async function disableSelected() {
    if (disableSelectedPeople.length === 0) return
    setBusy(true)
    const failed: AdminDirectoryPersonView[] = []
    for (const person of disableSelectedPeople) {
      try {
        await adminHttp.adminDisableUser({ uuid: person.uuid })
      } catch {
        failed.push(person)
      }
    }
    setBusy(false)
    setBulkDisableOpen(false)
    const disabled = disableSelectedPeople.length - failed.length
    if (disabled > 0) {
      setSelectedUuids(new Set())
      notifySuccess(`已停用 ${disabled} 个账户`)
      await reload(true)
    }
    if (failed.length > 0) {
      notifyCommandError(undefined, `有 ${failed.length} 个账户停用失败，请刷新后重试。`)
    }
  }

  const activeCount = uniquePeople.filter((person) => asStatus(person) === "active").length
  const disabledCount = uniquePeople.filter((person) => asStatus(person) === "disabled").length
  const privilegedCount = uniquePeople.filter(
    (person) => person.is_admin || person.role === "admin" || person.role === "super_admin",
  ).length

  // Global KPI metrics
  const totalSeatsUsed = useMemo(() => workspaces.reduce((acc, workspace) => acc + workspace.seats_used, 0), [workspaces])
  const totalSeatLimit = useMemo(() => workspaces.reduce((acc, workspace) => acc + workspace.seat_limit, 0), [workspaces])
  const totalWalletAvailable = useMemo(
    () => workspaces.reduce((acc, workspace) => acc + workspace.wallet_available_microfen, 0),
    [workspaces],
  )
  const totalWalletHeld = useMemo(
    () => workspaces.reduce((acc, workspace) => acc + workspace.wallet_held_microfen, 0),
    [workspaces],
  )

  const focusedWorkspace =
    workspaceFilter !== "all" && workspaceFilter !== "unaffiliated"
      ? workspaces.find((workspace) => workspace.uuid === workspaceFilter)
      : undefined

  // Filtered workspaces for the Workspaces & Quotas tab
  const visibleWorkspaces = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return workspaces
    return workspaces.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(q) ||
        workspace.uuid.toLowerCase().includes(q) ||
        workspace.plan.toLowerCase().includes(q) ||
        workspace.members.some(
          (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
        ),
    )
  }, [workspaces, query])

  async function createUser(input: {
    email: string
    password: string
    role: AssignableRole
  }) {
    setBusy(true)
    try {
      await adminHttp.adminCreateUser({
        email: input.email,
        password: input.password,
        role: input.role,
      })
      notifySuccess("已创建账户", { description: input.email })
      setCreateOpen(false)
      await reload(true)
      await onSessionMayChange?.()
    } catch (reason) {
      notifyCommandError(reason, "无法创建账户，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function saveUser(next: {
    uuid: string
    role: AssignableRole | "super_admin"
    enabled: boolean
  }) {
    setBusy(true)
    try {
      // adminUpdateUser only touches role/status here; plan seats and wallet
      // grants move through 兑换码， never this form.
      await adminHttp.adminUpdateUser({
        uuid: next.uuid,
        role: next.role,
        enabled: next.enabled,
      })
      notifySuccess("账户已更新")
      setEditing(undefined)
      await reload(true)
      await onSessionMayChange?.()
    } catch (reason) {
      notifyCommandError(reason, "无法保存账户，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(uuid: string, password: string) {
    setBusy(true)
    try {
      await adminHttp.adminResetPassword({ uuid, password })
      notifySuccess("密码已重置")
      setResetting(undefined)
    } catch (reason) {
      notifyCommandError(reason, "无法重置密码，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function disableUser(uuid: string) {
    setBusy(true)
    try {
      await adminHttp.adminDisableUser({ uuid })
      notifySuccess("账户已停用")
      setPendingDisable(undefined)
      await reload(true)
    } catch (reason) {
      notifyCommandError(reason, "无法停用账户，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function deleteWorkspace(workspace: AdminDirectoryWorkspaceView) {
    setBusy(true)
    try {
      await adminHttp.adminDissolveWorkspace({ workspace_uuid: workspace.uuid, name: workspace.name })
      notifySuccess("工作空间已删除", { description: workspace.name })
      setPendingDeleteWorkspace(undefined)
      await reload(true)
      await onSessionMayChange?.()
    } catch (reason) {
      notifyCommandError(reason, "无法删除工作空间，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
      <h1 className="sr-only">用户</h1>

      {/* Platform totals as one fact strip — the tabs and status filter below
          already count members. A focused workspace's banner replaces it. */}
      {focusedWorkspace ? null : (
      <PlatformAdminSummary>
        <PlatformAdminFact
          label="工作空间"
          value={directory?.workspace_count ?? workspaces.length}
          mono
        />
        <PlatformAdminFact label="席位" value={`${totalSeatsUsed} / ${totalSeatLimit}`} mono />
        <PlatformAdminFact label="钱包可用" value={formatYuan(totalWalletAvailable)} mono />
        {totalWalletHeld > 0 ? (
          <PlatformAdminFact label="预留" value={formatYuan(totalWalletHeld)} mono />
        ) : null}
      </PlatformAdminSummary>
      )}

      {/* Focused Workspace Banner */}
      {focusedWorkspace ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-compact">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <Building2 className="size-3.5 text-brand-ink" />
              <span>{focusedWorkspace.name}</span>
            </div>
            <span className="font-mono text-2xs text-muted-foreground">#{focusedWorkspace.id}</span>
            <PlanMark plan={focusedWorkspace.plan} />
            <span className="text-border">|</span>
            <PlatformAdminSummary className="gap-x-3 text-xs">
              <span>
                成员 {focusedWorkspace.seats_used}/{focusedWorkspace.seat_limit}
              </span>
              <span>
                店铺 {focusedWorkspace.plan === "lite" ? 1 : focusedWorkspace.seat_limit * 5}
              </span>
              <span>余额 {formatYuan(focusedWorkspace.wallet_available_microfen)}</span>
              {focusedWorkspace.wallet_held_microfen > 0 ? (
                <span>预留 {formatYuan(focusedWorkspace.wallet_held_microfen)}</span>
              ) : null}
              <span>Token {formatCompactQuota(focusedWorkspace.ai_tokens_used)}</span>
            </PlatformAdminSummary>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="cursor-pointer text-destructive hover:bg-destructive/10 text-xs"
              disabled={busy}
              aria-label={`删除工作空间 ${focusedWorkspace.name}`}
              onClick={() => setPendingDeleteWorkspace(focusedWorkspace)}
            >
              <Trash2 className="size-3" />
              删除工作空间
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="cursor-pointer text-muted-foreground hover:text-foreground text-xs"
              onClick={() => setWorkspaceFilter("all")}
            >
              清除聚焦
            </Button>
          </div>
        </div>
      ) : null}

      {/* Main Admin Surface */}
      <PlatformAdminSurface
        bodyClassName={
          viewMode === "members" ? "flex flex-col overflow-hidden" : "overflow-y-auto"
        }
        toolbar={
          <div className="flex w-full flex-col gap-3">
            {/* Upper row: View Switcher Tabs & Primary Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center" role="tablist" aria-label="视图模式">
                <PlatformAdminTab
                  active={viewMode === "members"}
                  onClick={() => setViewMode("members")}
                >
                  <Users className="size-3.5" aria-hidden />
                  账号与成员
                  <span className="font-mono text-meta tabular-nums opacity-70">
                    {uniquePeople.length}
                  </span>
                </PlatformAdminTab>
                <PlatformAdminTab
                  active={viewMode === "workspaces"}
                  onClick={() => setViewMode("workspaces")}
                >
                  <Layers className="size-3.5" aria-hidden />
                  工作空间与权益
                  <span className="font-mono text-meta tabular-nums opacity-70">
                    {workspaces.length}
                  </span>
                </PlatformAdminTab>
              </div>

              <div className="flex items-center gap-2">
                <PlatformAdminRefresh busy={busy} onClick={() => void reload(true)} />
                <Button
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setCreateOpen(true)}
                  disabled={busy}
                >
                  <UserPlus className="size-3.5" data-icon="inline-start" />
                  创建账户
                </Button>
              </div>
            </div>

            {/* Lower row: Filters & Search */}
            {viewMode === "members" ? (
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-0.5">
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <PlatformAdminSearch
                    value={query}
                    onChange={setQuery}
                    label="搜索工作空间或账户"
                    placeholder="搜索姓名、邮箱、工作空间或 UUID…"
                    className="w-full sm:w-64"
                  />

                  <Select value={workspaceFilter} onValueChange={(value) => setWorkspaceFilter(value ?? "all")}>
                    <SelectTrigger size="sm" className="w-full min-w-0 cursor-pointer sm:w-auto sm:min-w-36" aria-label="按工作空间筛选">
                      <SelectValue>
                        {() =>
                          workspaceFilter === "unaffiliated"
                            ? "未加入工作空间"
                            : workspaces.find((workspace) => workspace.uuid === workspaceFilter)?.name ?? "全部工作空间"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部工作空间 ({workspaces.length})</SelectItem>
                      <SelectItem value="unaffiliated">未加入工作空间 ({unaffiliated.length})</SelectItem>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.uuid} value={workspace.uuid}>
                          {workspace.name} ({workspace.members.length}人)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <PlatformAdminFilter
                  label="按状态筛选"
                  value={statusFilter}
                  options={
                    [
                      { id: "all", label: "全部", count: uniquePeople.length },
                      { id: "active", label: "已启用", count: activeCount },
                      { id: "disabled", label: "已停用", count: disabledCount },
                      { id: "privileged", label: "特权", count: privilegedCount },
                      { id: "unaffiliated", label: "未加入", count: unaffiliated.length },
                    ] as const
                  }
                  onValueChange={setStatusFilter}
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-0.5">
                <PlatformAdminSearch
                  value={query}
                  onChange={setQuery}
                  label="搜索工作空间"
                  placeholder="搜索工作空间名称、所有者或档位…"
                  className="w-full sm:w-80"
                />
                <div className="text-xs text-muted-foreground">
                  已显示 <span className="font-mono font-medium text-foreground">{visibleWorkspaces.length}</span> / {workspaces.length} 个工作空间
                </div>
              </div>
            )}
          </div>
        }
      >
        {loading ? (
          <PlatformAdminEmpty
            icon={Users}
            busy
            title="正在加载账户与工作空间数据…"
          />
        ) : viewMode === "members" ? (
          /* Members View */
          uniquePeople.length === 0 ? (
            <PlatformAdminEmpty
              icon={Users}
              title="暂无平台账户"
              description="平台当前尚未创建成员账户。点击下方按钮创建第一个账户。"
              action={
                <Button size="sm" onClick={() => setCreateOpen(true)} className="cursor-pointer">
                  <UserPlus className="size-3.5" data-icon="inline-start" />
                  创建第一个账户
                </Button>
              }
            />
          ) : visibleMembers.length === 0 ? (
            <PlatformAdminEmpty
              icon={Search}
              title="没有符合当前条件的成员"
              description="试试清空搜索或切换筛选条件。"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => {
                    setQuery("")
                    setStatusFilter("all")
                    setWorkspaceFilter("all")
                  }}
                >
                  清空筛选条件
                </Button>
              }
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
              {selectedPeople.length > 0 ? (
                <div
                  role="toolbar"
                  aria-label="批量操作"
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-muted/30 px-3 py-2"
                >
                  <span className="text-compact font-medium text-foreground tabular-nums">
                    已选 {selectedPeople.length} 个账户
                    {disableSelectedPeople.length < selectedPeople.length ? (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        其中 {disableSelectedPeople.length} 个可停用
                      </span>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="cursor-pointer"
                      onClick={() => setSelectedUuids(new Set())}
                    >
                      <X className="size-3.5" aria-hidden />
                      清除选择
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="cursor-pointer"
                      disabled={busy || disableSelectedPeople.length === 0}
                      onClick={() => setBulkDisableOpen(true)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      停用 {disableSelectedPeople.length} 个
                    </Button>
                  </div>
                </div>
              ) : null}
              <Table containerClassName="min-h-0 flex-1 overflow-auto">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent border-b border-border/80 text-xs font-semibold text-muted-foreground">
                    <TableHead className="w-10 pr-0">
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={!allVisibleSelected && someVisibleSelected}
                        aria-label="选择当前筛选的全部账户"
                        onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      />
                    </TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>工作空间</TableHead>
                    <TableHead>角色</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最近登录时间</TableHead>
                    <TableHead className="w-36 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMembers.map((row) => (
                    <MemberRow
                      key={`${row.workspace?.uuid ?? "none"}-${row.person.uuid}`}
                      row={row}
                      busy={busy}
                      selected={selectedUuids.has(row.person.uuid)}
                      onEdit={setEditing}
                      onDisable={setPendingDisable}
                      onResetPassword={setResetting}
                      onSelectedChange={(selected) =>
                        toggleSelectRow(row.person.uuid, selected)
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        ) : (
          /* Workspaces & Quotas View */
          workspaces.length === 0 ? (
            <PlatformAdminEmpty
              icon={Building2}
              title="暂无工作空间"
              description="尚未创建任何团队工作空间。"
            />
          ) : visibleWorkspaces.length === 0 ? (
            <PlatformAdminEmpty
              icon={Building2}
              title="未找到匹配的工作空间"
              description="尝试更换搜索关键词。"
              action={
                query ? (
                  <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => setQuery("")}>
                    清空搜索
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent border-b border-border/80">
                    <TableHead className="text-xs font-semibold text-muted-foreground">工作空间名称</TableHead>
                    <TableHead className="text-xs font-semibold text-muted-foreground">档位配置</TableHead>
                    <TableHead className="text-xs font-semibold text-muted-foreground">成员配置</TableHead>
                    <TableHead className="text-xs font-semibold text-muted-foreground">店铺配置</TableHead>
                    <TableHead className="text-xs font-semibold text-muted-foreground">钱包余额</TableHead>
                    <TableHead className="text-xs font-semibold text-muted-foreground">月度 Token</TableHead>
                    <TableHead className="w-44 text-right text-xs font-semibold text-muted-foreground">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleWorkspaces.map((workspace) => (
                    <WorkspaceQuotaRow
                      key={workspace.uuid}
                      workspace={workspace}
                      busy={busy}
                      onDeleteWorkspace={setPendingDeleteWorkspace}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}
      </PlatformAdminSurface>

      {/* Dialogs */}
      <CreateDialog
        open={createOpen}
        busy={busy}
        actorRole={actorRole}
        onOpenChange={setCreateOpen}
        onCreate={createUser}
      />
      <EditUserDialog
        user={editing}
        busy={busy}
        actorRole={actorRole}
        onClose={() => setEditing(undefined)}
        onSave={saveUser}
        onResetPassword={(user) => {
          setEditing(undefined)
          setResetting(user)
        }}
        userWorkspace={
          editing
            ? memberRows.find((r) => r.person.uuid === editing.uuid)?.workspace ?? undefined
            : undefined
        }
      />
      <ResetPasswordDialog
        user={resetting}
        busy={busy}
        onClose={() => setResetting(undefined)}
        onConfirm={resetPassword}
      />
      <DisableUserDialog
        user={pendingDisable}
        busy={busy}
        onClose={() => setPendingDisable(undefined)}
        onConfirm={() => {
          if (pendingDisable) void disableUser(pendingDisable.uuid)
        }}
      />
      <ConfirmDialog
        open={bulkDisableOpen}
        onOpenChange={setBulkDisableOpen}
        title={`停用 ${disableSelectedPeople.length} 个账户？`}
        description="对方将无法登录；可在编辑中逐个重新启用。"
        confirmText={`停用 ${disableSelectedPeople.length} 个`}
        variant="destructive"
        icon={<Trash2 data-icon="inline-start" />}
        busy={busy}
        footerLayout="end"
        onConfirm={() => void disableSelected()}
        onCancel={() => setBulkDisableOpen(false)}
      />
      <DeleteWorkspaceDialog
        workspace={pendingDeleteWorkspace}
        busy={busy}
        onClose={() => setPendingDeleteWorkspace(undefined)}
        onConfirm={(workspace) => void deleteWorkspace(workspace)}
      />
    </div>
  )
}

function DeleteWorkspaceDialog({
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  workspace?: AdminDirectoryWorkspaceView
  busy: boolean
  onClose: () => void
  onConfirm: (workspace: AdminDirectoryWorkspaceView) => void
}) {
  const [typed, setTyped] = useState("")

  useEffect(() => {
    setTyped("")
  }, [workspace])

  const matches = Boolean(workspace) && typed.trim() === workspace?.name

  return (
    <ConfirmDialog
      open={Boolean(workspace)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={workspace ? `删除「${workspace.name}」？` : "删除工作空间？"}
      description="删除后无法恢复。成员立即失去访问；店铺密钥会被清除；未用完的店铺位作废；创建者的钱包余额保留；待支付订单会取消。"
      confirmText="删除工作空间"
      variant="destructive"
      size="md"
      busy={busy}
      disabled={!matches}
      onConfirm={() => {
        if (workspace && matches) onConfirm(workspace)
      }}
    >
      <Field>
        <FieldLabel htmlFor="delete-workspace-name">工作空间名称</FieldLabel>
        <Input
          id="delete-workspace-name"
          value={typed}
          maxLength={64}
          disabled={busy}
          autoComplete="off"
          placeholder={workspace?.name}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && workspace && matches && !busy) {
              event.preventDefault()
              onConfirm(workspace)
            }
          }}
        />
      </Field>
    </ConfirmDialog>
  )
}

function MemberRow({
  row,
  busy,
  selected,
  onEdit,
  onDisable,
  onResetPassword,
  onSelectedChange,
}: {
  row: DirectoryMemberRow
  busy: boolean
  selected: boolean
  onEdit: (person: AdminDirectoryPersonView) => void
  onDisable: (person: AdminDirectoryPersonView) => void
  onResetPassword: (person: AdminDirectoryPersonView) => void
  onSelectedChange: (selected: boolean) => void
}) {
  const { person, workspace } = row
  const status = asStatus(person)
  const membership = membershipLabel(person.membership_role)
  const isSuperAdmin = person.role === "super_admin"
  const isAdmin = person.role === "admin"
  const [copied, setCopied] = useState(false)

  const copyUuid = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(person.uuid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    notifySuccess("已复制 UUID", { description: person.uuid })
  }

  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="group/row transition-colors hover:bg-muted/35"
    >
      <TableCell className="w-10 pr-0">
        <Checkbox
          checked={selected}
          aria-label={`选择 ${person.name}`}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
        />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={person.name} status={status} role={person.role} />
          <div className="flex min-w-0 flex-col">
            <button
              type="button"
              onClick={() => onEdit(person)}
              className="flex items-center gap-1.5 text-left font-medium text-foreground hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer"
            >
              <span className="truncate text-compact">{person.name}</span>
            </button>
            <div className="flex items-center gap-1 text-meta text-muted-foreground">
              <span className="font-mono text-2xs truncate max-w-28 opacity-80" title={person.uuid}>
                {person.uuid.slice(0, 8)}…
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={copyUuid}
                      className="cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      aria-label="复制用户 UUID"
                    />
                  }
                >
                  {copied ? <Check className="size-2.5 text-st-good-ink" /> : <Copy className="size-2.5" />}
                </TooltipTrigger>
                <TooltipContent>{copied ? "已复制" : "复制完整 UUID"}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </TableCell>

      <TableCell className="font-mono text-compact text-muted-foreground">
        <span className="select-all">{person.email}</span>
      </TableCell>

      <TableCell>
        {workspace ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-compact font-medium">
                {workspace.name}
              </span>
              <PlanMark plan={workspace.plan} />
            </div>
            {membership ? (
              <span className="flex items-center gap-1 text-meta text-muted-foreground">
                <span className={cn(
                  "inline-block rounded-xs px-1 py-px text-2xs font-medium",
                  person.membership_role === "owner" ? "bg-st-attest-soft text-st-attest-ink" : "bg-muted text-muted-foreground",
                )}>
                  {membership}
                </span>
                <span className="opacity-60">· 占用名额</span>
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-faint-foreground text-xs">未加入工作空间</span>
        )}
      </TableCell>

      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={isSuperAdmin ? "brand" : isAdmin ? "secondary" : "outline"}
            className={cn(
              "h-5 gap-1 px-1.5 text-2xs font-medium",
              isSuperAdmin && "border-brand/40 bg-brand-soft text-brand-ink font-semibold",
              isAdmin && "border-brand/30 bg-brand-soft text-brand-ink",
            )}
          >
            {isSuperAdmin ? (
              <Crown className="size-2.5 text-st-attest-ink" />
            ) : isAdmin ? (
              <ShieldCheck className="size-2.5" />
            ) : (
              <User className="size-2.5 opacity-60" />
            )}
            {person.role_label || platformRoleLabel(person.role)}
          </Badge>
          {isSuperAdmin ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex h-5 cursor-help items-center gap-1 rounded-md border border-dashed border-st-attest/40 bg-st-attest-soft px-1.5 text-2xs font-medium text-st-attest-ink" />
                }
              >
                <Lock className="size-2.5" />
                系统
              </TooltipTrigger>
              <TooltipContent>
                唯一超级管理员，由服务器端 admin init 一次性创建并保存在系统中；不可停用或降级
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TableCell>

      <TableCell>
        <StatusCell status={status} suspended={person.membership_status === "suspended"} />
      </TableCell>

      <TableCell className="text-compact text-muted-foreground tabular-nums">
        {person.last_login_at ? (
          formatDateTimeShort(person.last_login_at)
        ) : (
          <span className="text-faint-foreground">从未登录</span>
        )}
      </TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 cursor-pointer gap-1 px-2 text-xs font-medium hover:bg-brand-soft/60 hover:text-brand-ink"
                  aria-label={isSuperAdmin ? "查看账号" : "编辑账号"}
                  disabled={!person.editable || busy}
                  onClick={() => onEdit(person)}
                />
              }
            >
              {isSuperAdmin ? (
                <Eye className="size-3.5" aria-hidden />
              ) : (
                <Pencil className="size-3.5" aria-hidden />
              )}
              <span>{isSuperAdmin ? "查看" : "编辑"}</span>
            </TooltipTrigger>
          <TooltipContent>
            {isSuperAdmin
              ? "超级管理员由服务器初始化创建，账号详情只读"
              : "编辑账号角色与登录状态"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-7 cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="重置密码"
                disabled={!person.editable || busy}
                onClick={() => onResetPassword(person)}
              />
            }
          >
            <KeyRound className="size-3" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>重置登录密码</TooltipContent>
        </Tooltip>

        {/* The unique system-created SuperAdmin can never be disabled;
            rendering a dead trash button implies the action exists. */}
        {isSuperAdmin ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="停用"
                  disabled={!person.manageable || busy}
                  className="size-7 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onDisable(person)}
                />
              }
            >
              <Trash2 className="size-3" aria-hidden />
            </TooltipTrigger>
            <TooltipContent>停用该账户</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TableCell>
  </TableRow>
  )
}

function WorkspaceQuotaRow({
  workspace,
  busy,
  onDeleteWorkspace,
}: {
  workspace: AdminDirectoryWorkspaceView
  busy: boolean
  onDeleteWorkspace: (workspace: AdminDirectoryWorkspaceView) => void
}) {
  const percent = workspace.seat_limit > 0 ? Math.round((workspace.seats_used / workspace.seat_limit) * 100) : 0
  const isHighUsage = percent >= 90
  const storeLimit = workspace.plan === "lite" ? 1 : workspace.seat_limit * 5

  return (
    <TableRow className="group/workspace-row transition-colors hover:bg-muted/35">
      <TableCell>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-compact">{workspace.name}</span>
            <span className="font-mono text-2xs text-muted-foreground">#{workspace.id}</span>
          </div>
          <span className="text-meta text-muted-foreground">
            {workspace.members.length} 名成员 · 创建于 {workspace.created_at.slice(0, 10)}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <PlanMark plan={workspace.plan} />
          </div>
          <span className="text-2xs text-muted-foreground">
            {workspace.plan === "lite" ? "默认档 · 1 店" : "付费档 · 5 店/席"}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-1 min-w-28 max-w-40">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">席位占用</span>
            <span className="font-mono tabular-nums font-medium">
              {workspace.seats_used} / {workspace.seat_limit}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isHighUsage ? "bg-st-attest" : "bg-brand",
              )}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
          <span className="font-mono text-2xs text-muted-foreground">
            {workspace.seat_limit} 席位上限
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-0.5 min-w-28">
          <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-foreground tabular-nums">
            <Store className="size-3.5 text-muted-foreground shrink-0" aria-hidden />
            <span>{storeLimit} 家店铺</span>
          </div>
          <span className="text-2xs text-muted-foreground">
            {workspace.plan === "lite" ? "默认档 · 1 店" : "席位联动 · 5 店/席"}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col">
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {formatYuan(workspace.wallet_available_microfen)}
          </span>
          {workspace.wallet_held_microfen > 0 ? (
            <span className="font-mono text-2xs text-muted-foreground">
              预留 {formatYuan(workspace.wallet_held_microfen)}
            </span>
          ) : null}
        </div>
      </TableCell>

      <TableCell>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatCompactQuota(workspace.ai_tokens_used)} / {formatCompactQuota(workspace.ai_tokens_monthly)}
        </span>
      </TableCell>

      <TableCell className="text-right">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-7 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          aria-label={`删除工作空间 ${workspace.name}`}
          onClick={() => onDeleteWorkspace(workspace)}
        >
          <Trash2 className="size-3" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function Avatar({
  name,
  status,
  role,
}: {
  name: string
  status: AccountStatus
  role: string
}) {
  return (
    <div className="relative">
      <IdentityMark
        kind="user"
        name={name}
        role={role}
        className={cn("size-7", status === "disabled" && "opacity-60 grayscale")}
      />
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-card",
          status === "disabled" ? "bg-st-bad" : "bg-st-good",
        )}
      />
    </div>
  )
}

/**
 * One verdict per member: active, disabled, or suspended seat.
 */
function StatusCell({ status, suspended }: { status: AccountStatus; suspended: boolean }) {
  const verdict =
    status === "disabled"
      ? { dot: "bg-st-bad", label: STATUS_LABEL.disabled, ink: "font-medium text-st-bad-ink" }
      : suspended
        ? { dot: "bg-st-attest", label: "名额受限", ink: "font-medium text-st-attest-ink" }
        : { dot: "bg-st-good", label: STATUS_LABEL.active, ink: "text-muted-foreground" }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", verdict.dot)} />
      <span className={verdict.ink}>{verdict.label}</span>
    </span>
  )
}

/**
 * Edit one account's platform role and login status (账号编辑).
 */
function EditUserDialog({
  user,
  busy,
  actorRole,
  onClose,
  onSave,
  onResetPassword,
  userWorkspace,
}: {
  user?: AdminDirectoryPersonView
  busy: boolean
  actorRole?: string | null
  onClose: () => void
  onSave: (next: {
    uuid: string
    role: AssignableRole | "super_admin"
    enabled: boolean
  }) => void
  onResetPassword: (user: AdminDirectoryPersonView) => void
  userWorkspace?: AdminDirectoryWorkspaceView
}) {
  const [role, setRole] = useState<AssignableRole | "super_admin">("user")
  const [enabled, setEnabled] = useState(true)
  const [copied, setCopied] = useState(false)
  const systemOwned = user?.role === "super_admin"

  useEffect(() => {
    if (!user) return
    setRole(
      user.role === "admin" || user.role === "super_admin" || user.role === "user"
        ? user.role
        : "user",
    )
    setEnabled(asStatus(user) === "active")
    setCopied(false)
  }, [user])

  const copyUuid = () => {
    if (!user) return
    void navigator.clipboard.writeText(user.uuid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    notifySuccess("已复制 UUID", { description: user.uuid })
  }

  return (
    <PlatformAdminDialog
      open={Boolean(user)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      header={
        user ? (
          <div className="flex items-center gap-3">
            <IdentityMark kind="user" name={user.name} role={user.role} className="size-9" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-base font-semibold truncate">
                  {user.name}
                </DialogTitle>
                <Badge variant={enabled ? "secondary" : "destructive"} className="h-5 text-2xs">
                  {enabled ? "账号正常" : "已停用"}
                </Badge>
              </div>
              <DialogDescription className="text-meta text-muted-foreground break-all">
                {user.email}
              </DialogDescription>
            </div>
          </div>
        ) : undefined
      }
      footer={
        user ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground hover:text-foreground cursor-pointer"
              disabled={!user.editable || busy}
              onClick={() => onResetPassword(user)}
            >
              <KeyRound className="size-3.5" data-icon="inline-start" />
              重置密码
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy} className="cursor-pointer">
              {systemOwned ? "关闭" : "取消"}
            </Button>
            {/* systemOwned accounts are read-only here: the rank is created by
                the server-side admin init and the last SuperAdmin cannot be
                disabled, so nothing can save. */}
            {systemOwned ? null : (
              <Button
                type="button"
                size="sm"
                className="cursor-pointer"
                disabled={busy || (!user.editable && !user.manageable)}
                onClick={() =>
                  onSave({
                    uuid: user.uuid,
                    role,
                    enabled,
                  })
                }
              >
                {busy ? <Spinner data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
                保存更改
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {user ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
              {/* Identity & Basic facts */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4 text-compact">
                <div className="flex flex-col gap-0.5">
                  <span className="text-meta text-muted-foreground">用户标识 (UUID)</span>
                  <span className="font-mono text-foreground select-all break-all">{user.uuid}</span>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="cursor-pointer gap-1"
                  onClick={copyUuid}
                >
                  {copied ? <Check className="size-3 text-st-good-ink" /> : <Copy className="size-3" />}
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>

              {/* Section 1: Platform Role Authorization */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <FieldLabel className="text-xs font-semibold text-foreground">
                    平台角色
                  </FieldLabel>
                  {systemOwned ? (
                    <span className="text-meta font-medium text-st-attest-ink">
                      由服务器初始化创建
                    </span>
                  ) : null}
                </div>

                {systemOwned ? (
                  <div className="flex items-center gap-3 rounded-lg border border-st-attest/30 bg-st-attest-soft p-3 text-xs">
                    <Crown className="size-4 text-st-attest-ink shrink-0" />
                    <div>
                      <p className="font-medium text-foreground">超级管理员 · 全局唯一</p>
                      <p className="text-meta text-muted-foreground">
                        由服务器端 admin init 一次性创建并保存在系统中，不经过面板创建或变更；
                        不可降级、停用或删除。
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="平台角色">
                    {assignableRoles(actorRole).map((option) => {
                      const isOptionAdmin = option === "admin"
                      const checked = role === option
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          disabled={!user.manageable || busy}
                          onClick={() => setRole(option)}
                          className={cn(
                            "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-45",
                            checked
                              ? "border-brand/60 bg-brand-soft/40 ring-1 ring-brand/30"
                              : "border-border hover:bg-muted/50",
                          )}
                        >
                          <div className="flex w-full items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium text-xs text-foreground">
                              {isOptionAdmin ? (
                                <ShieldCheck className="size-3.5 text-brand-ink" />
                              ) : (
                                <User className="size-3.5 text-muted-foreground" />
                              )}
                              {platformRoleLabel(option)}
                            </span>
                            {checked ? <Check className="size-3 text-brand-ink" /> : null}
                          </div>
                          <p className="text-meta text-muted-foreground leading-snug">
                            {isOptionAdmin
                              ? "具备平台管理员权限，可管理普通用户与查看运行日志"
                              : "仅访问所属工作空间分配的功能，无平台管理后台权限"}
                          </p>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Section 2: Login and access status */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <FieldLabel className="text-xs font-semibold text-foreground">
                    账号状态
                  </FieldLabel>
                  {systemOwned ? (
                    <span className="text-meta font-medium text-st-attest-ink">
                      由系统托管
                    </span>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-foreground">
                        账号登录与访问状态
                      </span>
                      <p className="text-meta text-muted-foreground">
                        {enabled
                          ? "账号状态正常，可正常登录系统并使用被授权的工作空间"
                          : "账号已停用，将拒绝新会话登录，已有数据与店铺绑定保持不变"}
                      </p>
                    </div>
                    <Switch
                      checked={enabled}
                      disabled={!user.manageable || busy}
                      onCheckedChange={setEnabled}
                      aria-label="账户启用状态"
                    />
                  </div>
                </div>
              </div>

              {/* Section 3: Workspace Affiliation & Standing */}
              <div className="flex flex-col gap-2">
                <FieldLabel className="text-xs font-semibold text-foreground">
                  工作空间归属与成员
                </FieldLabel>
                {userWorkspace ? (
                  <div className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-foreground">{userWorkspace.name}</span>
                        <PlanMark plan={userWorkspace.plan} />
                      </div>
                      <span className="text-meta text-muted-foreground">
                        成员占用: {userWorkspace.seats_used}/{userWorkspace.seat_limit} · 店铺额度: {userWorkspace.plan === "lite" ? 1 : userWorkspace.seat_limit * 5} 家 · 钱包可用: {formatYuan(userWorkspace.wallet_available_microfen)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    该账号尚未加入任何工作空间
                  </div>
                )}
              </div>
            </div>
      ) : null}
    </PlatformAdminDialog>
  )
}

function ResetPasswordDialog({
  user,
  busy,
  onClose,
  onConfirm,
}: {
  user?: AdminDirectoryPersonView
  busy: boolean
  onClose: () => void
  onConfirm: (uuid: string, password: string) => void
}) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (!user) {
      setPassword("")
      setConfirm("")
      setShowPassword(false)
    }
  }, [user])

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit = Boolean(user) && password.length >= 8 && password === confirm && !busy

  return (
    <PlatformAdminDialog
      open={Boolean(user)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      width="sm:max-w-sm"
      header={
        <>
          <DialogTitle className="text-base font-semibold">重置密码</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {user ? `为「${user.name}」设置新密码` : ""}
          </DialogDescription>
        </>
      }
      footer={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy} className="cursor-pointer">
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            className="cursor-pointer gap-1.5"
            onClick={() => {
              if (user && canSubmit) onConfirm(user.uuid, password)
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : <KeyRound className="size-3.5" data-icon="inline-start" />}
            确认重置
          </Button>
        </>
      }
    >
        <div className="flex flex-col gap-3.5 p-5">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="reset-password" className="text-xs">
              新密码
            </FieldLabel>
            <PasswordVisibilityField
              id="reset-password"
              value={password}
              onChange={setPassword}
              visible={showPassword}
              onToggle={() => setShowPassword((visible) => !visible)}
              placeholder="至少 8 个字符"
              invalid={tooShort}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="reset-confirm" className="text-xs">
              确认密码
            </FieldLabel>
            <PasswordVisibilityField
              id="reset-confirm"
              value={confirm}
              onChange={setConfirm}
              visible={showPassword}
              onToggle={() => setShowPassword((visible) => !visible)}
              placeholder="再输入一次"
              invalid={mismatch}
            />
          </Field>
        </div>
    </PlatformAdminDialog>
  )
}

function DisableUserDialog({
  user,
  busy,
  onClose,
  onConfirm,
}: {
  user?: AdminDirectoryPersonView
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={Boolean(user)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="停用账户？"
      description={`将停用「${user?.name ?? ""}」（${user?.email ?? ""}）。对方将无法登录；可在编辑中重新启用。`}
      confirmText="停用账户"
      variant="destructive"
      icon={<Trash2 data-icon="inline-start" />}
      busy={busy}
      footerLayout="end"
      onConfirm={onConfirm}
      onCancel={onClose}
    />
  )
}

function CreateDialog({
  open,
  busy,
  actorRole,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  busy: boolean
  actorRole?: string | null
  onOpenChange: (open: boolean) => void
  onCreate: (input: {
    email: string
    password: string
    role: AssignableRole
  }) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const formValid = emailValid && password.length >= 8

  useEffect(() => {
    if (open) return
    setEmail("")
    setPassword("")
    setShowPassword(false)
  }, [open])

  return (
    <PlatformAdminDialog
      open={open}
      onOpenChange={onOpenChange}
      title="创建账户"
      description="创建账户并分配平台角色"
      className="max-h-[calc(100dvh-2rem)]"
    >
        <form
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            onCreate({
              email: String(data.get("email") ?? ""),
              password: String(data.get("password") ?? ""),
              role: String(data.get("role") ?? "user") as AssignableRole,
            })
          }}
        >
          <div className="flex flex-col gap-4 p-5">
            <Field>
              <FieldLabel htmlFor="create-email">邮箱</FieldLabel>
              <Input
                id="create-email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                className="placeholder:text-muted-foreground"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="create-password">初始密码</FieldLabel>
              <PasswordVisibilityField
                id="create-password"
                name="password"
                required
                minLength={8}
                value={password}
                onChange={setPassword}
                visible={showPassword}
                onToggle={() => setShowPassword((visible) => !visible)}
                placeholder="至少 8 个字符"
                className="h-9"
              />
            </Field>
            <Field>
              <FieldLabel>平台角色</FieldLabel>
              <div className="grid grid-cols-2 gap-2.5">
                {assignableRoles(actorRole).map((role) => (
                  <label
                    key={role}
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-border p-3 text-sm transition-all hover:bg-muted/40 has-[:checked]:border-brand/60 has-[:checked]:bg-brand-soft/45 has-[:checked]:font-medium"
                  >
                    <span>{platformRoleLabel(role)}</span>
                    <input
                      type="radio"
                      name="role"
                      value={role}
                      defaultChecked={role === "user"}
                      className="accent-brand size-3.5"
                    />
                  </label>
                ))}
              </div>
              <p className="text-2xs text-muted-foreground">
                超级管理员由服务器端 admin init 一次性创建并保存在系统中，全局唯一，不在面板中创建。
              </p>
            </Field>
          </div>
          <PlatformAdminDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" className="cursor-pointer" disabled={busy || !formValid}>
              {busy ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}
              创建账户
            </Button>
          </PlatformAdminDialogFooter>
        </form>
    </PlatformAdminDialog>
  )
}
