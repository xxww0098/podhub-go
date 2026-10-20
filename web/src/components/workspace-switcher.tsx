import { useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronsUpDown,
  CircleArrowUp,
  Ellipsis,
  Gift,
  Lock,
  LogOut,
  MailPlus,
  Plus,
  Store,
  UserPlus,
} from "lucide-react"

import type {
  AccountOverview,
  CreateWorkspaceInvitationRequest,
  StackedAccountView,
  WorkspaceStandingView,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { IdentityMark } from "@/components/identity-mark"
import { Spinner } from "@/components/ui/spinner"
import { CreateWorkspaceForm } from "@/features/workspace/no-workspace-screen"
import { WorkspaceInviteDialog } from "@/features/workspace/workspace-invite-dialog"
import { RedeemCodeDialog } from "@/features/plans/redeem-code-dialog"
import { notifyCommandError, notifyError } from "@/lib/notify"
import {
  SCREEN_LABELS,
  type WorkspaceSpaceScreen,
} from "@/lib/app-screens"
import { preloadScreen } from "@/app/screen-loaders"
import { cn } from "@/lib/utils"
import { platformRoleLabel } from "@/lib/platform-role"
import { PlanMark, formatPlan, formatRole } from "@/components/workspace-display"

type MenuSide = "top" | "right" | "bottom" | "left"

const TRIGGER =
  "group/workspace inset-well flex w-full cursor-pointer items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors outline-none group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:p-0 hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-popup-open:bg-foreground/[0.06]"
const SHELL = "w-64 border border-border/80 p-1.5 rounded-2xl shadow-overlay"
const WORKSPACE_ROW = "cursor-pointer items-center gap-2.5 px-2.5 py-2"
const ACTION =
  "cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium tracking-[-0.01em] hover:bg-accent/80 focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:[&_svg]:text-accent-foreground not-data-[variant=destructive]:[&_svg]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10"
const UPGRADE =
  "cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium tracking-[-0.01em] text-brand-ink hover:bg-accent/80 focus:bg-accent focus:text-brand-ink [&_svg]:text-brand"
const MARK = "size-7 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]"
const MENU_MARK = "size-8 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]"
const ACCOUNT_MARK = "size-5 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]"
const ACCOUNT_MORE =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-accent data-popup-open:text-accent-foreground"

/**
 * sessionStorage handoff for 「创建工作空间」 picked on another stacked
 * account: creating under it needs that account's session, and the switch
 * reloads the page. The reloaded menu replays the intent as the create
 * dialog (or Cloud's refusal); the no-Workspace gate consumes it too, since an
 * unaffiliated account lands on a page that already is the join-or-create
 * surface. Entries older than two minutes are stale — the session that asked
 * is gone.
 */
export const PENDING_WORKSPACE_CREATE = "podhub:pending-workspace-create"
const PENDING_WORKSPACE_CREATE_TTL_MS = 120_000

function markPendingWorkspaceCreate(uuid: string) {
  try {
    sessionStorage.setItem(
      PENDING_WORKSPACE_CREATE,
      JSON.stringify({ uuid, at: Date.now() }),
    )
  } catch {
    // Storage blocked or full: the switch still lands on the right account.
  }
}

function readPendingWorkspaceCreate(): string | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_WORKSPACE_CREATE)
    if (!raw) return undefined
    const pending = JSON.parse(raw) as { uuid?: string; at?: number }
    if (
      !pending.uuid ||
      !pending.at ||
      Date.now() - pending.at > PENDING_WORKSPACE_CREATE_TTL_MS
    ) {
      sessionStorage.removeItem(PENDING_WORKSPACE_CREATE)
      return undefined
    }
    return pending.uuid
  } catch {
    sessionStorage.removeItem(PENDING_WORKSPACE_CREATE)
    return undefined
  }
}

