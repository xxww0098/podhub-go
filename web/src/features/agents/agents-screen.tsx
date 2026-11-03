import { useEffect, useRef, useState, type RefObject } from "react"
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, RefreshCw, Search, UserPlus, XCircle } from "lucide-react"

import type { AdminAgentCommissionView, AdminAgentView, AdminAgentsOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { PlatformAdminEmpty, PlatformAdminSection, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { IdentityMark } from "@/components/identity-mark"
import { useScreenActive } from "@/components/screen-pane"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import {
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { copyToClipboard } from "@/lib/clipboard"
import { rebateLabel } from "@/features/agents/agent-card"
import { PRODUCT_LABELS, payoutChannelLabel } from "@/features/agents/agent-labels"
import { AgentWithdrawalsPanel } from "@/features/agents/agent-withdrawals-panel"

const AGENTS_LIVE = "agents-load"

type AgentStatusFilter = "all" | "active" | "disabled" | "other"
type AgentPayoutFilter = "all" | "alipay" | "wechat" | "unset" | "other"

export function filterAgentRoster(agents: AdminAgentView[], status: AgentStatusFilter, payout: AgentPayoutFilter) {
  return agents.filter((agent) => {
    const statusMatches = status === "all" || (status === "other"
      ? agent.status !== "active" && agent.status !== "disabled"
      : agent.status === status)
    const channel = agent.payout_account?.channel
    const payoutMatches = payout === "all" || (payout === "unset"
      ? !agent.payout_account
      : payout === "other"
        ? !!agent.payout_account && channel !== "alipay" && channel !== "wechat"
        : channel === payout)
    return statusMatches && payoutMatches
  })
}

export function paginateAgentRoster(agents: AdminAgentView[], requestedPage: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(agents.length / pageSize))
  const page = Math.max(1, Math.min(requestedPage, pageCount))
  return { page, pageCount, agents: agents.slice((page - 1) * pageSize, page * pageSize) }
}

/**
 * 百分比 typed by the SuperAdmin → basis points the server stores. `""` is
 * "no override"; anything that is not a percentage in 0–100 is `undefined`,
 * which disables the submit rather than sending a number the server refuses.
 */
export function bpsFromPercent(input: string): number | null | undefined {
  const trimmed = input.trim()
  if (trimmed === "") return null
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return undefined
  return Math.round(percent * 100)
}

function percentFromBps(bps: number | null | undefined): string {
  return bps === null || bps === undefined ? "" : String(bps / 100)
}

/**
 * ¥ typed by the SuperAdmin → cents. `""` means "no floor"; anything outside
 * 0–1,000,000 is `undefined`, which disables the submit rather than sending a
 * number the server refuses.
 */
export function centsFromYuan(input: string): number | undefined {
  const trimmed = input.trim()
  if (trimmed === "") return 0
  const yuan = Number(trimmed)
  if (!Number.isFinite(yuan) || yuan < 0 || yuan > 1_000_000) return undefined
  return Math.round(yuan * 100)
}

function yuanFromCents(cents: number): string {
  return String(cents / 100)
}

/** Whole days; `""` is "never expires" (0); outside 0–3650 is `undefined`. */
function validityDaysFromInput(input: string): number | undefined {
  const trimmed = input.trim()
  if (trimmed === "") return 0
  const days = Number(trimmed)
  if (!Number.isInteger(days) || days < 0 || days > 3650) return undefined
  return days
}

/**
 * 平台 → 代理: the roster of Agents with the platform default rate, and the
 * commission ledger under it. Both read from `/api/admin/agents*`; the rules
 * they show are Cloud's (`docs/agent-rebate.md`), never re-derived here.
 */
export function AgentsScreen() {
  const active = useScreenActive()
  const [overview, setOverview] = useState<AdminAgentsOverview>()
  const [commissions, setCommissions] = useState<AdminAgentCommissionView[]>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>()
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AdminAgentView>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const readVersion = useRef(0)
  const [copiedCode, setCopiedCode] = useState<string>()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [queryDraft, setQueryDraft] = useState("")
  const [query, setQuery] = useState("")
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [statusFilter, setStatusFilter] = useState<AgentStatusFilter>("all")
  const [payoutFilter, setPayoutFilter] = useState<AgentPayoutFilter>("all")
  const [rosterPage, setRosterPage] = useState(1)
  const [rosterPageSize, setRosterPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const [ledgerTotal, setLedgerTotal] = useState(0)

  const filteredAgents = filterAgentRoster(overview?.agents ?? [], statusFilter, payoutFilter)
  const { page: currentRosterPage, pageCount: rosterPageCount, agents: visibleAgents } = paginateAgentRoster(filteredAgents, rosterPage, rosterPageSize)
  const selectedAgents = visibleAgents.filter((agent) => selected.has(agent.user_uuid))
  const allSelected = visibleAgents.length > 0 && selectedAgents.length === visibleAgents.length
  const hasFilters = Boolean(query || flaggedOnly || statusFilter !== "all" || payoutFilter !== "all")

  function resetFilters() {
    setSelected(new Set())
    setQueryDraft("")
    setQuery("")
    setFlaggedOnly(false)
    setStatusFilter("all")
    setPayoutFilter("all")
    setRosterPage(1)
    setPage(1)
  }

  async function load(soft = false) {
    const request = ++readVersion.current
    setSelected(new Set())
    if (soft) setRefreshing(true)
    else setLoading(true)
    setError(undefined)
    clearLive(AGENTS_LIVE)
    try {
      const [agents, ledger] = await Promise.all([
        adminHttp.adminListAgents({ query, flagged: flaggedOnly }),
        adminHttp.adminListAgentCommissions(page),
      ])
      if (request !== readVersion.current) return
      setOverview(agents)
      setCommissions(ledger.commissions)
      setLedgerTotal(ledger.total)
    } catch (reason) {
      if (request !== readVersion.current) return
      setError(reason)
      notifyLive({
        id: AGENTS_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "请检查网络后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    } finally {
      if (request === readVersion.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  useEffect(() => {
    if (active) void load()
    return () => { readVersion.current += 1; clearLive(AGENTS_LIVE) }
    // Filters and the ledger page are part of the read, so they re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, flaggedOnly, page])

  async function copyCode(code: string) {
    await copyToClipboard(code, {
      success: `已复制 ${code}`,
      failure: "复制失败，请手动选择邀请码。",
      onCopied: () => setCopiedCode(code),
    })
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3 overflow-y-auto">
      <h1 className="sr-only">代理</h1>

      <PlatformAdminSurface
        className="min-h-full shrink-0"
        bodyClassName="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
        toolbar={
          <>
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
              <form
                className="min-w-36 flex-1 sm:basis-52"
                onSubmit={(event) => {
                  event.preventDefault()
                  setPage(1)
                  setRosterPage(1)
                  setSelected(new Set())
                  setQuery(queryDraft.trim())
                }}
              >
                <InputGroup className="max-md:h-12">
                  <InputGroupAddon>
                    <IconButton icon={Search} label="搜索代理" type="submit" size="icon-xs" />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    className="max-md:h-full"
                    aria-label="搜索代理"
                    placeholder="搜索邮箱 / 名称 / 邀请码"
                    value={queryDraft}
                    onChange={(event) => setQueryDraft(event.target.value)}
                  />
                </InputGroup>
              </form>
              <IconButton
                icon={RefreshCw}
                iconClassName={loading || refreshing ? "invisible" : undefined}
                label={refreshing ? "正在刷新代理" : loading ? "正在读取代理" : "刷新代理"}
                tip="刷新代理"
                size="icon-sm"
                variant="outline"
                className="relative"
                aria-busy={loading || refreshing}
                disabled={loading || refreshing}
                onClick={() => void load(true)}
              >
                {loading || refreshing ? <Spinner aria-hidden className="absolute" /> : null}
              </IconButton>
              <Button ref={createButtonRef} type="button" aria-label="开通代理" size="lg" variant="brand" onClick={() => setCreateOpen(true)}>
                <UserPlus data-icon="inline-start" />开通代理
              </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <div className="order-1 flex items-center gap-1">
              <span className="text-compact text-muted-foreground">状态</span>
              <Select value={statusFilter} onValueChange={(value) => {
                if (value) { setStatusFilter(value as AgentStatusFilter); setRosterPage(1); setSelected(new Set()) }
              }}>
                <SelectTrigger size="sm" aria-label="按代理状态筛选" className="min-w-28">
                  <SelectValue>{() => ({ all: "全部状态", active: "已开通", disabled: "已停用", other: "其他状态" })[statusFilter]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">已开通</SelectItem>
                  <SelectItem value="disabled">已停用</SelectItem>
                  <SelectItem value="other">其他状态</SelectItem>
                </SelectContent>
              </Select>
              </div>
              <div className="order-3 flex items-center gap-1 md:order-2">
              <span className="text-compact text-muted-foreground">收款方式</span>
              <Select value={payoutFilter} onValueChange={(value) => {
                if (value) { setPayoutFilter(value as AgentPayoutFilter); setRosterPage(1); setSelected(new Set()) }
              }}>
                <SelectTrigger size="sm" aria-label="按收款方式筛选" className="min-w-32">
                  <SelectValue>{() => ({ all: "全部收款方式", alipay: "支付宝", wechat: "微信", unset: "未设置", other: "其他方式" })[payoutFilter]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部收款方式</SelectItem>
                  <SelectItem value="alipay">支付宝</SelectItem>
                  <SelectItem value="wechat">微信</SelectItem>
                  <SelectItem value="unset">未设置</SelectItem>
                  <SelectItem value="other">其他方式</SelectItem>
                </SelectContent>
              </Select>
              </div>
              <Button
                type="button"
                size="sm"
                variant={flaggedOnly ? "default" : "outline"}
                className="order-2 md:order-3"
                aria-pressed={flaggedOnly}
                onClick={() => {
                  setPage(1)
                  setRosterPage(1)
                  setSelected(new Set())
                  setFlaggedOnly((current) => !current)
                }}
              >
                待复核
              </Button>
              <Button type="button" size="sm" variant="outline" className="order-4 sm:ml-auto" disabled={!hasFilters && !queryDraft} onClick={resetFilters}>重置</Button>
              </div>
              {selectedAgents.length > 0 ? <div className="flex flex-wrap items-center gap-2 text-compact text-muted-foreground">
                <span>本页已选 {selectedAgents.length} 个</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void copyToClipboard(selectedAgents.map((agent) => agent.email).join("\n"), { success: "已复制所选邮箱", failure: "复制失败，请手动选择邮箱。" })}>复制邮箱</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清除选择</Button>
              </div> : null}
            </div>
          </>
        }
      >
        {loading ? (
          <PlatformAdminEmpty icon={UserPlus} busy title="正在读取代理…" />
        ) : error ? (
          <PlatformAdminEmpty
            icon={XCircle}
            action={
              <Button variant="outline" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        ) : (
          <>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Table
            containerClassName="shrink-0 overflow-visible"
            className={`${visibleAgents.length ? "min-w-[850px]" : ""} [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4`}
          >
            <TableHeader className="sticky top-0 z-20">
                <TableRow className="hover:bg-transparent">
                  <TableHead><Checkbox aria-label="选择本页全部代理" disabled={visibleAgents.length === 0} checked={allSelected} indeterminate={selectedAgents.length > 0 && !allSelected} onCheckedChange={(checked) => setSelected(checked ? new Set(visibleAgents.map((agent) => agent.user_uuid)) : new Set())} /></TableHead>
                  <TableHead>代理身份</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>邀请码</TableHead>
                  <TableHead>收款方式</TableHead>
                  <TableHead className="text-right">余额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="sticky right-0 z-10 bg-muted text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAgents.map((agent) => (
                  <TableRow key={agent.user_uuid} className="group/row md:[&>td]:py-2.5">
                    <TableCell><Checkbox aria-label={`选择 ${agent.email}`} checked={selected.has(agent.user_uuid)} onCheckedChange={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(agent.user_uuid); else next.delete(agent.user_uuid); return next })} /></TableCell>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <IdentityMark kind="user" name={agent.name} className="size-8 shrink-0" />
                        <span className="max-w-56 truncate text-compact font-medium" title={agent.name}>{agent.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-meta text-muted-foreground" title={agent.email}>{agent.email}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md font-mono text-compact tracking-wider hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11"
                        aria-label={`复制 ${agent.invite_code}`}
                        onClick={() => void copyCode(agent.invite_code)}
                      >
                        {agent.invite_code}
                        {copiedCode === agent.invite_code ? (
                          <Check aria-hidden className="size-3.5 text-st-good-ink" />
                        ) : (
                          <Copy aria-hidden className="size-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-meta text-muted-foreground">
                      {agent.payout_account ? payoutChannelLabel(agent.payout_account.channel) : "未设置"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                      {formatCents(agent.wallet_balance_cents)}
                      {agent.wallet_held_cents > 0 ? (
                        <span className="text-meta text-muted-foreground">
                          {" "}冻结 {formatCents(agent.wallet_held_cents)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <StateChip
                          status={agent.status}
                          tone={agent.status === "active" ? "good" : agent.status === "disabled" ? "bad" : "unknown"}
                          label={agent.status === "active" ? "已开通" : agent.status === "disabled" ? "已停用" : `未知状态：${agent.status}`}
                        />
                        {agent.review_flagged_at ? (
                          <StateChip status="review" tone="attest" label="待复核" />
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="sticky right-0 bg-card text-right group-hover/row:bg-muted">
                      <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                        <Button type="button" variant="link" size="sm" aria-label={`编辑 ${agent.email}`} disabled={agent.status !== "active" && agent.status !== "disabled"} onClick={(event) => { editButtonRef.current = event.currentTarget; setEditing(agent) }}>编辑</Button>
                        <Popover>
                          <PopoverTrigger render={<Button type="button" variant="link" size="sm" aria-label={`更多操作 ${agent.email}`}>更多<ChevronDown aria-hidden /></Button>} />
                          <PopoverContent align="end" className="w-64">
                            <p className="text-compact">已邀请 {agent.invitee_count} · 已发佣 {agent.credited_count} · 未计佣 {agent.skipped_count}</p>
                            <p className="mt-1 text-meta text-muted-foreground">累计佣金 {formatCents(agent.credited_total_cents)}</p>
                            {agent.payout_account ? <p className="mt-1 break-all text-meta text-muted-foreground">收款账号 {agent.payout_account.account}</p> : null}
                            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void copyCode(agent.invite_code)}><Copy data-icon="inline-start" />复制邀请码</Button>
                          </PopoverContent>
                        </Popover>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {visibleAgents.length === 0 ? (
              <PlatformAdminEmpty
                className="flex-1"
                icon={hasFilters ? Search : UserPlus}
                title={hasFilters ? "没有匹配的代理" : "还没有代理"}
                description={hasFilters ? undefined : "开通一个已注册账号为代理，佣金会进入该账号的佣金余额。"}
                action={hasFilters ? <Button variant="outline" onClick={resetFilters}>重置筛选</Button> : undefined}
              />
            ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-meta text-muted-foreground">
              <span>共 {filteredAgents.length} 条</span>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={String(rosterPageSize)} onValueChange={(value) => {
                  if (value) { setRosterPageSize(Number(value)); setRosterPage(1); setSelected(new Set()) }
                }}>
                  <SelectTrigger size="sm" aria-label="每页代理数量"><SelectValue>{() => `每页 ${rosterPageSize} 条`}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">每页 10 条</SelectItem>
                    <SelectItem value="20">每页 20 条</SelectItem>
                    <SelectItem value="50">每页 50 条</SelectItem>
                  </SelectContent>
                </Select>
                <IconButton icon={ChevronLeft} label="上一页代理" size="icon-sm" variant="outline" disabled={currentRosterPage <= 1} onClick={() => { setSelected(new Set()); setRosterPage(currentRosterPage - 1) }} />
                <span>{currentRosterPage} / {rosterPageCount}</span>
                <IconButton icon={ChevronRight} label="下一页代理" size="icon-sm" variant="outline" disabled={currentRosterPage >= rosterPageCount} onClick={() => { setSelected(new Set()); setRosterPage(currentRosterPage + 1) }} />
              </div>
            </div>
          </>
        )}
      </PlatformAdminSurface>

      {overview ? (
        <details className="rounded-xl border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">代理政策</summary>
          <div className="pt-3"><DefaultRebateEditor policy={overview} onSaved={setOverview} /></div>
        </details>
      ) : null}

      {!loading && !error ? (
        <>
          <CommissionLedger
            commissions={commissions ?? []}
            total={ledgerTotal}
            page={page}
            onPage={setPage}
          />
          <AgentWithdrawalsPanel />
        </>
      ) : null}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void load(true)}
        finalFocus={createButtonRef}
      />
      <EditAgentDialog
        agent={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
        onSaved={() => {
          setEditing(undefined)
          void load(true)
        }}
        finalFocus={() => editButtonRef.current?.isConnected ? editButtonRef.current : createButtonRef.current}
      />
    </div>
  )
}

/**
 * The whole platform policy in one edit: the default rate, the amount a first
 * order must reach to qualify, and how long an attribution stays open. Saving
 * changes the rate only for future attributions and the floor only for future
 * settles (`docs/agent-rebate.md`).
 */
function DefaultRebateEditor({
  policy,
  onSaved,
}: {
  policy: AdminAgentsOverview
  onSaved: (next: AdminAgentsOverview) => void
}) {
  const [percent, setPercent] = useState(percentFromBps(policy.default_rebate_bps))
  const [minOrderYuan, setMinOrderYuan] = useState(yuanFromCents(policy.min_order_cents))
  const [validityDays, setValidityDays] = useState(String(policy.attribution_validity_days))
  const [minWithdrawYuan, setMinWithdrawYuan] = useState(yuanFromCents(policy.min_withdraw_cents))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setPercent(percentFromBps(policy.default_rebate_bps))
    setMinOrderYuan(yuanFromCents(policy.min_order_cents))
    setValidityDays(String(policy.attribution_validity_days))
    setMinWithdrawYuan(yuanFromCents(policy.min_withdraw_cents))
  }, [policy.default_rebate_bps, policy.min_order_cents, policy.attribution_validity_days, policy.min_withdraw_cents])

  const bps = bpsFromPercent(percent)
  const minOrderCents = centsFromYuan(minOrderYuan)
  const validity = validityDaysFromInput(validityDays)
  const minWithdrawCents = centsFromYuan(minWithdrawYuan)
  const valid =
    typeof bps === "number" && minOrderCents !== undefined && validity !== undefined &&
    minWithdrawCents !== undefined
  const dirty =
    valid &&
    (bps !== policy.default_rebate_bps ||
      minOrderCents !== policy.min_order_cents ||
      validity !== policy.attribution_validity_days ||
      minWithdrawCents !== policy.min_withdraw_cents)

  async function save() {
    if (!valid) return
    setSaving(true)
    try {
      const next = await adminHttp.adminSetAgentRebatePolicy({
        default_rebate_bps: bps,
        min_order_cents: minOrderCents,
        attribution_validity_days: validity,
        min_withdraw_cents: minWithdrawCents,
      })
      onSaved({ ...policy, ...next })
      notifySuccess(
        `代理政策已保存：默认 ${rebateLabel(next.default_rebate_bps)}，合格首单 ≥ ${formatCents(next.min_order_cents)}，归因有效期 ${next.attribution_validity_days} 天，最低提现 ${formatCents(next.min_withdraw_cents)}`,
      )
    } catch (reason) {
      notifyCommandError(reason, "无法保存代理政策，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex flex-wrap items-center gap-x-4 gap-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <span className="flex items-center gap-2">
        <FieldLabel htmlFor="agent-default-rebate" className="text-compact whitespace-nowrap">
          默认返点
        </FieldLabel>
        <Input
          id="agent-default-rebate"
          type="number"
          min={0}
          max={100}
          step="0.01"
          inputMode="decimal"
          className="h-9 w-20 font-mono tabular-nums"
          aria-invalid={typeof bps !== "number"}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
        />
        <span className="text-compact text-muted-foreground">%</span>
      </span>
      <span className="flex items-center gap-2">
        <FieldLabel htmlFor="agent-min-order" className="text-compact whitespace-nowrap">
          合格首单 ≥
        </FieldLabel>
        <Input
          id="agent-min-order"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="h-9 w-24 font-mono tabular-nums"
          aria-invalid={minOrderCents === undefined}
          value={minOrderYuan}
          onChange={(event) => setMinOrderYuan(event.target.value)}
        />
        <span className="text-compact text-muted-foreground">元</span>
      </span>
      <span className="flex items-center gap-2">
        <FieldLabel htmlFor="agent-validity" className="text-compact whitespace-nowrap">
          归因有效期
        </FieldLabel>
        <Input
          id="agent-validity"
          type="number"
          min={0}
          max={3650}
          step="1"
          inputMode="numeric"
          className="h-9 w-20 font-mono tabular-nums"
          aria-invalid={validity === undefined}
          value={validityDays}
          onChange={(event) => setValidityDays(event.target.value)}
        />
        <span className="text-compact text-muted-foreground">天</span>
      </span>
      <span className="flex items-center gap-2">
        <FieldLabel htmlFor="agent-min-withdraw" className="text-compact whitespace-nowrap">
          最低提现
        </FieldLabel>
        <Input
          id="agent-min-withdraw"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          className="h-9 w-24 font-mono tabular-nums"
          aria-invalid={minWithdrawCents === undefined}
          value={minWithdrawYuan}
          onChange={(event) => setMinWithdrawYuan(event.target.value)}
        />
        <span className="text-compact text-muted-foreground">元</span>
      </span>
      <Button type="submit" size="sm" variant="outline" className="ml-auto" disabled={!dirty || saving}>
        {saving ? <Spinner data-icon="inline-start" /> : null}
        保存
      </Button>
      <span className="basis-full text-meta text-muted-foreground">
        0 天 = 永久；门槛以下的订单不计佣，也不消耗邀请资格
      </span>
    </form>
  )
}

function CommissionLedger({
  commissions,
  total,
  page,
  onPage,
}: {
  commissions: AdminAgentCommissionView[]
  total: number
  page: number
  onPage: (page: number) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / 50))
  return (
    <PlatformAdminSection
      title="佣金流水"
      count={total}
      description="每个被邀请用户只在其首笔实付订单产生一行；未计佣的行标出原因。"
      className="min-h-full shrink-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {commissions.length === 0 ? (
        <p className="grid flex-1 place-items-center py-6 text-center text-compact text-muted-foreground">
          还没有佣金记录。
        </p>
      ) : (
        <Table
          containerClassName="min-h-0 flex-1 overflow-auto"
          className="min-w-[880px] [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
        >
          <TableHeader className="sticky top-0 z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead>代理</TableHead>
                <TableHead>被邀请人</TableHead>
                <TableHead>付款 Workspace</TableHead>
                <TableHead>订单</TableHead>
                <TableHead className="text-right">返点</TableHead>
                <TableHead className="text-right">佣金</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commissions.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-meta"><span className="block max-w-52 truncate" title={row.agent_email}>{row.agent_email}</span></TableCell>
                  <TableCell className="text-meta"><span className="block max-w-52 truncate" title={row.invitee_email}>{row.invitee_email}</span></TableCell>
                  <TableCell><span className="block max-w-48 truncate" title={row.workspace_name}>{row.workspace_name}</span></TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {PRODUCT_LABELS[row.product] ?? row.product} ·{" "}
                        <span className="font-mono tabular-nums">
                          {formatCents(row.order_amount_cents)}
                        </span>
                      </span>
                      <span className="font-mono text-meta tabular-nums text-muted-foreground">
                        {row.payment_order_public_id}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{rebateLabel(row.rebate_bps)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.status === "credited" ? formatCents(row.amount_cents) : "—"}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={row.status}
                      tone={row.status === "credited" ? "good" : "idle"}
                      label={row.status === "credited" ? "已入账" : `未计佣 · ${row.note}`}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
                    {formatDateTimeShort(row.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
        </Table>
      )}
      {total > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-2 text-meta text-muted-foreground">
          <span>
            共 {total} 条 · 第 {page} / {pageCount} 页
          </span>
          <span className="flex items-center gap-1.5">
            <IconButton
              icon={Download}
              label="导出 CSV"
              size="icon-sm"
              variant="outline"
              onClick={() => {
                window.location.assign(adminHttp.adminAgentCommissionsCsvUrl())
              }}
            />
            <IconButton
              icon={ChevronLeft}
              label="上一页"
              size="icon-sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            />
            <IconButton
              icon={ChevronRight}
              label="下一页"
              size="icon-sm"
              variant="outline"
              disabled={page >= pageCount}
              onClick={() => onPage(page + 1)}
            />
          </span>
        </div>
      ) : null}
      </div>
    </PlatformAdminSection>
  )
}

function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
  finalFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (agent: AdminAgentView) => void
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  const [email, setEmail] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  const [saving, setSaving] = useState(false)
  const canSubmit = email.trim() !== ""

  useEffect(() => {
    if (!open) {
      setEmail("")
      setInviteCode("")
    }
  }, [open])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    try {
      const agent = await adminHttp.adminCreateAgent({
        email: email.trim(),
        ...(inviteCode.trim() ? { invite_code: inviteCode.trim().toUpperCase() } : {}),
      })
      notifySuccess(`已开通代理 ${agent.email}，邀请码 ${agent.invite_code}`)
      onCreated(agent)
      onOpenChange(false)
    } catch (reason) {
      notifyCommandError(reason, "开通代理失败，请检查输入后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PlatformAdminDialog
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      title="开通代理"
      description="开通代理商并分配专属邀请码"
    >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="agent-create-email">账号邮箱</FieldLabel>
                <Input
                  id="agent-create-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-create-code">邀请码（可选）</FieldLabel>
                <Input
                  id="agent-create-code"
                  className="font-mono uppercase tracking-wider"
                  maxLength={32}
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                  placeholder="留空自动生成"
                />
                <FieldDescription>佣金统一按全局默认返点，进入代理本人的佣金余额。</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          <PlatformAdminDialogFooter>
            <Button type="submit" disabled={saving || !canSubmit}>
              {saving ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}
              {saving ? "开通中…" : "开通代理"}
            </Button>
          </PlatformAdminDialogFooter>
        </form>
    </PlatformAdminDialog>
  )
}

function EditAgentDialog({
  agent,
  onOpenChange,
  onSaved,
  finalFocus,
}: {
  agent?: AdminAgentView
  onOpenChange: (open: boolean) => void
  onSaved: (agent: AdminAgentView) => void
  finalFocus: () => HTMLElement | null
}) {
  const [inviteCode, setInviteCode] = useState("")
  const [status, setStatus] = useState<"active" | "disabled">("active")
  const [saving, setSaving] = useState(false)
  const canSubmit = inviteCode.trim() !== ""

  useEffect(() => {
    if (!agent) return
    setInviteCode(agent.invite_code)
    setStatus(agent.status === "disabled" ? "disabled" : "active")
  }, [agent])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!agent || !canSubmit) return
    setSaving(true)
    try {
      const next = await adminHttp.adminUpdateAgent(agent.user_uuid, {
        invite_code: inviteCode.trim().toUpperCase(),
        status,
      })
      notifySuccess("代理已更新")
      onSaved(next)
    } catch (reason) {
      notifyCommandError(reason, "保存代理失败，请检查输入后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PlatformAdminDialog
      open={Boolean(agent)}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      header={
        <>
          <DialogTitle className="text-base font-semibold">编辑代理</DialogTitle>
          <DialogDescription className="break-all text-meta text-muted-foreground">{agent?.email ?? ""}</DialogDescription>
        </>
      }
    >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel>状态</FieldLabel>
                <Tabs
                  value={status}
                  onValueChange={(next) => setStatus(next === "disabled" ? "disabled" : "active")}
                >
                  <TabsList aria-label="代理状态" className="h-9 w-full">
                    <TabsIndicator />
                    <TabsTrigger value="active" className="h-8 flex-1 text-sm">
                      已开通
                    </TabsTrigger>
                    <TabsTrigger value="disabled" className="h-8 flex-1 text-sm">
                      已停用
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-edit-code">邀请码</FieldLabel>
                <Input
                  id="agent-edit-code"
                  className="font-mono uppercase tracking-wider"
                  maxLength={32}
                  required
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                />
                <FieldDescription>停用后不再产生新佣金，已有余额仍可提现或转入钱包。</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          <PlatformAdminDialogFooter>
            <Button type="submit" disabled={saving || !canSubmit}>
              {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              {saving ? "保存中…" : "保存"}
            </Button>
          </PlatformAdminDialogFooter>
        </form>
    </PlatformAdminDialog>
  )
}
