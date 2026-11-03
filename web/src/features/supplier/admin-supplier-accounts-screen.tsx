/**
 * 平台管理中的工厂、成员和授权。
 *
 * 工厂和成员按工厂分组。开通与重置密码 = `super_admin`（服务端把守，
 * 界面只按会话角色收放入口）；停用、启用与解绑也由 `super_admin` 执行。开通/重置
 * 的一次性初始密码只在确认对话框里回显一次——关掉就再也拿不到，界面用
 * 复制按钮帮管理员转交。拒绝走 toast，页面保留读取和待核实状态。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { ChevronLeft, ChevronRight, Copy, Ellipsis, KeyRound, Plus, RefreshCw, Search, Settings2, Trash2, UserPlus } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
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
import { factoriesHttp, type Factory } from "@/bindings/http-factories"
import { EMPTY_FACTORY, FactoryFormDialog, type FactoryEditor } from "./factory-form-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IdentityMark } from "@/components/identity-mark"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
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
import { copyToClipboard } from "@/lib/clipboard"

const GROUPS_PER_PAGE = 3

export function mergeSupplierGroups(factories: Factory[], groups: SupplierAccountsGroup[]): SupplierAccountsGroup[] {
  const byFactory = new Map(groups.map((group) => [group.factory.factory_id, group]))
  return factories.map((factory) => ({
    factory: { factory_id: factory.factoryId, name: factory.name, country: factory.country, icon: factory.icon },
    members: byFactory.get(factory.factoryId)?.members ?? [],
  }))
}

export function filterSupplierGroups(groups: SupplierAccountsGroup[], query: string): SupplierAccountsGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return groups
  return groups.flatMap((group) => {
    if ((group.factory.name || group.factory.factory_id).toLocaleLowerCase().includes(needle)) return [group]
    const members = group.members.filter((member) =>
      member.email.toLocaleLowerCase().includes(needle) || (member.name ?? "").toLocaleLowerCase().includes(needle),
    )
    return members.length ? [{ ...group, members }] : []
  })
}

const RESET_PENDING_PREFIX = "supplier-account-password-reset-pending:"
// shortcut: 本机标记无法协调跨设备重置；需要跨设备防重复时改为服务端幂等和结果对账。

/** Only explicit pre-write refusals are safe to retry. All other errors may follow a commit. */
export function isConfirmedResetRefusal(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false
  const error = reason as { code?: unknown; serverCode?: unknown; status?: unknown; message?: unknown; remediation?: unknown }
  if (typeof error.serverCode !== "string" || typeof error.message !== "string" || !error.message.trim() || error.remediation !== null) return false
  if (error.message === `云端请求失败（HTTP ${error.status}）`) return false
  const serverCode = error.serverCode.toLowerCase()
  return (error.status === 400 && error.code === "cloud_validation" && serverCode === "validation") ||
    (error.status === 401 && error.code === "unauthenticated" && serverCode === "auth_invalid") ||
    (error.status === 403 && error.code === "cloud_forbidden" && serverCode === "forbidden") ||
    (error.status === 404 && error.code === "cloud_not_found" && serverCode === "not_found") ||
    (error.status === 409 && error.code === "cloud_conflict" && serverCode === "conflict") ||
    (error.status === 503 && error.code === "cloud_writes_disabled" && serverCode === "writes_disabled")
}

/** Persist member IDs only, never passwords, so tabs cannot silently retry an in-flight reset. */
function resetPendingMembers(): string[] | null {
  try {
    const ids: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(RESET_PENDING_PREFIX)) ids.push(decodeURIComponent(key.slice(RESET_PENDING_PREFIX.length)))
    }
    return ids
  } catch {
    return null
  }
}

function acquireResetPending(memberId: string): "acquired" | "pending" | "unavailable" {
  try {
    const key = RESET_PENDING_PREFIX + encodeURIComponent(memberId)
    if (localStorage.getItem(key) !== null) return "pending"
    localStorage.setItem(key, "1")
    return "acquired"
  } catch {
    return "unavailable"
  }
}

function clearResetPending(memberId: string): boolean {
  try {
    localStorage.removeItem(RESET_PENDING_PREFIX + encodeURIComponent(memberId))
    return true
  } catch {
    return false
  }
}

function preserveResetPending(memberId: string): boolean {
  try {
    localStorage.setItem(RESET_PENDING_PREFIX + encodeURIComponent(memberId), "1")
    return true
  } catch {
    return false
  }
}

