import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
  X,
  XCircle,
} from "lucide-react"

import type { AdminRedeemCodeCreateRequestView, AdminRedeemCodeView, AdminRedeemCodesCreated, AdminRedeemCodesOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { IdentityTile } from "@/components/identity-tile"
import { IdCode } from "@/components/id-code"
import { PlatformAdminEmpty, PlatformAdminSearch, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { useScreenActive } from "@/components/screen-pane"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeShort } from "@/lib/format"
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, formatYuan, topupCentsFromYuan } from "@/lib/money"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { planDisplayName } from "@/features/plans/plan-catalog"
import { SubscriptionCoupons } from "./subscription-coupons"

const REDEEM_CODES_LIVE = "redeem-codes-load"
type CodeStatus = "unused" | "redeemed" | "expired" | "revoked"
type StatusFilter = "all" | CodeStatus

const STATUS_LABELS: Record<CodeStatus, string> = {
  unused: "未使用",
  redeemed: "已兑换",
  expired: "已过期",
  revoked: "已作废",
}
const STATUS_STYLES: Record<CodeStatus, string> = {
  unused: "border-st-good/30 bg-st-good-soft text-st-good-ink [&>span]:bg-st-good",
  redeemed: "border-st-flight/30 bg-st-flight-soft text-st-flight-ink [&>span]:bg-st-flight",
  expired: "border-st-idle/25 bg-st-idle-soft bg-none text-st-idle-ink [&>span]:bg-st-idle",
  revoked: "border-st-attest/30 bg-st-attest-soft text-st-attest-ink [&>span]:bg-st-attest",
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "unused", label: "未使用" },
  { id: "redeemed", label: "已兑换" },
  { id: "expired", label: "已过期" },
  { id: "revoked", label: "已作废" },
]

type RedeemGrantSource = { wallet_cents: number; plan_key?: string | null; plan_stores?: number | null; plan_months?: number | null }

/** The two display pieces of a code's grant: the amount and its label. */
function redeemGrantParts(code: RedeemGrantSource) {
  if (code.plan_key) return { amount: planDisplayName(code.plan_key), detail: `${code.plan_stores} 家店铺 · ${code.plan_months} 个月` }
  return { amount: formatYuan(centsToMicrofen(code.wallet_cents)), detail: "钱包额度" }
}

function redeemGrantLabel(code: RedeemGrantSource) {
  const { amount, detail } = redeemGrantParts(code)
  return `${amount} · ${detail}`
}

/** 1 分 = 10^6 microfen: the wire carries 分, `formatYuan` reads microfen. */
function centsToMicrofen(cents: number) {
  return cents * 1_000_000
}

export function RedeemCodesScreen() {
  return <Tabs defaultValue="wallet" className="min-h-0 flex-1">
    <TabsList className="w-fit max-w-full flex-wrap" aria-label="兑换与优惠"><TabsTrigger value="wallet">钱包兑换码</TabsTrigger><TabsTrigger value="plan">套餐兑换码</TabsTrigger><TabsTrigger value="coupons">订阅优惠码</TabsTrigger><TabsIndicator /></TabsList>
    <TabsContent value="wallet" className="flex min-h-0 flex-1 flex-col"><RedeemCodeLedger kind="wallet" /></TabsContent>
    <TabsContent value="plan" className="flex min-h-0 flex-1 flex-col"><RedeemCodeLedger kind="plan" /></TabsContent>
    <TabsContent value="coupons" className="flex min-h-0 flex-1 flex-col gap-3"><SubscriptionCoupons /></TabsContent>
  </Tabs>
}

