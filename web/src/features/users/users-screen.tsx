import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Building2,
  ChartNoAxesColumn,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react"

import type {
  AdminDirectoryPersonView,
  AdminDirectoryWorkspaceView,
  AdminUsersOverview,
  WalletTopupsData,
} from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { IdentityMark } from "@/components/identity-mark"
import { PlatformAdminEmpty, PlatformAdminSearch, PlatformAdminSummary } from "@/components/platform-admin-surface"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { formatCompactQuota } from "@/components/workspace-quota-facts"
import { formatRole, PlanMark } from "@/components/workspace-display"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import { applyWalletToWorkspace } from "@/features/users/wallet-grants"
import { WorkspaceWalletDialog } from "@/features/users/workspace-wallet-dialog"
import { formatDateTimeShort } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"
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

export function directoryPage(total: number, page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.max(1, Math.min(page, pageCount))
  return { pageCount, currentPage, firstRow: (currentPage - 1) * pageSize }
}

/**
 * Platform SuperAdmin directory: account authorization, workspace standing,
 * and each workspace's own wallet (grant / revoke). Plan seats move through
 * 兑换码; this panel assigns platform roles (admin/user) and login status.
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
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [directory, setDirectory] = useState<AdminUsersOverview>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AdminDirectoryPersonView>()
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<AdminDirectoryWorkspaceView>()
  const [walletWorkspaceUuid, setWalletWorkspaceUuid] = useState<string>()
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
      if (request === directoryRequest.current) {
        setDirectory(next)
        setLoadError(undefined)
      }
    } catch (reason) {
      if (request === directoryRequest.current) {
        setLoadError(errorMessage(reason, "无法加载平台账户，请稍后重试。"))
        notifyCommandError(reason, "无法加载平台账户，请稍后重试。")
      }
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
  const walletWorkspace = walletWorkspaceUuid
    ? workspaces.find((workspace) => workspace.uuid === walletWorkspaceUuid)
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

  const totalRows = viewMode === "members" ? visibleMembers.length : visibleWorkspaces.length
  const { pageCount, currentPage, firstRow } = directoryPage(totalRows, page, pageSize)
  const pageMembers = visibleMembers.slice(firstRow, firstRow + pageSize)
  const pageWorkspaces = visibleWorkspaces.slice(firstRow, firstRow + pageSize)

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

  function applyWallet(workspaceUuid: string, wallet: WalletTopupsData) {
    setDirectory((current) => applyWalletToWorkspace(current, workspaceUuid, wallet))
  }

  return (
    <Popover open={Boolean(editing)} onOpenChange={(open) => { if (!open && !busy) setEditing(undefined) }}>
    <div className="users-directory flex min-h-0 w-full flex-1 flex-col gap-3 overflow-hidden p-3">
      <h1 className="sr-only">用户</h1>

      {/* Focused Workspace Banner */}
      {focusedWorkspace ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-compact">
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
              <span>余额 {formatYuan(focusedWorkspace.wallet_available_microfen)}</span>
              {focusedWorkspace.wallet_held_microfen > 0 ? (
                <span>预留 {formatYuan(focusedWorkspace.wallet_held_microfen)}</span>
              ) : null}
              <span>Token {formatCompactQuota(focusedWorkspace.ai_tokens_used)}</span>
            </PlatformAdminSummary>
          </div>
          <div className="flex items-center gap-1.5">
            <IconButton
              icon={Wallet}
              label={`管理钱包 ${focusedWorkspace.name}`}
              tip="管理钱包"
              size="icon-xs"
              className="cursor-pointer"
              disabled={busy}
              onClick={() => setWalletWorkspaceUuid(focusedWorkspace.uuid)}
            />
            <IconButton
              icon={Trash2}
              label={`删除工作空间 ${focusedWorkspace.name}`}
              tip="删除工作空间"
              size="icon-xs"
              className="cursor-pointer text-destructive hover:bg-destructive/10"
              disabled={busy}
              onClick={() => setPendingDeleteWorkspace(focusedWorkspace)}
            />
            <IconButton
              icon={X}
              label="清除聚焦"
              size="icon-xs"
              className="cursor-pointer"
              onClick={() => { setWorkspaceFilter("all"); setPage(1) }}
            />
          </div>
        </div>
      ) : null}

      <section aria-label="用户目录" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2 pb-3">
            <PlatformAdminSearch value={query} onChange={(value) => { setQuery(value); setPage(1) }}
              label={viewMode === "members" ? "搜索工作空间或账户" : "搜索工作空间"}
              placeholder={viewMode === "members" ? "搜索姓名、邮箱或工作空间…" : "搜索工作空间、所有者或档位…"}
              className="min-w-32 flex-1 basis-32 sm:max-w-none" />
            <Select value={viewMode} onValueChange={(value) => { if (value) { setViewMode(value as ViewMode); setPage(1) } }}>
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label="目录视图"><SelectValue>{() => viewMode === "members" ? "账号与成员" : "工作空间与权益"}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="members">账号与成员</SelectItem><SelectItem value="workspaces">工作空间与权益</SelectItem></SelectContent>
            </Select>
            {viewMode === "members" ? <>
              <Select value={statusFilter} onValueChange={(value) => { if (value) { setStatusFilter(value as DirectoryFilter); setPage(1) } }}>
                <SelectTrigger size="sm" aria-label="按状态筛选"><SelectValue>{() => ({ all: "全部状态", active: "已启用", disabled: "已停用", privileged: "特权", unaffiliated: "未加入" })[statusFilter]}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态 ({uniquePeople.length})</SelectItem>
                  <SelectItem value="active">已启用 ({activeCount})</SelectItem>
                  <SelectItem value="disabled">已停用 ({disabledCount})</SelectItem>
                  <SelectItem value="privileged">特权 ({privilegedCount})</SelectItem>
                  <SelectItem value="unaffiliated">未加入 ({unaffiliated.length})</SelectItem>
                </SelectContent>
              </Select>
              <Select value={workspaceFilter} onValueChange={(value) => { setWorkspaceFilter(value ?? "all"); setPage(1) }}>
                <SelectTrigger size="sm" className="max-w-48" aria-label="按工作空间筛选">
                  <SelectValue>{() => workspaceFilter === "unaffiliated" ? "未加入工作空间" : workspaces.find((workspace) => workspace.uuid === workspaceFilter)?.name ?? "全部工作空间"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部工作空间 ({workspaces.length})</SelectItem>
                  <SelectItem value="unaffiliated">未加入工作空间 ({unaffiliated.length})</SelectItem>
                  {workspaces.map((workspace) => <SelectItem key={workspace.uuid} value={workspace.uuid}>{workspace.name} ({workspace.members.length}人)</SelectItem>)}
                </SelectContent>
              </Select>
            </> : null}
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger render={<IconButton icon={ChartNoAxesColumn} label="账户概览" variant="outline" size="icon-sm" />} />
                <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
                  <dl aria-label="账户概览" className="grid grid-cols-2 gap-x-4 gap-y-4">
                    {[
                      { label: "总账户", value: uniquePeople.length.toLocaleString("zh-CN"), detail: `${privilegedCount} 个特权账户`, icon: Users },
                      { label: "已启用账户", value: activeCount.toLocaleString("zh-CN"), detail: `${disabledCount} 个已停用`, icon: ShieldCheck },
                      { label: "工作空间", value: (directory?.workspace_count ?? workspaces.length).toLocaleString("zh-CN"), detail: `席位 ${totalSeatsUsed} / ${totalSeatLimit}`, icon: Building2 },
                      { label: "钱包可用", value: formatYuan(totalWalletAvailable), detail: `预留 ${formatYuan(totalWalletHeld)}`, icon: Wallet },
                    ].map(({ label, value, detail, icon: Icon }) => (
                      <div key={label} className="min-w-0">
                        <dt className="flex items-center gap-1.5 text-compact text-muted-foreground"><Icon aria-hidden className="size-4" />{label}</dt>
                        <dd className="mt-1.5 font-medium tabular-nums">{directory ? value : "—"}</dd>
                        <dd className="text-meta text-muted-foreground">{directory ? detail : "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </PopoverContent>
              </Popover>
              <IconButton icon={RefreshCw} label="刷新" tip="刷新用户目录" size="icon-sm" variant="outline" disabled={busy || loading} onClick={() => void reload(true)} />
              <Button
                type="button"
                size="sm" variant="brand"
                aria-label="创建账户"
                onClick={() => setCreateOpen(true)}
                disabled={busy || loading || Boolean(loadError)}
              >
                <UserPlus aria-hidden />创建账户
              </Button>
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-xl border border-border bg-card">
        {loading ? (
          <PlatformAdminEmpty
            icon={Users}
            busy
            title="正在加载账户与工作空间数据…"
          />
        ) : loadError ? (
          <PlatformAdminEmpty
            icon={ShieldCheck}
            title="无法加载平台账户"
            description={loadError}
            action={<Button size="sm" variant="outline" onClick={() => void reload()}>重试</Button>}
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
                    setPage(1)
                  }}
                >
                  清空筛选条件
                </Button>
              }
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {selectedPeople.length > 0 ? (
                <div
                  role="toolbar"
                  aria-label="批量操作"
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-soft/40 px-3 py-2"
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
                    <IconButton
                      icon={X}
                      label="清除选择"
                      size="icon-sm"
                      className="cursor-pointer"
                      onClick={() => setSelectedUuids(new Set())}
                    />
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
              <Table variant="directory" className="min-h-0 min-w-[800px] table-fixed" containerClassName="min-h-0 flex-1 overflow-auto">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-1/4" />
                  <col className="w-1/4" />
                  <col className="w-1/5" />
                  <col className="w-52" />
                </colgroup>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 pr-0">
                      <Checkbox
                        className="max-md:after:-inset-3.5"
                        checked={allVisibleSelected}
                        indeterminate={!allVisibleSelected && someVisibleSelected}
                        aria-label="选择当前筛选的全部账户"
                        onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      />
                    </TableHead>
                    <TableHead>用户 / 邮箱</TableHead>
                    <TableHead>工作空间</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-52 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageMembers.map((row) => (
                    <MemberRow
                      key={`${row.workspace?.uuid ?? "none"}-${row.person.uuid}`}
                      row={row}
                      busy={busy}
                      selected={selectedUuids.has(row.person.uuid)}
                      editing={editing?.uuid === row.person.uuid}
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
            <div className="min-h-0 flex-1 overflow-auto">
              <Table variant="directory" className="min-w-240" containerClassName="overflow-visible">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>工作空间名称</TableHead>
                    <TableHead>档位配置</TableHead>
                    <TableHead>成员配置</TableHead>
                    <TableHead>钱包余额</TableHead>
                    <TableHead>月度 Token</TableHead>
                    <TableHead className="w-44 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageWorkspaces.map((workspace) => (
                    <WorkspaceQuotaRow
                      key={workspace.uuid}
                      workspace={workspace}
                      busy={busy}
                      onOpenWallet={(target) => setWalletWorkspaceUuid(target.uuid)}
                      onDeleteWorkspace={setPendingDeleteWorkspace}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}
        </div>
        {!loading && !loadError && directory ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pt-3 text-compact text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-live="polite">共 {totalRows.toLocaleString("zh-CN")} 条</span>
              <span>每页</span>
              <Select value={String(pageSize)} onValueChange={(value) => { if (value) { setPageSize(Number(value)); setPage(1) } }}>
                <SelectTrigger size="sm" className="w-24" aria-label="每页条数"><SelectValue>{() => `${pageSize} 条`}</SelectValue></SelectTrigger>
                <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <IconButton icon={ChevronLeft} label="上一页" variant="outline" size="icon-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} />
              <span aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`} className="flex size-9 items-center justify-center rounded-md bg-brand text-brand-foreground tabular-nums">{currentPage}</span>
              <IconButton icon={ChevronRight} label="下一页" variant="outline" size="icon-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} />
            </div>
          </div>
        ) : null}
      </section>

      {/* Account edits float above the directory; destructive actions retain their dialogs. */}
      <CreateDialog
        open={createOpen}
        busy={busy}
        actorRole={actorRole}
        onOpenChange={setCreateOpen}
        onCreate={createUser}
      />
      <PopoverContent side="right" align="center" collisionAvoidance={{ side: "shift", align: "shift" }} aria-labelledby="user-editor-title" className="flex max-h-[calc(100svh-24px)] w-80 overflow-hidden p-0">
      <EditUserForm
        user={editing}
        busy={busy}
        actorRole={actorRole}
        onClose={() => setEditing(undefined)}
        onSave={saveUser}
        onResetPassword={(user) => {
          setEditing(undefined)
          setResetting(user)
        }}
      />
      </PopoverContent>
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
      <WorkspaceWalletDialog
        workspace={walletWorkspace}
        onClose={() => setWalletWorkspaceUuid(undefined)}
        onChanged={applyWallet}
      />
    </div>
    </Popover>
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
      description="删除后无法恢复。成员立即失去访问；店铺密钥会被清除；未用完的店铺位作废；该工作空间钱包的余额不会转移或退款；待支付订单会取消。"
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

export function MemberRow({
  row,
  busy,
  selected,
  editing,
  onEdit,
  onDisable,
  onResetPassword,
  onSelectedChange,
}: {
  row: DirectoryMemberRow
  busy: boolean
  selected: boolean
  editing?: boolean
  onEdit: (person: AdminDirectoryPersonView) => void
  onDisable: (person: AdminDirectoryPersonView) => void
  onResetPassword: (person: AdminDirectoryPersonView) => void
  onSelectedChange: (selected: boolean) => void
}) {
  const { person, workspace } = row
  const status = asStatus(person)
  const membership = membershipLabel(person.membership_role)
  const isSuperAdmin = person.role === "super_admin"
  const roleLabel = person.role_label || platformRoleLabel(person.role)
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      data-editing={editing || undefined}
      className="group/row text-compact transition-colors"
    >
      <TableCell className="w-10 pr-0">
        <Checkbox
          className="max-md:after:-inset-3.5"
          checked={selected}
          aria-label={`选择 ${person.name}`}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
        />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={person.name} status={status} role={person.role} />
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              <PopoverTrigger render={<button
                type="button"
                onClick={() => onEdit(person)}
                disabled={busy}
                className="flex min-w-0 max-w-full items-center gap-1.5 text-left font-medium text-foreground hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer max-md:min-h-11 max-md:min-w-11"
              />}>
                <span className="truncate text-compact" title={person.name}>{person.name}</span>
              </PopoverTrigger>
              {roleLabel !== person.name ? <span className="shrink-0 text-meta text-muted-foreground">{roleLabel}</span> : null}
              {isSuperAdmin ? <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0 cursor-help items-center gap-1 text-meta text-st-attest-ink" />}><Lock className="size-2.5" />系统</TooltipTrigger>
                <TooltipContent>唯一超级管理员，由服务器端 admin init 一次性创建并保存在系统中；不可停用或降级</TooltipContent>
              </Tooltip> : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-compact text-muted-foreground">
              <span className="max-w-64 truncate select-all" title={person.email}>{person.email}</span>
            </div>
          </div>
        </div>
      </TableCell>

      <TableCell>
        {workspace ? (
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="max-w-56 truncate text-compact font-medium" title={workspace.name}>
                {workspace.name}
              </span>
              <PlanMark plan={workspace.plan} />
            </div>
            {membership ? (
              <span className="flex items-center gap-1 text-meta text-muted-foreground">
                <span className="text-meta text-muted-foreground">
                  {membership}
                </span>
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-faint-foreground">未加入工作空间</span>
        )}
      </TableCell>

      <TableCell>
        <StatusCell status={status} suspended={person.membership_status === "suspended"} />
        <div className="mt-1 whitespace-nowrap text-meta tabular-nums text-muted-foreground">
          {person.last_login_at ? `最近登录 ${formatDateTimeShort(person.last_login_at)}` : "从未登录"}
        </div>
      </TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
          <PopoverTrigger render={<IconButton
            icon={isSuperAdmin ? Eye : Pencil}
            size="icon-sm"
            label={isSuperAdmin ? "查看账号" : "编辑账号"}
            tip={isSuperAdmin ? "超级管理员由服务器初始化创建，账号详情只读" : "编辑账号角色与登录状态"}
            disabled={busy || (!person.editable && !isSuperAdmin)}
            onClick={() => onEdit(person)}
          />} />

        <IconButton icon={KeyRound} size="icon-sm" label="重置密码"
          disabled={!person.editable || busy} onClick={() => onResetPassword(person)} />

        {/* The unique system-created SuperAdmin can never be disabled;
            rendering a dead trash button implies the action exists. */}
        {isSuperAdmin ? null : (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger render={<IconButton icon={Ellipsis} size="icon-sm" label={`更多操作 ${person.name}`} tip="更多操作" disabled={!person.manageable || busy || status === "disabled"} />} />
            <PopoverContent align="end" className="w-auto p-1">
              <Button type="button" size="sm" variant="destructive" aria-label="停用" disabled={!person.manageable || busy} onClick={() => { setMoreOpen(false); onDisable(person) }}><Trash2 aria-hidden />停用账户</Button>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </TableCell>
  </TableRow>
  )
}

function WorkspaceQuotaRow({
  workspace,
  busy,
  onOpenWallet,
  onDeleteWorkspace,
}: {
  workspace: AdminDirectoryWorkspaceView
  busy: boolean
  onOpenWallet: (workspace: AdminDirectoryWorkspaceView) => void
  onDeleteWorkspace: (workspace: AdminDirectoryWorkspaceView) => void
}) {
  const percent = workspace.seat_limit > 0 ? Math.round((workspace.seats_used / workspace.seat_limit) * 100) : 0
  const isHighUsage = percent >= 90

  return (
    <TableRow className="group/workspace-row text-xs transition-colors md:[&>td]:py-1.5">
      <TableCell>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-56 truncate text-xs font-medium text-foreground" title={workspace.name}>{workspace.name}</span>
            <span className="font-mono text-meta tabular-nums text-muted-foreground">#{workspace.id}</span>
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
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col gap-1 min-w-28 max-w-40">
          <div className="flex items-center justify-between text-meta">
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
          <span className="font-mono text-meta tabular-nums text-muted-foreground">
            {workspace.seat_limit} 席位上限
          </span>
        </div>
      </TableCell>

      <TableCell>
        <div className="flex flex-col">
          <span className="font-mono text-xs font-medium tabular-nums text-foreground">
            {formatYuan(workspace.wallet_available_microfen)}
          </span>
          {workspace.wallet_held_microfen > 0 ? (
            <span className="font-mono text-meta tabular-nums text-muted-foreground">
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
        <div className="flex items-center justify-end gap-1">
          <IconButton
            icon={Wallet}
            iconClassName="size-3"
            label={`管理钱包 ${workspace.name}`}
            tip="管理钱包"
            size="icon-xs"
            className="size-7 cursor-pointer text-muted-foreground"
            disabled={busy}
            onClick={() => onOpenWallet(workspace)}
          />
          <IconButton
            icon={Trash2}
            iconClassName="size-3"
            label={`删除工作空间 ${workspace.name}`}
            tip="删除工作空间"
            size="icon-xs"
            className="size-7 cursor-pointer text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={() => onDeleteWorkspace(workspace)}
          />
        </div>
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
        className={cn("size-8", status === "disabled" && "opacity-60 grayscale")}
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
      : { dot: "bg-st-good", label: STATUS_LABEL.active, ink: "text-st-good-ink" }
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs", status === "disabled" ? "bg-st-bad-soft" : suspended ? "bg-st-attest-soft" : "bg-st-good-soft")}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", verdict.dot)} />
      <span className={verdict.ink}>{verdict.label}</span>
    </span>
  )
}

export function EditUserForm({
  user, busy, actorRole, onClose, onSave, onResetPassword,
}: {
  user?: AdminDirectoryPersonView
  busy: boolean
  actorRole?: string | null
  onClose: () => void
  onSave: (next: { uuid: string; role: AssignableRole | "super_admin"; enabled: boolean }) => void
  onResetPassword: (user: AdminDirectoryPersonView) => void
}) {
  const [role, setRole] = useState<AssignableRole | "super_admin">(
    user?.role === "admin" || user?.role === "super_admin" ? user.role : "user",
  )
  const [enabled, setEnabled] = useState(user ? asStatus(user) === "active" : true)
  const systemOwned = user?.role === "super_admin"

  useEffect(() => {
    if (!user) return
    setRole(user.role === "admin" || user.role === "super_admin" ? user.role : "user")
    setEnabled(asStatus(user) === "active")
  }, [user])

  if (!user) return null

  return (
    <section aria-labelledby="user-editor-title" className="flex max-h-[inherit] min-h-0 flex-1 flex-col outline-none">
      <header className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <IdentityMark kind="user" name={user.name} role={user.role} className="size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 id="user-editor-title" className="truncate text-sm font-medium">{user.name}</h2>
          <p className="break-all text-xs text-muted-foreground">{user.email}</p>
        </div>
        <IconButton icon={X} label="关闭账号详情" tip="关闭" size="icon-sm" disabled={busy} onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-medium">平台角色</legend>
          {systemOwned ? <p className="text-sm text-muted-foreground">超级管理员 · 系统只读</p> : <div className="grid grid-cols-2 gap-2">
            {assignableRoles(actorRole).map((option) => <label key={option} className={cn(
              "flex min-h-9 min-w-0 cursor-pointer items-center rounded-md border px-2 py-2 has-focus-visible:ring-2 has-focus-visible:ring-ring max-md:min-h-11",
              role === option ? "border-brand bg-brand-soft/50" : "border-border",
              (!user.manageable || busy) && "cursor-not-allowed opacity-50",
            )}>
              <span className="flex items-center gap-2 text-sm font-medium">
                <input type="radio" name="user-platform-role" value={option} checked={role === option}
                  disabled={!user.manageable || busy} onChange={() => setRole(option)} className="size-4 shrink-0 accent-brand" />
                {platformRoleLabel(option)}
              </span>
            </label>)}
          </div>}
        </fieldset>
        <label htmlFor="user-enabled" className="flex min-h-9 items-center justify-between gap-3 max-md:min-h-11">
          <span className="text-sm">启用账号</span>
          <Switch id="user-enabled" checked={enabled} disabled={!user.manageable || busy}
            onCheckedChange={setEnabled} aria-label="账户启用状态" />
        </label>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-3">
        <Button type="button" variant="ghost" size="sm" className="mr-auto" disabled={!user.editable || busy} onClick={() => onResetPassword(user)}>
          <KeyRound aria-hidden className="size-4" />重置密码
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>{systemOwned ? "关闭" : "取消"}</Button>
        {systemOwned ? null : <Button type="button" size="sm" disabled={busy || (!user.editable && !user.manageable)}
          onClick={() => onSave({ uuid: user.uuid, role, enabled })}>
          {busy ? <Spinner aria-hidden /> : null}保存更改
        </Button>}
      </footer>
    </section>
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