export function SupplierAccountsScreen({
  overview,
  embedded = false,
}: {
  overview: AccountOverview
  /** Render inside the settings pane, whose own heading already names the page. */
  embedded?: boolean
}) {
  const superAdmin = isPlatformSuperAdminRole(overview.session.role)
  const [factories, setFactories] = useState<Factory[]>([])
  const [groups, setGroups] = useState<SupplierAccountsGroup[]>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [createSource, setCreateSource] = useState<SupplierAccountsGroup["factory"]>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [editor, setEditor] = useState<FactoryEditor | null>(null)
  const [factoryBusy, setFactoryBusy] = useState(false)
  const [deletingFactory, setDeletingFactory] = useState<Factory | null>(null)
  const [unboundId, setUnboundId] = useState<string>()
  /** 重置密码的目标成员；对话框里可自定义密码，留空才自动生成。 */
  const [resetTarget, setResetTarget] = useState<SupplierAccountMemberView>()
  /** null means another tab or a prior visit owns the password. */
  const [unknownResets, setUnknownResets] = useState<Record<string, string | null>>(() =>
    Object.fromEntries((resetPendingMembers() ?? []).map((id) => [id, null])),
  )
  /** 一次性密码回显：只在这里出现一次，关闭即清空。 */
  const [issuedPassword, setIssuedPassword] = useState<{
    email: string
    password: string
  }>()

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [accounts, directory] = await Promise.all([listSupplierAccounts(), factoriesHttp.list()])
      setFactories(directory.factories)
      setGroups(accounts.groups)
      const availableIds = new Set(accounts.groups.flatMap((group) => group.members.map((member) => member.member_id)))
      setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))))
      setLoadFailed(false)
    } catch (reason) {
      notifyCommandError(reason, "工厂或成员列表读取失败，请稍后重试。")
      setLoadFailed(true)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const syncResetMarkers = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(RESET_PENDING_PREFIX)) return
      const ids = resetPendingMembers()
      if (!ids) return
      setUnknownResets((current) => {
        const next = { ...current }
        for (const id of ids) if (!Object.hasOwn(next, id)) next[id] = null
        // Keep this tab's password until its own operator has acknowledged it.
        for (const id of Object.keys(next)) if (!ids.includes(id) && next[id] === null) delete next[id]
        return next
      })
    }
    window.addEventListener("storage", syncResetMarkers)
    return () => window.removeEventListener("storage", syncResetMarkers)
  }, [])

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
        if (!navigator.locks) {
          notifyError("当前浏览器不支持安全重置锁，请使用桌面应用或支持安全锁的浏览器。")
          return "rejected" as const
        }
        return await navigator.locks.request(RESET_PENDING_PREFIX + encodeURIComponent(member.member_id), { ifAvailable: true }, async (lock) => {
          if (!lock) {
            notifyError("另一个标签页正在处理该成员的密码，请等待结果并核实。")
            return "rejected" as const
          }
          const marker = acquireResetPending(member.member_id)
          if (marker === "pending") {
            setUnknownResets((current) => ({ ...current, [member.member_id]: current[member.member_id] ?? null }))
            return "unknown" as const
          }
          if (marker === "unavailable") {
            notifyError("无法保存重置核实标记，请检查浏览器存储后重试。")
            return "rejected" as const
          }
          try {
            await patchSupplierAccount(member.member_id, { password })
            if (!clearResetPending(member.member_id)) notifyError("密码已重置，但无法清除核实标记，请检查浏览器存储。")
            setIssuedPassword({ email: member.email, password })
            await refresh()
            return "success" as const
          } catch (reason) {
            if (isConfirmedResetRefusal(reason)) {
              if (!clearResetPending(member.member_id)) notifyError("无法清除重置核实标记，请检查浏览器存储。")
              notifyCommandError(reason, "密码重置被拒绝。")
              return "rejected" as const
            }
            if (!preserveResetPending(member.member_id)) notifyError("无法保存核实标记，离开页面后可能无法阻止重复重置。")
            setUnknownResets((current) => ({ ...current, [member.member_id]: password }))
            return "unknown" as const
          }
        })
      } catch {
        notifyError("无法获取安全重置锁，请检查浏览器后重试。")
        return "rejected" as const
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
  const factoryGroups = groups ? mergeSupplierGroups(factories, groups) : undefined
  const visibleGroups = filterSupplierGroups(factoryGroups ?? [], query)
  const pageCount = Math.max(1, Math.ceil(visibleGroups.length / GROUPS_PER_PAGE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageGroups = visibleGroups.slice(currentPage * GROUPS_PER_PAGE, (currentPage + 1) * GROUPS_PER_PAGE)
  const selectedMembers = pageGroups.flatMap((group) => group.members).filter((member) => selectedIds.has(member.member_id))

  const selectMembers = (members: SupplierAccountMemberView[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const member of members) {
        if (selected) next.add(member.member_id)
        else next.delete(member.member_id)
      }
      return next
    })
  }

  const editFactory = (factory: Factory) => setEditor({ factoryId: factory.factoryId, draft: {
    name: factory.name, country: factory.country, contact: factory.contact, internalNote: factory.internalNote, icon: factory.icon,
  } })

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3" : "flex min-h-0 flex-1 flex-col gap-3"}>
      <div
        className={
          "flex shrink-0 flex-wrap items-center gap-2"
        }
      >
        {embedded ? null : (
          <h1 className="sr-only">工厂管理</h1>
        )}
        <InputGroup className="h-11 min-w-0 flex-1 basis-36 max-md:[&_input]:min-h-11">
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="搜索工厂或成员" placeholder="搜索工厂、成员邮箱或名称" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); setSelectedIds(new Set()) }} />
        </InputGroup>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            aria-label={refreshing ? "正在读取工厂管理" : "刷新工厂管理"}
            aria-busy={refreshing}
            variant="outline"
            size="icon"
            disabled={refreshing}
            onClick={() => void refresh()}
          >{refreshing ? <Spinner aria-hidden /> : <RefreshCw aria-hidden />}</Button>
          {superAdmin ? <Button
            type="button"
            aria-label="新增工厂"
            variant="brand"
            size="lg"
            disabled={groups === undefined || loadFailed || refreshing}
            onClick={() => setEditor({ draft: { ...EMPTY_FACTORY } })}
          ><Plus data-icon="inline-start" />新增工厂</Button> : null}
        </div>
      </div>
      <SupplierAccountsReadNotice groups={factoryGroups} failed={loadFailed} refreshing={refreshing} onRetry={() => void refresh()} />
      {factoryGroups && factoryGroups.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-3">
          {visibleGroups.length === 0 ? <SupplierAccountsEmpty filtered /> : null}
          {pageGroups.map((group) => {
            const factory = factories.find((item) => item.factoryId === group.factory.factory_id)
            return (
            <section
              key={group.factory.factory_id}
              className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
            >
              <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-4">
                <StoreIcon aria-hidden className="size-5 shrink-0 text-brand" />
                <span className="min-w-0 truncate font-semibold" title={group.factory.name || group.factory.factory_id}>
                  {group.factory.name || group.factory.factory_id}
                </span>
                <Badge variant="brand">{group.members.length} 位成员</Badge>
                {factory?.contact ? <span className="text-meta text-muted-foreground">{factory.contact}</span> : null}
                {factory && superAdmin ? <div className="flex w-full flex-wrap items-center gap-0.5 sm:ml-auto sm:w-auto">
                  <Button type="button" variant="ghost" size="sm" aria-label={`开通厂家成员 ${factory.name}`} disabled={loadFailed || refreshing} onClick={(event) => { createButtonRef.current = event.currentTarget; setCreateSource(group.factory) }}><UserPlus aria-hidden />开通成员</Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`配置工厂 ${factory.name}`} disabled={loadFailed || refreshing} onClick={() => editFactory(factory)}><Settings2 aria-hidden />配置</Button>
                  <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`工厂操作 ${factory.name}`} disabled={loadFailed || refreshing} />}><Ellipsis aria-hidden /></DropdownMenuTrigger><DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={() => setDeletingFactory(factory)}><Trash2 aria-hidden />删除工厂</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>
                </div> : null}
              </header>
              <Table
                variant="directory"
                className="min-w-3xl table-fixed"
                containerClassName="overflow-x-auto"
                aria-label={`厂家 ${group.factory.name} 的成员`}
              >
                <SupplierAccountsTableHead group={group} selectedIds={selectedIds} onSelect={selectMembers} />
                <TableBody>
                  {group.members.map((member) => (
                    <TableRow key={member.member_id}>
                      <TableCell><Checkbox aria-label={`选择 ${member.email}`} checked={selectedIds.has(member.member_id)} onCheckedChange={(checked) => selectMembers([member], checked === true)} /></TableCell>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2">
                          <IdentityMark kind="user" name={member.name ?? member.email} className="size-8 shrink-0" />
                          <span className="block max-w-72 truncate text-muted-foreground" title={member.email}>{member.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-48 truncate" title={member.name ?? undefined}>{member.name ?? "—"}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={member.status === "active" ? "good" : "secondary"}>
                            <span aria-hidden className={member.status === "active" ? "size-1.5 rounded-full bg-st-good" : "size-1.5 rounded-full bg-muted-foreground"} />
                            {member.status === "active" ? "已开通" : member.status === "disabled" ? "已停用" : "状态未知"}
                          </Badge>
                          <Switch
                            size="sm"
                            className="max-md:after:-inset-y-4"
                            checked={member.status === "active"}
                            disabled={!superAdmin || pendingIds.has(member.member_id) || (member.status !== "active" && member.status !== "disabled")}
                            aria-label={`${member.email}：启用`}
                            onCheckedChange={(checked) =>
                              void toggleStatus(member, checked === true)
                            }
                          />
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
                        {formatDateTimeShort(member.created_at_ms)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {superAdmin ? (
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              disabled={pendingIds.has(member.member_id)}
                              onClick={() => setResetTarget(member)}
                            >
                              {Object.hasOwn(unknownResets, member.member_id) ? "查看重置结果" : "重置密码"}
                            </Button>
                          ) : null}
                          {superAdmin ? <Button
                            type="button"
                            aria-label={`解绑 ${member.email}`}
                            variant="link"
                            size="sm"
                            disabled={pendingIds.has(member.member_id)}
                            onClick={() => setUnboundId(member.member_id)}
                          >解绑</Button> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!group.members.length ? <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">尚未开通工厂成员</TableCell></TableRow> : null}
                </TableBody>
              </Table>
            </section>
          )})}
          <div className="flex flex-wrap items-center gap-2 px-1 text-sm text-muted-foreground">
            <p className="flex-1">当前结果 {visibleGroups.length} 家工厂，{visibleGroups.reduce((count, group) => count + group.members.length, 0)} 位成员</p>
            {selectedMembers.length > 0 ? <Button type="button" variant="outline" size="sm" onClick={() => void copyToClipboard(selectedMembers.map((member) => member.email).join("\n"), { success: `已复制 ${selectedMembers.length} 个邮箱`, failure: "无法复制邮箱" })}><Copy data-icon="inline-start" />复制邮箱（{selectedMembers.length}）</Button> : null}
            <IconButton icon={ChevronLeft} label="上一页" variant="outline" size="icon-sm" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedIds(new Set()) }} />
            <span aria-label={`第 ${currentPage + 1} 页，共 ${pageCount} 页`} className="px-2 tabular-nums">{currentPage + 1}</span>
            <IconButton icon={ChevronRight} label="下一页" variant="outline" size="icon-sm" disabled={currentPage >= pageCount - 1} onClick={() => { setPage(currentPage + 1); setSelectedIds(new Set()) }} />
          </div>
        </div>
      ) : null}
      <AdminSupplierWithdrawals />
      <CreateMemberDialog
        source={createSource}
        returnFocusRef={createButtonRef}
        onClose={() => setCreateSource(undefined)}
        onCreated={(email, password) => {
          setCreateSource(undefined)
          if (password) setIssuedPassword({ email, password })
          else notifySuccess("已绑定既有账号为厂家成员")
          void refresh()
        }}
      />
      <FactoryFormDialog editor={editor} busy={factoryBusy} onClose={() => setEditor(null)}
        onChange={(draft) => setEditor((current) => current ? { ...current, draft } : null)} onSubmit={() => void (async () => {
          if (!editor || factoryBusy) return
          setFactoryBusy(true)
          try {
            if (editor.factoryId) {
              await factoriesHttp.update(editor.factoryId, editor.draft)
              notifySuccess("工厂资料已保存")
            } else {
              const result = await factoriesHttp.create(editor.draft)
              if (result.initialPassword) setIssuedPassword({ email: editor.draft.accountEmail?.trim() ?? "", password: result.initialPassword })
              else notifySuccess("已绑定既有账号为工厂成员")
              setQuery(""); setPage(0)
            }
            setEditor(null)
            await refresh()
          } catch (reason) { notifyCommandError(reason, "保存工厂失败") }
          finally { setFactoryBusy(false) }
        })()} />
      <ConfirmDialog open={deletingFactory !== null} onOpenChange={(open) => { if (!open && !factoryBusy) setDeletingFactory(null) }} title={`删除工厂「${deletingFactory?.name || ""}」？`}
        description="已绑定商品库的工厂不能删除。删除后成员将失去此工厂的访问权限。" confirmText="删除工厂" busy={factoryBusy} onConfirm={async () => {
          if (!deletingFactory || factoryBusy) return
          setFactoryBusy(true)
          try { await factoriesHttp.delete(deletingFactory.factoryId); setDeletingFactory(null); notifySuccess("工厂已删除"); await refresh() }
          catch (reason) { notifyCommandError(reason, "删除工厂失败") }
          finally { setFactoryBusy(false) }
        }} />
      <ResetPasswordDialog
        target={resetTarget}
        unknownPassword={resetTarget ? unknownResets[resetTarget.member_id] : undefined}
        onClose={() => setResetTarget(undefined)}
        onReset={resetPassword}
        onReconciled={(memberId) => {
          if (!clearResetPending(memberId)) {
            notifyError("无法解除限制，请检查浏览器存储。")
            return
          }
          setUnknownResets((current) => {
            const next = { ...current }
            delete next[memberId]
            return next
          })
        }}
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