function RedeemCodeLedger({ kind }: { kind: "wallet" | "plan" }) {
  const active = useScreenActive()
  const [overview, setOverview] = useState<AdminRedeemCodesOverview>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selected, setSelected] = useState<AdminRedeemCodeView>()
  const [pendingDelete, setPendingDelete] = useState<AdminRedeemCodeView>()
  const [copiedId, setCopiedId] = useState<number>()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set())
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const loadVersion = useRef(0)

  async function load(soft = false) {
    const version = ++loadVersion.current
    if (soft) setRefreshing(true)
    else setLoading(true)
    setError(undefined)
    clearLive(REDEEM_CODES_LIVE)
    try {
      const next = await adminHttp.adminListRedeemCodes()
      if (version === loadVersion.current) setOverview(next)
    } catch (reason) {
      if (version !== loadVersion.current) return
      setError(reason)
      notifyLive({
        id: REDEEM_CODES_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "请检查网络后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    } finally {
      if (version === loadVersion.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  useEffect(() => {
    if (active) void load()
    return () => { loadVersion.current += 1; clearLive(REDEEM_CODES_LIVE) }
  }, [active])

  const codes = useMemo(() => (overview?.codes ?? []).filter((code) => Boolean(code.plan_key) === (kind === "plan")), [overview, kind])
  const counts: Record<StatusFilter, number> = {
    all: codes.length,
    unused: codes.filter((code) => code.status === "unused").length,
    redeemed: codes.filter((code) => code.status === "redeemed").length,
    expired: codes.filter((code) => code.status === "expired").length,
    revoked: codes.filter((code) => code.status === "revoked").length,
  }

  const filteredCodes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return codes.filter((code) => {
      const matchesStatus = status === "all" || code.status === status
      const searchable = [
        code.code_preview,
        code.plan_key ?? "",
        redeemGrantLabel(code),
        String(code.wallet_cents),
        formatYuan(centsToMicrofen(code.wallet_cents)),
        code.note ?? "",
        code.batch_id ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return matchesStatus && (!normalized || searchable.includes(normalized))
    })
  }, [codes, query, status])

  const emptyLedger = !loading && !error && codes.length === 0
  const pageCount = Math.max(1, Math.ceil(filteredCodes.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visibleCodes = filteredCodes.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  const visibleIds = visibleCodes.map((code) => code.id)
  // 活选集 — 只数台账里仍存在的码；刷新或删除后旧 id 自然退出。
  const liveSelected = codes.filter((code) => selectedIds.has(code.id))
  const deletableSelected = liveSelected.filter((code) => canDelete(code.status))
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id))

  function toggleSelectAll(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function toggleSelectRow(id: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // 后端没有批量端点：确认一次，然后逐个删除；失败的那些保留在台账里。
  async function deleteSelected() {
    if (deletableSelected.length === 0) return
    setBatchDeleting(true)
    const failed: AdminRedeemCodeView[] = []
    for (const code of deletableSelected) {
      try {
        await adminHttp.adminDeleteRedeemCode(code.id)
      } catch {
        failed.push(code)
      }
    }
    setBatchDeleting(false)
    setBatchDeleteOpen(false)
    const removed = deletableSelected.length - failed.length
    if (removed > 0) {
      setSelectedIds(new Set())
      notifySuccess(`已删除 ${removed} 个兑换码`)
      void load(true)
    }
    if (failed.length > 0) {
      notifyCommandError(undefined, `有 ${failed.length} 个兑换码删除失败，请刷新后重试。`)
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2">
      <h1 className="sr-only">兑换</h1>

      <PlatformAdminSurface
        bodyClassName="flex min-h-0 flex-col border-t-0"
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2">
            <div className="contents">
              <PlatformAdminSearch
                value={query}
                onChange={(value) => {
                  setQuery(value)
                  setPage(1)
                }}
                label="搜索兑换码"
                placeholder="搜索尾号、内容、批次或备注"
                className="h-10 min-w-0 flex-1 max-w-none sm:max-w-none max-md:h-11 max-sm:w-full max-sm:flex-none [&_[data-slot=input-group-control]]:h-full max-md:[&_[data-slot=input-group-control]]:min-h-11"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  aria-label="刷新"
                  variant="outline"
                  size="icon-lg"
                  disabled={loading || refreshing}
                  onClick={() => void load(true)}
                >{loading || refreshing ? <Spinner /> : <RefreshCw aria-hidden />}</Button>
                <Button type="button" variant="brand" size="lg" aria-label="创建兑换码" onClick={() => setCreateOpen(true)}><Plus data-icon="inline-start" />创建兑换码</Button>
              </div>
            </div>
            {overview ? (
              <div role="group" aria-label="按状态筛选" className="flex basis-full flex-wrap gap-1.5">
                {FILTERS.map((filter) => (
                  <Button
                    key={filter.id}
                    type="button"
                    size="lg"
                    variant={status === filter.id ? "brand" : "outline"}
                    aria-pressed={status === filter.id}
                    aria-label={`筛选${filter.label}，${counts[filter.id]} 个`}
                    onClick={() => { setStatus(filter.id); setPage(1) }}
                  >
                    {filter.label}
                    <span className="tabular-nums opacity-75">{counts[filter.id]}</span>
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        }
      >

        {loading ? (
          <PlatformAdminEmpty icon={Ticket} busy title="正在读取兑换码…" />
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
            {liveSelected.length > 0 ? (
              <div
                role="toolbar"
                aria-label="批量操作"
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-soft/40 px-4 py-2"
              >
                <span className="text-compact font-medium tabular-nums">
                  已选 {liveSelected.length} 个
                  {deletableSelected.length < liveSelected.length ? (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      其中 {deletableSelected.length} 个可删除
                    </span>
                  ) : null}
                </span>
                <div className="flex items-center gap-2">
                  <IconButton
                    icon={X}
                    label="清除选择"
                    size="icon-sm"
                    onClick={() => setSelectedIds(new Set())}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={batchDeleting || deletableSelected.length === 0}
                    onClick={() => setBatchDeleteOpen(true)}
                  >
                    <Trash2 aria-hidden />
                    删除 {deletableSelected.length} 个
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-xl border border-border bg-card">
              <Table
                containerClassName="shrink-0 overflow-visible"
                variant="directory"
                className="min-w-[760px]"
              >
                <TableHeader className="sticky top-0 z-20">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 pr-0">
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={!allVisibleSelected && someVisibleSelected}
                        aria-label="选择本页全部兑换码"
                        disabled={visibleIds.length === 0}
                        onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      />
                    </TableHead>
                    <TableHead>兑换码尾号</TableHead>
                    <TableHead>{kind === "plan" ? "套餐内容" : "钱包额度"}</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead className="sticky right-0 z-10 w-36 text-right">
                      操作
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleCodes.map((code) => (
                    <TableRow
                      key={code.id}
                      className="group/row"
                      data-state={selectedIds.has(code.id) ? "selected" : undefined}
                    >
                      <TableCell className="w-10 pr-0">
                        <Checkbox
                          checked={selectedIds.has(code.id)}
                          aria-label={`选择 ${code.code_preview}`}
                          onCheckedChange={(checked) =>
                            toggleSelectRow(code.id, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelected(code)}
                          className="group cursor-pointer text-left focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <IdCode value={code.code_preview} className="text-sm text-foreground group-hover:underline group-hover:underline-offset-4" />
                        </button>
                        <IconButton icon={copiedId === code.id ? Check : Copy} label={`复制 ${code.code_preview}`} tip={copiedId === code.id ? "已复制" : "复制尾号"} size="icon-sm" onClick={() => {
                          void copyText(code.code_preview, `已复制 ${code.code_preview}`).then((ok) => { if (ok) setCopiedId(code.id) })
                        }} />
                      </div>
                      </TableCell>
                      <TableCell>
                        <GrantAmounts code={code} />
                      </TableCell>
                      <TableCell>
                        <StatusChip status={code.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
                        {formatDate(code.created_at)}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-52 truncate text-compact text-muted-foreground" title={code.note ?? undefined}>
                          {code.note || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="sticky right-0 bg-card group-hover/row:bg-muted group-data-[state=selected]/row:bg-brand-soft">
                        <RowActions
                          code={code}
                          onDetail={() => setSelected(code)}
                          onDelete={() => setPendingDelete(code)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {emptyLedger ? (
                <EmptyState kind={kind} />
              ) : filteredCodes.length === 0 ? (
                <PlatformAdminEmpty icon={Search} className="min-h-36 flex-1" title="没有匹配的兑换码" description="试试清空搜索或切换状态。" />
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pt-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>共 {filteredCodes.length.toLocaleString("zh-CN")} 条，每页</span>
                <Select value={String(pageSize)} onValueChange={(value) => {
                  const next = Number(value)
                  if ([10, 20, 50].includes(next)) { setPageSize(next); setPage(1) }
                }}>
                  <SelectTrigger aria-label="每页兑换码数"><SelectValue>{(value) => `${value} 条`}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon-sm" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden /><span className="sr-only">上一页</span></Button>
                <span aria-current="page" aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`} className="inline-flex size-9 items-center justify-center rounded-md bg-brand text-sm font-medium text-brand-foreground tabular-nums">{currentPage}</span>
                <Button variant="outline" size="icon-sm" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight aria-hidden /><span className="sr-only">下一页</span></Button>
              </div>
            </div>
          </>
        )}
      </PlatformAdminSurface>

      <CreateRedeemCodeSheet
        kind={kind}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void load(true)
        }}
      />
      <RedeemCodeDetailSheet
        code={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
        onDelete={(code) => {
          setSelected(undefined)
          setPendingDelete(code)
        }}
      />
      <DeleteCodeDialog
        code={pendingDelete}
        onClose={() => setPendingDelete(undefined)}
        onDeleted={() => {
          setPendingDelete(undefined)
          if (selected?.id === pendingDelete?.id) setSelected(undefined)
          void load(true)
        }}
      />
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title={`删除 ${deletableSelected.length} 个兑换码？`}
        description="将从台账移除选中的未使用、已过期或已作废兑换码。删除后无法恢复。"
        confirmText={`删除 ${deletableSelected.length} 个`}
        variant="destructive"
        icon={<Trash2 data-icon="inline-start" />}
        busy={batchDeleting}
        footerLayout="end"
        showCloseButton={false}
        onConfirm={() => void deleteSelected()}
        onCancel={() => setBatchDeleteOpen(false)}
      />
    </div>
  )
}

function canDelete(status: string) {
  return status === "unused" || status === "expired" || status === "revoked"
}

function RowActions({
  code,
  onDetail,
  onDelete,
}: {
  code: AdminRedeemCodeView
  onDetail: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button type="button" variant="link" size="sm" aria-label={`查看 ${code.code_preview} 详情`} onClick={onDetail}>详情</Button>
      {canDelete(code.status) ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="link" size="sm" aria-label={`${code.code_preview} 的更多操作`} />}>
            更多<ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" aria-label={`删除 ${code.code_preview}`} onClick={onDelete}>
              <Trash2 aria-hidden />删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
  return <StateChip status={status} label={known ? STATUS_LABELS[status as CodeStatus] : "未知"} tone={!known ? "unknown" : status === "expired" ? "idle" : undefined} className={known ? STATUS_STYLES[status as CodeStatus] : undefined} />
}

function EmptyState({ kind }: { kind: "wallet" | "plan" }) {
  return (
    <PlatformAdminEmpty
      className="flex-1"
      icon={KeyRound}
      title="还没有兑换码"
      description={kind === "plan" ? "创建一批兑换码，交付后可兑换套餐。" : "创建一批兑换码，交付后可兑换钱包额度。"}
    />
  )
}

function CreateRedeemCodeSheet({
  kind,
  open,
  onOpenChange,
  onCreated,
}: {
  kind: "wallet" | "plan"
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (created: AdminRedeemCodesCreated) => void
}) {
  const [walletYuan, setWalletYuan] = useState("100")
  const [planKey, setPlanKey] = useState<"lite" | "pro" | "max">("lite")
  const [planStores, setPlanStores] = useState("1")
  const [planMonths, setPlanMonths] = useState<1 | 3 | 6 | 12>(1)
  const [quantity, setQuantity] = useState("10")
  const [expiresAt, setExpiresAt] = useState(() => dateInputAfter(30))
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<AdminRedeemCodesCreated>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) {
      setCreated(undefined)
      setSaved(false)
    }
  }, [open])

  const quantityNumber = Number(quantity)
  // Same floor and ceiling a paid top-up has: ¥1 – ¥10000, in 分.
  const walletCents = topupCentsFromYuan(walletYuan)
  const walletOk = walletCents !== null && walletCents >= MIN_TOPUP_CENTS && walletCents <= MAX_TOPUP_CENTS
  const storesNumber = Number(planStores)
  const planOk = Number.isInteger(storesNumber) && storesNumber >= 1 && storesNumber <= 100
  const quantityOk = Number.isInteger(quantityNumber) && quantityNumber >= 1 && quantityNumber <= 500

  /**
   * Implicit dismissal (Escape, backdrop, the corner X) never discards one-time
   * codes, so `force` is reserved for the footer buttons the user actually chose.
   */
  function requestClose(force = false) {
    if (!force && created && !saved) return
    onOpenChange(false)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!quantityOk || (kind === "wallet" ? !walletOk : !planOk)) return
    setSaving(true)
    const request: AdminRedeemCodeCreateRequestView = {
      ...(kind === "wallet" ? { wallet_cents: walletCents! } : { plan_key: planKey, plan_stores: storesNumber, plan_months: planMonths }),
      quantity: quantityNumber,
      expires_at: new Date(`${expiresAt}T23:59:59`).toISOString(),
      note: note.trim() || undefined,
    }
    try {
      const next = await adminHttp.adminCreateRedeemCodes(request)
      setCreated(next)
      setSaved(false)
      onCreated(next)
    } catch (reason) {
      notifyCommandError(reason, "创建兑换码失败，请检查输入后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PlatformAdminDialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else requestClose()
      }}
      title={created ? "保存兑换码" : "创建兑换码"}
      description={created ? "保存创建成功的兑换码" : "批量创建兑换码"}
      showCloseButton={!created || saved}
    >
      {created ? (
        <CreatedResult
          created={created}
          saved={saved}
          onSaved={() => setSaved(true)}
          onDone={() => requestClose(true)}
        />
      ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                {kind === "wallet" ? (
                <Field>
                  <FieldLabel htmlFor="redeem-wallet">钱包额度（元）</FieldLabel>
                  <Input
                    id="redeem-wallet"
                    type="number"
                    min={1}
                    max={10_000}
                    step="0.01"
                    value={walletYuan}
                    onChange={(event) => setWalletYuan(event.target.value)}
                    placeholder="1 – 10000"
                  />
                </Field>
                ) : (
                <Field>
                  <FieldLabel htmlFor="redeem-plan">套餐</FieldLabel>
                  <Select value={planKey} onValueChange={(value) => { if (value === "lite" || value === "pro" || value === "max") setPlanKey(value) }}>
                    <SelectTrigger id="redeem-plan"><SelectValue>{() => planDisplayName(planKey)}</SelectValue></SelectTrigger>
                    <SelectContent><SelectItem value="lite">入门版</SelectItem><SelectItem value="pro">专业版</SelectItem><SelectItem value="max">旗舰版</SelectItem></SelectContent>
                  </Select>
                </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="redeem-quantity">兑换码数量</FieldLabel>
                  <Input
                    id="redeem-quantity"
                    type="number"
                    min={1}
                    max={500}
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    placeholder="最多 500 个"
                  />
                </Field>
              </div>
              {kind === "plan" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="redeem-stores">店铺数量</FieldLabel>
                    <Input id="redeem-stores" type="number" min={1} max={100} value={planStores} onChange={(event) => setPlanStores(event.target.value)} required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="redeem-months">套餐时长</FieldLabel>
                    <Select value={String(planMonths)} onValueChange={(value) => { const months = Number(value); if (months === 1 || months === 3 || months === 6 || months === 12) setPlanMonths(months) }}>
                      <SelectTrigger id="redeem-months"><SelectValue>{() => `${planMonths} 个月`}</SelectValue></SelectTrigger>
                      <SelectContent>{[1, 3, 6, 12].map((months) => <SelectItem key={months} value={String(months)}>{months} 个月</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                </div>
              ) : null}
              <Field>
                <FieldLabel htmlFor="redeem-expires">兑换截止日期</FieldLabel>
                <Input
                  id="redeem-expires"
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="redeem-note">备注（可选）</FieldLabel>
                <Input
                  id="redeem-note"
                  value={note}
                  maxLength={200}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="例如：8 月渠道活动"
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                将生成{" "}
                <span className="font-mono tabular-nums">{quantityOk ? quantityNumber : "—"}</span>{" "}
                个兑换码，每个{" "}
                <span className="font-mono tabular-nums">
                  {kind === "plan" ? `${planDisplayName(planKey)} · ${planOk ? storesNumber : "—"} 家店铺 · ${planMonths} 个月` : walletOk ? formatYuan(centsToMicrofen(walletCents ?? 0)) : "—"}
                </span>{" "}
                {kind === "wallet" ? "· 钱包额度" : ""}
              </p>
            </FieldGroup>
          </div>
          <PlatformAdminDialogFooter>
            <Button type="submit" disabled={saving || !quantityOk || (kind === "wallet" ? !walletOk : !planOk)}>
              {saving ? <Spinner data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
              {saving ? "创建中…" : "生成兑换码"}
            </Button>
          </PlatformAdminDialogFooter>
        </form>
      )}
    </PlatformAdminDialog>
  )
}

function CreatedResult({
  created,
  saved,
  onSaved,
  onDone,
}: {
  created: AdminRedeemCodesCreated
  saved: boolean
  onSaved: () => void
  onDone: () => void
}) {
  const [copiedId, setCopiedId] = useState<number>()
  const first = created.codes[0]
  const codes = created.codes.map((item) => item.code)

  /** Keep the codes in one click, then leave — no second "did you save?" dialog. */
  async function copyAllAndClose() {
    const ok = await copyText(codes.join("\n"), `已复制 ${codes.length} 个兑换码`)
    if (ok) {
      onSaved()
      onDone()
    }
  }

  function downloadAll() {
    downloadText(redeemExportName(first?.batch_id), redeemExportBody(created))
    onSaved()
  }

  async function copyOne(id: number, code: string) {
    const ok = await copyText(code)
    if (ok) setCopiedId(id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-4 pb-4">
      <div className="border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-medium">完整兑换码（{codes.length} 个）</p>
          <span className={saved ? "shrink-0 text-xs font-medium text-st-good-ink" : "shrink-0 text-xs font-medium text-st-attest-ink"}>
            {saved ? "已复制或下载" : "只显示一次"}
          </span>
        </div>
        {saved ? null : (
          <p className="mt-2 text-xs text-muted-foreground">
            关闭后列表里只保留脱敏尾号，完整码无法再取回。
          </p>
        )}
        <dl className="mt-3 grid gap-2.5 text-xs">
          <div>
            <dt className="text-muted-foreground">兑换内容</dt>
            <dd className="mt-0.5 text-foreground">
              {first ? redeemGrantLabel(first) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">兑换截止</dt>
            <dd className="mt-0.5 text-foreground">{formatDate(first?.expires_at)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">批次</dt>
            <dd className="mt-0.5">
              <IdCode value={first?.batch_id ?? "—"} wrap className="text-foreground" />
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border/60">
          {created.codes.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void copyOne(item.id, item.code)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-mono text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="select-all break-all">{item.code}</span>
                {copiedId === item.id ? (
                  <Check className="size-3.5 shrink-0 text-st-good-ink" />
                ) : (
                  <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {saved ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            不保存，直接关闭
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={downloadAll}>
            <Download />
            下载
          </Button>
          {saved ? (
            <Button onClick={onDone}>完成</Button>
          ) : (
            <Button size="sm" onClick={() => void copyAllAndClose()}>
              <Copy />
              复制全部并关闭
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function RedeemCodeDetailSheet({
  code,
  onOpenChange,
  onDelete,
}: {
  code?: AdminRedeemCodeView
  onOpenChange: (open: boolean) => void
  onDelete: (code: AdminRedeemCodeView) => void
}) {
  return (
    <PlatformAdminDialog
      open={Boolean(code)}
      onOpenChange={onOpenChange}
      title="兑换码详情"
      description="查看兑换内容、有效期与使用记录。"
      width="sm:max-w-md"
      footer={
        code && canDelete(code.status) ? (
          <Button variant="destructive" onClick={() => onDelete(code)}>
            <Trash2 />
            删除兑换码
          </Button>
        ) : undefined
      }
    >
        {code ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="flex flex-col gap-5">
            <div className="border-b border-border pb-4">
              <div className="flex items-center gap-3">
                <IdentityTile icon={Ticket} status={code.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <IdCode value={code.code_preview} className="text-base text-foreground" />
                    <IconButton
                      icon={Copy}
                      label={`复制 ${code.code_preview}`}
                      tip="复制尾号"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void copyText(code.code_preview, `已复制 ${code.code_preview}`)}
                    />
                  </div>
                  <p className="mt-1 text-sm">
                    {redeemGrantLabel(code)}
                  </p>
                </div>
                <StatusChip status={code.status} />
              </div>
            </div>
            <dl className="grid gap-3 text-sm">
              <Detail label="创建时间" value={formatDate(code.created_at)} />
              <Detail label="创建人" value={code.created_by_email ?? "—"} />
              <Detail label="兑换截止" value={formatDate(code.expires_at)} />
              <Detail label="兑换时间" value={formatDate(code.used_at)} />
              <Detail label="兑换工作空间" value={code.used_by_workspace ?? "—"} />
              <Detail label="兑换账号" value={code.used_by_email ?? "—"} />
              <Detail label="批次" value={code.batch_id ?? "—"} mono />
              <Detail label="备注" value={code.note ?? "—"} />
              {code.revoked_at ? <Detail label="作废时间" value={formatDate(code.revoked_at)} /> : null}
              {code.revoked_by_email ? <Detail label="作废人" value={code.revoked_by_email} /> : null}
            </dl>
            </div>
          </div>
        ) : null}
    </PlatformAdminDialog>
  )
}

function DeleteCodeDialog({
  code,
  onClose,
  onDeleted,
}: {
  code?: AdminRedeemCodeView
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function remove() {
    if (!code) return
    setDeleting(true)
    try {
      await adminHttp.adminDeleteRedeemCode(code.id)
      notifySuccess("兑换码已删除")
      onDeleted()
    } catch (reason) {
      notifyCommandError(reason, "删除失败，已兑换的码不能从台账移除。")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(code)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="删除兑换码？"
      description={"将从台账移除 " + (code?.code_preview ?? "") + "（" + (code ? redeemGrantLabel(code) : "") + "）。删除后无法恢复。"}
      confirmText="删除兑换码"
      variant="destructive"
      icon={<Trash2 data-icon="inline-start" />}
      busy={deleting}
      footerLayout="end"
      showCloseButton={false}
      onConfirm={() => void remove()}
      onCancel={onClose}
    />
  )
}

function GrantAmounts({ code }: { code: AdminRedeemCodeView }) {
  const { amount, detail } = redeemGrantParts(code)
  return <span className="font-medium tabular-nums text-brand">{amount}{code.plan_key ? ` · ${detail}` : ""}</span>
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-3 last:border-0 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 break-all sm:max-w-56" : "min-w-0 break-words sm:max-w-56 sm:text-right"}>
        {mono ? <IdCode value={value} wrap className="sm:justify-end text-foreground" /> : value}
      </dd>
    </div>
  )
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  return formatDateTimeShort(value)
}

function dateInputAfter(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function redeemExportName(batchId?: string) {
  return `redeem-codes-${batchId?.slice(0, 8) ?? dateInputAfter(0)}.txt`
}

function redeemExportBody(created: AdminRedeemCodesCreated) {
  const first = created.codes[0]
  return [
    "grant: " + (first ? redeemGrantLabel(first) : ""),
    "expires_at: " + (first?.expires_at ?? ""),
    "batch_id: " + (first?.batch_id ?? ""),
    "",
    ...created.codes.map((item) => item.code),
  ].join("\n")
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function copyWithFallback(value: string): boolean {
  const field = document.createElement("textarea")
  field.value = value
  field.setAttribute("readonly", "")
  field.style.position = "fixed"
  field.style.left = "-9999px"
  document.body.append(field)
  field.select()
  const ok = document.execCommand("copy")
  field.remove()
  return ok
}

async function copyText(value: string, message?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    if (message) notifySuccess(message)
    return true
  } catch {
    if (copyWithFallback(value)) {
      if (message) notifySuccess(message)
      return true
    }
    notifyCommandError(
      undefined,
      message ? "复制失败，请手动选择尾号。" : "复制失败，请手动选择兑换码或改用下载。",
    )
    return false
  }
}