/** The gate is itself the join-or-create surface; a leftover intent is stale. */
export function clearPendingWorkspaceCreate() {
  try {
    sessionStorage.removeItem(PENDING_WORKSPACE_CREATE)
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/**
 * The rail's single identity control.
 *
 * The trigger names the active Workspace and the menu keeps that order — the
 * Workspace is the context, the account is secondary. Top-down it reads as:
 * the Workspace card (mark, name, plan · role), the Workspace actions (店铺,
 * 升级, 邀请成员) plus 添加账号, then the signed-in account as one muted
 * email row carrying a
 * Notion-style "…" submenu (创建工作空间, 退出登录), then the Workspaces
 * this account can switch into — the active one checked — plus 创建工作空间,
 * then the other accounts this browser is signed into (compact rows: click
 * switches, each "…" holds 创建工作空间 and 退出该账号), then 退出登录
 * alone at the bottom.
 *
 * Creating a Workspace is offered only when `standing` says Cloud would accept it:
 * the owned-Workspace cap is Cloud's rule (ADR-0098) — every account may
 * self-create up to three Workspaces for free, then upgrade a Plan inside each
 * one. When Cloud would refuse, the entry becomes one muted note
 * (action name plus the rule and next step) — a dead button and an orphaned
 * paragraph say the same thing in two pieces.
 *
 * 邀请成员 carries no directory of its own: it loads one when opened and hands
 * the same invite dialog the 团队协作区 settings pane uses. Avatar, password,
 * device preferences, the rest of 团队协作区, 升级方案 and platform
 * administration live in the settings dialog that 设置 opens; 用量 lives on
 * the header wallet badge. 兑换码 opens its own dialog — a code is an ops
 * grant channel, not part of the plan comparison.
 */
export function WorkspaceMenu({
  overview,
  standing,
  onOpenSpace,
  spaceScreen,
  onSwitchWorkspace,
  onSwitchAccount,
  onLogoutAccount,
  onAddAccount,
  onWorkspaceCreated,
  onOpenPlans,
  onOverviewChange,
  onSignedOut,
}: {
  overview?: AccountOverview
  standing?: WorkspaceStandingView
  onOpenSpace: (screen: WorkspaceSpaceScreen) => void
  spaceScreen?: WorkspaceSpaceScreen
  onSwitchWorkspace?: (workspaceId: number) => void | Promise<void>
  onSwitchAccount?: (uuid: string) => void | Promise<void>
  onLogoutAccount?: (uuid: string) => void | Promise<void>
  onAddAccount?: () => void
  onWorkspaceCreated?: (standing: WorkspaceStandingView) => void
  onOpenPlans?: () => void
  onOverviewChange?: (overview: AccountOverview) => void
  onSignedOut: () => void
}) {
  const { state, isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<number>()
  const [busyAccount, setBusyAccount] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteRoles, setInviteRoles] = useState<string[]>([])
  const [redeemOpen, setRedeemOpen] = useState(false)
  // Lock placement for the open session — collapsing the rail mid-menu must
  // not flip top↔right and make the popup jump.
  const sideRef = useRef<MenuSide>("top")
  const refusal = standing ? createWorkspaceRefusal(standing) : undefined
  const entitlement = overview?.entitlement
  const session = overview?.session
  const workspaces = overview?.workspaces ?? []
  const workspaceIds = workspaces.map((workspace) => workspace.id)
  const accounts = overview?.accounts ?? []
  const otherAccounts = accounts.filter((account) => !account.active)
  const active =
    overview?.active_workspace ??
    workspaces.find((workspace) => workspace.is_owned) ??
    workspaces[0]

  const workspaceName = active?.name ?? "未选择 Workspace"
  const plan = active?.plan ?? entitlement?.plan
  const roleLabel = formatRole(active?.role)
  const name = session?.name?.trim() || undefined
  const email = session?.email?.trim() || undefined
  const accountLabel = email ?? name ?? "未登录"
  const accountRoleLabel = platformRoleLabel(session?.role)
  const canInvite = active?.role === "owner" || active?.role === "manager"

  async function signOut() {
    setBusy(true)
    try {
      await accountHttp.accountLogout()
      onSignedOut()
    } catch (reason) {
      notifyCommandError(reason, "无法退出登录，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function switchAccount(uuid: string) {
    if (!onSwitchAccount || busyAccount) return
    setBusyAccount(uuid)
    try {
      await onSwitchAccount(uuid)
    } finally {
      setBusyAccount(undefined)
    }
  }

  async function removeAccount(uuid: string) {
    if (!onLogoutAccount || busyAccount) return
    setBusyAccount(uuid)
    try {
      await onLogoutAccount(uuid)
    } finally {
      setBusyAccount(undefined)
    }
  }

  function joinOrCreateWorkspace(account: StackedAccountView) {
    if (account.active) {
      setCreating(true)
      return
    }
    if (!onSwitchAccount || busyAccount) return
    markPendingWorkspaceCreate(account.uuid)
    void switchAccount(account.uuid)
  }

  async function openInvite() {
    try {
      const directory = await accountHttp.accountGetWorkspaceDirectory()
      if (directory.permissions.invite_roles.length === 0) {
        notifyError("当前账号没有邀请成员权限。")
        return
      }
      setInviteRoles(directory.permissions.invite_roles)
      setInviteOpen(true)
    } catch (reason) {
      notifyCommandError(reason, "无法读取成员目录，请稍后重试。")
    }
  }

  async function createInvitation(request: CreateWorkspaceInvitationRequest) {
    return accountHttp.accountCreateWorkspaceInvitation(request)
  }

  /* A 「创建工作空间」 picked on another stacked account arrives here
     after the switch's reload — replay it as the create dialog once Cloud's
     standing is known. A different presented account means the switch never
     landed, so the stale intent is dropped instead of replayed later. */
  useEffect(() => {
    const pending = readPendingWorkspaceCreate()
    if (!pending) return
    const activeUuid = accounts.find((account) => account.active)?.uuid
    if (!activeUuid) return
    if (activeUuid !== pending) {
      clearPendingWorkspaceCreate()
      return
    }
    if (!standing) return
    clearPendingWorkspaceCreate()
    if (refusal) notifyError(refusal)
    else setCreating(true)
  }, [accounts, standing, refusal])

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) {
            sideRef.current = isMobile
              ? "top"
              : state === "collapsed"
                ? "right"
                : "top"
          }
          setOpen(next)
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                aria-label={
                  formatPlan(plan)
                    ? `账户与 Workspace ${workspaceName}，${formatPlan(plan)}，${accountRoleLabel}`
                    : `账户与 Workspace ${workspaceName}，${accountRoleLabel}`
                }
                /* Collapsed, this is one more cell of the rail's 36px column, so
                   it takes the same square as a nav row rather than sizing itself
                   to the mark it holds. */
                className={TRIGGER}
              />
            }
          >
            <IdentityMark
              kind="user"
              name={name ?? email ?? ""}
              role={session?.role}
              imageUrl={session?.avatar_url}
              className={MARK}
            />
            <WorkspaceIdentity
              name={workspaceName}
              plan={plan}
              roleLabel={roleLabel}
              nameClass="text-sm"
              className="group-data-[collapsible=icon]:hidden"
            />
            <ChevronsUpDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-faint-foreground transition-[color,transform] duration-200 ease-settle group-hover/workspace:text-muted-foreground group-data-[collapsible=icon]:hidden",
                open && "rotate-180 text-muted-foreground",
              )}
            />
          </TooltipTrigger>
          {/* Collapsed, the mark is the only thing left of the Workspace's identity —
              without this the rail opens on an unlabelled coloured square. */}
          <TooltipContent side="right" hidden={state !== "collapsed" || isMobile || open}>
            {[accountRoleLabel, workspaceName, formatPlan(plan), roleLabel].filter(Boolean).join(" · ")}
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent
          side={sideRef.current}
          align="start"
          sideOffset={8}
          className={SHELL}
        >
          {/* The head is the Workspace the trigger already names — the context
              comes first, the account is the muted row below the actions. */}
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <WorkspaceMark
              name={workspaceName}
              workspaceId={active?.id}
              workspaceIds={workspaceIds}
              imageUrl={active?.avatar_url}
              className={MENU_MARK}
            />
            <WorkspaceIdentity
              name={workspaceName}
              plan={plan}
              roleLabel={roleLabel}
              nameClass="text-sm"
            />
          </div>

          <DropdownMenuSeparator className="my-1.5 bg-border/60" />

          <DropdownMenuGroup className="flex flex-col gap-0.5">
            <DropdownMenuItem
              title="管理店铺与 Seller 密钥"
              onMouseEnter={() => preloadScreen("stores")}
              onFocus={() => preloadScreen("stores")}
              onClick={() => onOpenSpace("stores")}
              aria-current={spaceScreen === "stores" ? "page" : undefined}
              className={ACTION}
            >
              {/* Current page: the glyph takes the accent, the same rule
                  the rail rows use — focus:bg-accent stays free for focus
                  and never doubles as the "you are here" mark. */}
              <Store
                aria-hidden
                className={cn(spaceScreen === "stores" && "text-brand")}
              />
              {SCREEN_LABELS.stores}
            </DropdownMenuItem>
            {onOpenPlans ? (
              <DropdownMenuItem className={UPGRADE} onClick={onOpenPlans}>
                <CircleArrowUp aria-hidden />
                升级
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className={ACTION}
              onClick={() => setRedeemOpen(true)}
            >
              <Gift aria-hidden />
              兑换码
            </DropdownMenuItem>
            {canInvite ? (
              <DropdownMenuItem
                className={ACTION}
                onClick={() => void openInvite()}
              >
                <MailPlus aria-hidden />
                邀请成员
              </DropdownMenuItem>
            ) : null}
            {onAddAccount ? (
              <DropdownMenuItem className={ACTION} onClick={onAddAccount}>
                <UserPlus aria-hidden />
                添加账号
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>

          <DropdownMenuSeparator className="my-1.5 bg-border/60" />

          {/* The account stays one muted email row — the Workspaces under it
              are the account's, the way Notion nests a workspace list under
              its account row. The "…" holds the account-level actions. */}
          <div className="flex items-center gap-2.5 rounded-md bg-white py-1 pl-2.5 pr-1">
            <IdentityMark
              kind="user"
              name={name ?? email ?? ""}
              role={session?.role}
              imageUrl={session?.avatar_url}
              className={ACCOUNT_MARK}
            />
            <span
              className="min-w-0 flex-1 truncate font-mono text-compact text-muted-foreground"
              title={name && email ? `${name} · ${email}` : accountLabel}
            >
              {accountLabel}
            </span>
            <AccountActionsSubmenu
              email={accountLabel}
              joinOrCreateDisabled={!standing || Boolean(refusal)}
              onJoinOrCreate={() => setCreating(true)}
              onSignOut={() => void signOut()}
              signOutDisabled={busy}
              signOutLabel="退出登录"
            />
          </div>

          <DropdownMenuGroup className="flex flex-col gap-0.5">
            <DropdownMenuLabel className="sr-only">可切换的 Workspace</DropdownMenuLabel>
            {workspaces.length === 0 ? (
              <div className="px-1.5 py-1.5 text-compact text-muted-foreground">
                尚无可切换的 Workspace
              </div>
            ) : (
              workspaces.map((workspace) => {
                const isActive = workspace.id === active?.id
                const roleLine = formatRole(workspace.role)
                return (
                  /* Notion-style hover card: the row's own facts — plan badge
                     and roster size — restated as text the mark can't carry. */
                  <Tooltip key={workspace.id}>
                    <TooltipTrigger
                      render={
                        <DropdownMenuItem
                          disabled={
                            switchingTo !== undefined || (!isActive && !onSwitchWorkspace)
                          }
                          aria-current={isActive ? "true" : undefined}
                          onClick={() => {
                            if (isActive || !onSwitchWorkspace) {
                              setOpen(false)
                              return
                            }
                            setSwitchingTo(workspace.id)
                            void Promise.resolve(onSwitchWorkspace(workspace.id)).finally(() => {
                              setSwitchingTo(undefined)
                              setOpen(false)
                            })
                          }}
                          className={WORKSPACE_ROW}
                        />
                      }
                    >
                      <WorkspaceMark
                        name={workspace.name}
                        workspaceId={workspace.id}
                        workspaceIds={workspaceIds}
                        imageUrl={workspace.avatar_url}
                        className={MARK}
                      />
                      <WorkspaceIdentity
                        name={workspace.name}
                        plan={workspace.plan}
                        roleLabel={roleLine}
                        nameClass="text-compact"
                      />
                      {isActive ? (
                        <Check
                          aria-label="当前 Workspace"
                          className="size-3.5 shrink-0 text-brand-ink"
                        />
                      ) : switchingTo === workspace.id ? (
                        <Spinner
                          className="size-3.5 shrink-0"
                          aria-label="正在切换"
                        />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      <span className="flex flex-col items-start">
                        {formatPlan(workspace.plan) ? (
                          <span>{formatPlan(workspace.plan)}</span>
                        ) : null}
                        {workspace.member_count !== undefined ? (
                          <span>{workspace.member_count} 名成员</span>
                        ) : null}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                )
              })
            )}
            {standing ? (
              refusal ? (
                <div
                  role="note"
                  className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left"
                >
                  <Lock
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-faint-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-compact font-medium tracking-[-0.01em] text-muted-foreground">
                      创建工作空间
                    </span>
                    <span className="text-meta leading-normal text-faint-foreground">
                      {refusal}
                    </span>
                  </span>
                </div>
              ) : (
                <DropdownMenuItem
                  onClick={() => setCreating(true)}
                  className={cn(ACTION, "text-brand-ink")}
                >
                  <Plus aria-hidden />
                  创建工作空间
                </DropdownMenuItem>
              )
            ) : null}
          </DropdownMenuGroup>

          {otherAccounts.length > 0 ? (
            <>
              <DropdownMenuSeparator className="my-1.5 bg-border/60" />
              <DropdownMenuGroup className="flex flex-col gap-0.5">
                <DropdownMenuLabel className="sr-only">
                  其他已登录账号
                </DropdownMenuLabel>
                <StackedAccountItems
                  accounts={otherAccounts}
                  busyUuid={busyAccount}
                  onSwitch={onSwitchAccount ? switchAccount : undefined}
                  onRemove={onLogoutAccount ? removeAccount : undefined}
                  onJoinOrCreate={joinOrCreateWorkspace}
                  joinOrCreateDisabled={() => !onSwitchAccount}
                />
              </DropdownMenuGroup>
            </>
          ) : null}

          <DropdownMenuSeparator className="my-1.5 bg-border/60" />

          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            className={ACTION}
            onClick={() => void signOut()}
          >
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>创建工作空间</DialogTitle>
          </DialogHeader>
          <CreateWorkspaceForm
            inDialog
            onCreated={(next) => {
              setCreating(false)
              onWorkspaceCreated?.(next)
            }}
            onCancel={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>

      <WorkspaceInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={createInvitation}
        inviteRoles={inviteRoles}
      />

      <RedeemCodeDialog
        open={redeemOpen}
        onOpenChange={setRedeemOpen}
        canRedeem={active?.role === "owner"}
        workspaceUuid={active?.uuid}
        onOverviewChange={onOverviewChange}
      />
    </>
  )
}

/**
 * Why Cloud would refuse `account_create_workspace`, or `undefined` when it would
 * accept. Membership in other Workspaces never blocks creation (ADR-0098); the
 * owned-Workspace cap is per account — three free self-created Workspaces,
 * independent of any Plan.
 *
 * This is the only copy the operator ever reads for the rule here — the menu
 * item is disabled, so Cloud's own `WORKSPACE_LIMIT_REACHED` sentence is never
 * reached. The line therefore names the real way out: an at-cap owner
 * dissolves an owned Workspace to free the slot. Upgrading a Plan happens
 * inside a Workspace and never enters this decision.
 */
export function createWorkspaceRefusal(
  standing: WorkspaceStandingView,
): string | undefined {
  if (standing.owned_count < standing.owned_limit) return undefined
  return `自建工作空间已达上限（${standing.owned_count}/${standing.owned_limit}）；解散一个不再使用的自建空间可腾出名额，或换一个邮箱注册。`
}

function WorkspaceIdentity({
  name,
  plan,
  roleLabel,
  nameClass,
  className,
}: {
  name: string
  plan?: string
  roleLabel?: string
  nameClass: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 flex-col justify-center gap-0.5",
        className,
      )}
    >
      <span
        className={cn(
          "min-w-0 truncate leading-tight font-medium tracking-[-0.01em]",
          nameClass,
        )}
        title={name}
      >
        {name}
      </span>
      {plan || roleLabel ? (
        <span className="flex min-w-0 items-center gap-1.5 text-meta leading-none text-faint-foreground">
          {roleLabel ? <span className="truncate">{roleLabel}</span> : null}
          <PlanMark plan={plan} />
        </span>
      ) : null}
    </span>
  )
}

export function WorkspaceMark({
  name,
  workspaceId,
  workspaceIds,
  imageUrl,
  editable,
  disabled,
  inputId,
  onPick,
  className,
}: {
  name: string
  workspaceId?: number
  workspaceIds?: readonly number[]
  imageUrl?: string
  editable?: boolean
  disabled?: boolean
  inputId?: string
  onPick?: (image: Blob, signal?: AbortSignal) => void | Promise<void>
  className?: string
}) {
  return (
    <IdentityMark
      kind="workspace"
      name={name}
      workspaceId={workspaceId}
      workspaceIds={workspaceIds}
      imageUrl={imageUrl}
      editable={editable}
      disabled={disabled}
      inputId={inputId}
      onPick={onPick}
      className={className}
    />
  )
}

/**
 * The Notion-style "…" an account row carries: 创建工作空间 first (加入他人
 * 工作空间只能走邀请，见创建弹窗指引；该入口只创建), the account's sign-out
 * second. Shared by the muted active-account row and every stacked row in the
 * rail menu.
 */
function AccountActionsSubmenu({
  email,
  disabled,
  joinOrCreateDisabled,
  onJoinOrCreate,
  onSignOut,
  signOutDisabled,
  signOutLabel,
}: {
  email: string
  disabled?: boolean
  joinOrCreateDisabled?: boolean
  onJoinOrCreate?: () => void
  onSignOut?: () => void
  signOutDisabled?: boolean
  signOutLabel: string
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        chevron={false}
        disabled={disabled}
        label={email}
        aria-label={`账号 ${email} 的更多操作`}
        title="更多操作"
        className={ACCOUNT_MORE}
      >
        <Ellipsis aria-hidden className="size-3.5" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={6}
        className="flex flex-col gap-0.5 p-1.5"
      >
        {onJoinOrCreate ? (
          <DropdownMenuItem
            className={ACTION}
            disabled={joinOrCreateDisabled}
            onClick={onJoinOrCreate}
          >
            <Plus aria-hidden />
            创建工作空间
          </DropdownMenuItem>
        ) : null}
        {onSignOut ? (
          <DropdownMenuItem
            variant="destructive"
            className={ACTION}
            disabled={signOutDisabled}
            onClick={onSignOut}
          >
            <LogOut aria-hidden />
            {signOutLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * One compact row per account on this browser's session stack — mark, email,
 * the active one checked; clicking another row switches to it. With
 * `onJoinOrCreate` each row carries the "…" submenu (创建工作空间, then 登出); without it the row keeps a plain sign-out button for the
 * no-Workspace gate's leaner menu. Shared between the rail menu and the
 * gate's account menu.
 */
export function StackedAccountItems({
  accounts,
  busyUuid,
  onSwitch,
  onRemove,
  onJoinOrCreate,
  joinOrCreateDisabled,
}: {
  accounts: StackedAccountView[]
  busyUuid?: string
  onSwitch?: (uuid: string) => void
  onRemove?: (uuid: string) => void
  onJoinOrCreate?: (account: StackedAccountView) => void
  /** Per-row veto for 创建工作空间 — e.g. the active account's Cloud refusal. */
  joinOrCreateDisabled?: (account: StackedAccountView) => boolean
}) {
  return (
    <>
      {accounts.map((account) => {
        const switching = busyUuid === account.uuid
        return (
          <div key={account.uuid} className="flex items-center gap-0.5 pr-1">
            <DropdownMenuItem
              disabled={switching}
              aria-current={account.active ? "true" : undefined}
              className={cn(WORKSPACE_ROW, "min-w-0 flex-1")}
              onClick={() => {
                if (!account.active) onSwitch?.(account.uuid)
              }}
            >
              <IdentityMark
                kind="user"
                name={account.name || account.email}
                imageUrl={account.avatar_url ?? undefined}
                className={ACCOUNT_MARK}
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-compact text-muted-foreground"
                title={
                  account.name
                    ? `${account.name} · ${account.email}`
                    : account.email
                }
              >
                {account.email}
              </span>
              {account.active ? (
                <Check
                  aria-label="当前账号"
                  className="size-3.5 shrink-0 text-brand-ink"
                />
              ) : switching ? (
                <Spinner className="size-3.5 shrink-0" aria-label="正在切换" />
              ) : null}
            </DropdownMenuItem>
            {onJoinOrCreate ? (
              <AccountActionsSubmenu
                email={account.email}
                disabled={switching}
                joinOrCreateDisabled={joinOrCreateDisabled?.(account)}
                onJoinOrCreate={() => onJoinOrCreate(account)}
                onSignOut={
                  onRemove ? () => onRemove(account.uuid) : undefined
                }
                signOutDisabled={switching}
                signOutLabel={account.active ? "退出登录" : "退出该账号"}
              />
            ) : !account.active && !switching && onRemove ? (
              <button
                type="button"
                aria-label={`退出账号 ${account.email}`}
                title="退出该账号"
                className={ACCOUNT_MORE}
                /* Beside the row, not inside it — the click never reaches the
                   item, so the menu stays open and the list updates in place. */
                onClick={() => onRemove(account.uuid)}
              >
                <LogOut aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/** Local overview patch for Vite preview / tests when Cloud is unavailable. */
export function applyLocalWorkspaceSwitch(
  overview: AccountOverview,
  workspaceId: number
): AccountOverview {
  const workspace = overview.workspaces.find((entry) => entry.id === workspaceId)
  if (!workspace || overview.active_workspace?.id === workspaceId) return overview
  return {
    ...overview,
    active_workspace: workspace,
    entitlement: overview.entitlement
      ? { ...overview.entitlement, plan: workspace.plan }
      : overview.entitlement,
  }
}