export function SupplierAccountsReadNotice({ groups, failed, refreshing, onRetry }: {
  groups?: SupplierAccountsGroup[]
  failed: boolean
  refreshing: boolean
  onRetry: () => void
}) {
  if (failed) {
    const hasRecords = Boolean(groups?.length)
    return (
      <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <div className="text-sm">
          <p className="font-medium">{hasRecords ? "工厂管理刷新失败" : "工厂管理未能读取"}</p>
          <p className="mt-1 text-muted-foreground">{hasRecords
            ? "以下为上次读取的记录，请重新读取后再操作。"
            : "暂时无法确认工厂和成员，请重新读取后再操作。"}</p>
        </div>
        <Button
          type="button"
          aria-label={refreshing ? "正在重新读取" : "重新读取"}
          aria-busy={refreshing}
          variant="outline"
          size="icon-sm"
          disabled={refreshing}
          onClick={onRetry}
        >{refreshing ? <Spinner aria-hidden /> : <RefreshCw aria-hidden />}</Button>
      </div>
    )
  }
  if (groups === undefined) {
    return <div className="flex min-h-40 items-center justify-center"><Spinner className="size-5" aria-label="正在读取工厂管理" /></div>
  }
  if (groups.length === 0) {
    return <SupplierAccountsEmpty />
  }
  return null
}

