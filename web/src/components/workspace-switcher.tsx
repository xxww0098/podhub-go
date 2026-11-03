import { useRef, useState } from "react"
import { Building2, Check, ChevronsUpDown, CircleArrowUp, Gift, Lock, LogOut, Plus, Settings } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type {
  AccountOverview,
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
import { RedeemCodeDialog } from "@/features/plans/redeem-code-dialog"
import { notifyCommandError } from "@/lib/notify"
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
  "group/workspace flex h-14 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-2.5 text-left text-sidebar-foreground transition-colors outline-none group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-popup-open:bg-sidebar-accent"
const SHELL = "w-60 border border-border/80 p-1.5 rounded-lg"
const WORKSPACE_ROW = "cursor-pointer items-center gap-2.5 px-2.5 py-2"
const ACTION =
  "cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium tracking-[-0.01em] hover:bg-accent/80 focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:[&_svg]:text-accent-foreground not-data-[variant=destructive]:[&_svg]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10"
const UPGRADE =
  "cursor-pointer items-center gap-2.5 px-2.5 py-2 text-compact font-medium tracking-[-0.01em] text-brand-ink hover:bg-accent/80 focus:bg-accent focus:text-brand-ink [&_svg]:text-brand"
const MARK = "size-7 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]"
const MENU_MARK = "size-8 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]"
const CARD = "rounded-lg border border-border/60 bg-muted/20 p-1"

/** Workspace switching and actions belong to the header; account actions stay in the footer. */
export function WorkspaceMenu({
  overview,
  standing,
  onOpenSpace,
  spaceScreen,
  onSwitchWorkspace,
  onWorkspaceCreated,
  onOpenPlans,
  onOverviewChange,
}: {
  overview?: AccountOverview
  standing?: WorkspaceStandingView
  onOpenSpace: (screen: WorkspaceSpaceScreen) => void
  spaceScreen?: WorkspaceSpaceScreen
  onSwitchWorkspace?: (workspaceId: number) => void | Promise<void>
  onWorkspaceCreated?: (standing: WorkspaceStandingView) => void
  onOpenPlans?: () => void
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  const { state, isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<number>()
  const [redeemOpen, setRedeemOpen] = useState(false)
  // Lock placement for the open session — collapsing the rail mid-menu must
  // not flip top↔right and make the popup jump.
  const sideRef = useRef<MenuSide>("bottom")
  const refusal = standing ? createWorkspaceRefusal(standing) : undefined
  const entitlement = overview?.entitlement
  const workspaces = overview?.workspaces ?? []
  const workspaceIds = workspaces.map((workspace) => workspace.id)
  const active =
    overview?.active_workspace ??
    workspaces.find((workspace) => workspace.is_owned) ??
    workspaces[0]

  const workspaceName = active?.name ?? "未选择工作空间"
  const plan = active?.plan ?? entitlement?.plan
  const roleLabel = formatRole(active?.role)

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) {
            sideRef.current = isMobile
              ? "bottom"
              : state === "collapsed"
                ? "right"
                : "bottom"
          }
          setOpen(next)
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                aria-label={
                  active
                    ? formatPlan(plan)
                      ? `工作空间 ${workspaceName}，${formatPlan(plan)}`
                      : `工作空间 ${workspaceName}`
                    : "未选择工作空间"
                }
                className={cn(TRIGGER, "shell-workspace-trigger border-sidebar-border bg-background")}
              />
            }
          >
            {active ? (
              <WorkspaceMark
                name={workspaceName}
                workspaceId={active.id}
                workspaceIds={workspaceIds}
                imageUrl={active.avatar_url}
                className="shell-workspace-avatar size-8 shrink-0 shadow-[inset_0_0_0_1px_var(--border)] group-data-[collapsible=icon]:size-7"
              />
            ) : (
              <span
                aria-hidden
                className="shell-workspace-avatar flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground group-data-[collapsible=icon]:size-7"
              >
                <Building2 className="size-4" />
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <span className="shell-workspace-name truncate text-sm font-semibold leading-5" title={workspaceName}>{workspaceName}</span>
              <span className="shell-workspace-meta flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {active ? <PlanMark plan={plan} /> : null}
                <span className="truncate">{active ? roleLabel ?? "工作空间" : "创建或选择后开始"}</span>
              </span>
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
            />
          </TooltipTrigger>
          {/* Collapsed, the mark is the only thing left of the Workspace's identity —
              without this the rail opens on an unlabelled coloured square. */}
          <TooltipContent side="right" hidden={state !== "collapsed" || isMobile || open}>
            {active
              ? [workspaceName, formatPlan(plan), roleLabel].filter(Boolean).join(" · ")
              : "未选择工作空间"}
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent
          side={sideRef.current}
          align="start"
          sideOffset={8}
          className={SHELL}
        >
          {/* Two cards: actions for the current space, then the shared
              switcher. The trigger already names the current space. */}
          <div className={CARD}>
            {active ? (
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
                  <StoreIcon
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
              </DropdownMenuGroup>
            ) : (
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-border/80 bg-background text-muted-foreground">
                  <Building2 className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium leading-tight">尚未选择工作空间</span>
                  <span className="truncate text-xs text-muted-foreground">创建或选择空间以开始</span>
                </div>
              </div>
            )}
          </div>

          <div className={cn(CARD, "mt-1.5")}>
            <DropdownMenuGroup className="flex flex-col gap-0.5">
              <DropdownMenuLabel className="px-2.5 py-1 text-meta font-medium text-faint-foreground">所有空间</DropdownMenuLabel>
              {workspaces.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-3 text-center">
                  <p className="text-xs font-medium text-foreground">暂无可切换的工作空间</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">创建新空间以开启店铺与上架管理</p>
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
                            aria-label="当前工作空间"
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
          </div>

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

export function AccountMenu({
  overview,
  onSignedOut,
  onOpenSettings,
}: {
  overview?: AccountOverview
  onSignedOut: () => void
  onOpenSettings?: () => void
}) {
  const { state, isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const sideRef = useRef<MenuSide>("top")
  const session = overview?.session
  const name = session?.name?.trim() || undefined
  const email = session?.email?.trim() || undefined
  const accountLabel = email ?? name ?? "未登录"
  const accountName = name ?? email ?? "未登录"
  const accountRoleLabel = platformRoleLabel(session?.role)

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

  return (
    <div className="shell-account-card">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) sideRef.current = !isMobile && state === "collapsed" ? "right" : "top"
          setOpen(next)
        }}
      >
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger aria-label={`账户 ${accountLabel}，${accountRoleLabel || "未知角色"}`} className={cn(TRIGGER, "shell-account-trigger")} />}>
            <IdentityMark kind="user" name={accountName} role={session?.role} imageUrl={session?.avatar_url} className="shell-account-avatar size-8 shrink-0 rounded-full group-data-[collapsible=icon]:size-6" />
            <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <span className="shell-account-name truncate text-sm font-medium leading-5" title={accountName}>{accountName}</span>
              <span className="shell-account-role truncate text-xs leading-4 text-muted-foreground">{accountRoleLabel || "未知角色"}</span>
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </TooltipTrigger>
          <TooltipContent side="right" hidden={state !== "collapsed" || isMobile || open}>
            {[accountName, email, accountRoleLabel].filter(Boolean).join(" · ")}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side={sideRef.current} align="start" sideOffset={8} className={SHELL}>
          <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/30 p-2.5">
            <div className="flex items-center gap-2.5">
              <IdentityMark kind="user" name={accountName} role={session?.role} imageUrl={session?.avatar_url} className={MENU_MARK} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-compact font-medium" title={accountName}>{accountName}</span>
                {email ? <span className="truncate font-mono text-meta text-muted-foreground" title={email}>{email}</span> : null}
              </span>
            </div>
            {accountRoleLabel ? (
              <div className="flex items-center justify-between border-t border-border/40 pt-1.5 text-xs">
                <span className="text-meta text-muted-foreground">当前权限</span>
                <span className="inline-flex items-center rounded-md bg-background px-1.5 py-0.5 text-meta font-medium text-foreground ring-1 ring-inset ring-border/60">
                  {accountRoleLabel}
                </span>
              </div>
            ) : null}
          </div>
          <DropdownMenuSeparator className="my-1.5 bg-border/60" />
          <DropdownMenuGroup className="flex flex-col gap-0.5">
            {onOpenSettings ? (
              <DropdownMenuItem className={ACTION} onClick={() => onOpenSettings()}>
                <Settings aria-hidden />设置
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" disabled={busy} className={ACTION} onClick={() => void signOut()}>
              <LogOut aria-hidden />退出登录
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