function SupplierAccountsTableHead({ group, selectedIds, onSelect }: {
  group?: SupplierAccountsGroup
  selectedIds?: ReadonlySet<string>
  onSelect?: (members: SupplierAccountMemberView[], selected: boolean) => void
} = {}) {
  const members = group?.members ?? []
  const selectedCount = members.filter((member) => selectedIds?.has(member.member_id)).length
  return <TableHeader className="sticky top-0 z-10 bg-brand-soft/40"><TableRow className="hover:bg-transparent">
    <TableHead className="w-10"><Checkbox aria-label={`选择${group?.factory.name || "厂家"}全部成员`} checked={members.length > 0 && selectedCount === members.length} indeterminate={selectedCount > 0 && selectedCount < members.length} disabled={!onSelect || members.length === 0} onCheckedChange={(checked) => onSelect?.(members, checked === true)} /></TableHead>
    <TableHead className="w-[27%]">成员邮箱</TableHead>
    <TableHead className="w-[13%]">名称</TableHead>
    <TableHead className="w-[16%]">状态</TableHead>
    <TableHead className="w-[22%]">开通时间</TableHead>
    <TableHead className="w-[22%] text-right">操作</TableHead>
  </TableRow></TableHeader>
}

function SupplierAccountsEmpty({ filtered = false }: { filtered?: boolean }) {
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
    <Table variant="directory" className="min-w-3xl table-fixed" containerClassName="shrink-0" aria-label="厂家成员">
      <SupplierAccountsTableHead />
    </Table>
    <div role="status" className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      <KeyRound aria-hidden className="size-5" />
      {filtered ? "没有匹配的工厂或成员" : "还没有工厂。新增工厂后可以开通成员账号。"}
    </div>
  </section>
}

function ResetPasswordDialog({
  target,
  unknownPassword,
  onClose,
  onReset,
  onReconciled,
}: {
  target?: SupplierAccountMemberView
  unknownPassword?: string | null
  onClose: () => void
  onReset: (member: SupplierAccountMemberView, password: string) => Promise<"success" | "rejected" | "unknown">
  onReconciled: (memberId: string) => void
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [reconciled, setReconciled] = useState(false)
  const [copied, setCopied] = useState(false)
  const busyRef = useRef(false)
  const resultUnknown = unknownPassword !== undefined

  useEffect(() => {
    if (target) setPassword("")
    setReconciled(false)
    setCopied(false)
  }, [target, unknownPassword])

  async function submit() {
    if (!target || busyRef.current || resultUnknown) return
    busyRef.current = true
    setBusy(true)
    try {
      const next =
        password.trim() === "" ? `dzp-${crypto.randomUUID()}` : password
      setPassword(next)
      if (await onReset(target, next) === "success") onClose()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={target !== undefined}
      onOpenChange={(next) => { if (!next && !busyRef.current) onClose() }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{resultUnknown ? "重置结果待核实" : "重置密码"}</DialogTitle>
          <DialogDescription className="break-words">
            {resultUnknown
              ? `为 ${target?.email ?? ""} 提交的重置可能已生效。请与厂家核实，确认请求已结束后再解除限制。`
              : `为 ${target?.email ?? ""} 设置新密码。`}
          </DialogDescription>
        </DialogHeader>
        {resultUnknown ? <p role="alert" className="text-compact text-destructive">{unknownPassword === null
          ? "本页面没有上次提交的密码，可能来自其他标签页或已重新加载。请先与厂家核实结果，再决定是否重新重置。"
          : "本次重置结果未确认，请勿重复提交。"}</p> : null}
        {unknownPassword === null ? null : <FieldGroup>
          <Field>
            <FieldLabel htmlFor="supplier-reset-password">{resultUnknown ? "本次提交的密码" : "新密码"}</FieldLabel>
            <FieldDescription>{resultUnknown
              ? "请安全保存此密码。刷新或离开页面后无法恢复；密码不一定已经生效。"
              : "自定义发给厂家的密码；留空将自动生成。"}</FieldDescription>
            <Input
              id="supplier-reset-password"
              className="max-md:min-h-11"
              type="text"
              value={resultUnknown ? unknownPassword ?? "" : password}
              readOnly={resultUnknown}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldGroup>}
        {resultUnknown ? <>
          <label className="flex items-start gap-2 text-compact">
            <Checkbox className="max-md:after:-inset-x-3.5 max-md:after:-inset-y-3.5" checked={reconciled} onCheckedChange={(checked) => setReconciled(checked === true)} />
            <span>我已核实上次请求已结束，并已保存密码或确认无需保存。</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>关闭</Button>
            {unknownPassword ? <Button type="button" variant="outline" onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(unknownPassword)
                  setCopied(true)
                } catch {
                  notifyError("复制失败，请手动选择并复制密码。")
                }
              })()
            }}>{copied ? "已复制" : "复制密码"}</Button> : null}
            <Button type="button" disabled={!reconciled} onClick={() => {
              if (target) onReconciled(target.member_id)
            }}>解除限制</Button>
          </DialogFooter>
        </> : <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}重置
          </Button>
        </DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

function CreateMemberDialog({
  source,
  returnFocusRef,
  onClose,
  onCreated,
}: {
  source?: SupplierAccountsGroup["factory"]
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onCreated: (email: string, password?: string) => void
}) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => { setEmail(""); setName(""); setPassword("") }, [source?.factory_id])

  async function submit() {
    if (!source || email.trim() === "") {
      notifyError("请填写邮箱")
      return
    }
    setBusy(true)
    try {
      const created = await createSupplierAccount({
        factoryId: source.factory_id,
        email: email.trim(),
        name: name.trim() === "" ? undefined : name.trim(),
        password: password === "" ? undefined : password,
      })
      onCreated(
        created.member.email,
        created.initial_password ?? undefined,
      )
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
    <Dialog open={source !== undefined} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent finalFocus={returnFocusRef}>
        <DialogHeader>
          <DialogTitle>开通厂家成员</DialogTitle>
          <DialogDescription className="break-words">
            {source?.name}：已有账号直接绑定，新账号的初始密码仅显示一次。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="supplier-member-email">邮箱</FieldLabel>
            <Input
              id="supplier-member-email"
              className="max-md:min-h-11"
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
              className="max-md:min-h-11"
              type="text"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-member-name">名称（可选）</FieldLabel>
            <Input
              id="supplier-member-name"
              className="max-md:min-h-11"
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
    <Dialog open={issued !== undefined} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false}>
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
