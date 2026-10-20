import { useEffect, useMemo, useState } from "react"
import {
  Check,
  Copy,
  Download,
  KeyRound,
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
import { PlatformAdminEmpty, PlatformAdminFilter, PlatformAdminRefresh, PlatformAdminSearch, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { useScreenActive } from "@/components/screen-pane"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeShort } from "@/lib/format"
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, formatYuan, topupCentsFromYuan } from "@/lib/money"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"

const REDEEM_CODES_LIVE = "redeem-codes-load"

import { MAX_MEMBER_SEATS_PER_WORKSPACE, PLAN_CATALOG, type PlanKey } from "@/features/plans/plan-catalog"

/** Cloud admits 1–20 成员席位 per code and requires a paid tier (billing::seats). */
const PAID_TIERS = PLAN_CATALOG.filter(
  (plan): plan is (typeof plan & { key: Exclude<PlanKey, "lite"> }) =>
    plan.key !== "lite",
)

type CodeStatus = "unused" | "redeemed" | "expired" | "revoked"
type StatusFilter = "all" | CodeStatus

const STATUS_LABELS: Record<CodeStatus, string> = {
  unused: "未使用",
  redeemed: "已兑换",
  expired: "已过期",
  revoked: "已作废",
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "unused", label: "未使用" },
  { id: "redeemed", label: "已兑换" },
  { id: "expired", label: "已过期" },
  { id: "revoked", label: "已作废" },
]

type RedeemGrantSource = {
  product?: string
  member_seats: number
  ocr_credits?: number
  wallet_cents?: number
  duration_days: number
  plan_name: string
}

/** The two display pieces of a code's grant: the amount and its term/label. */
function redeemGrantParts(code: RedeemGrantSource) {
  // A wallet balance never expires, so its code carries an amount and no term.
  if (code.product === "wallet_credits") {
    return { amount: formatYuan(centsToMicrofen(code.wallet_cents ?? 0)), detail: "钱包额度" }
  }
  if (code.product === "ocr_credits") {
    return { amount: `${code.ocr_credits ?? 0} 次`, detail: `${code.duration_days} 天` }
  }
  return { amount: `${code.member_seats} 席`, detail: `${code.duration_days} 天 · ${code.plan_name}` }
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
  const active = useScreenActive()
  const [overview, setOverview] = useState<AdminRedeemCodesOverview>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StatusFilter>("all")
  const [selected, setSelected] = useState<AdminRedeemCodeView>()
  const [pendingDelete, setPendingDelete] = useState<AdminRedeemCodeView>()
  const [copiedId, setCopiedId] = useState<number>()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set())
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  async function load(soft = false) {
    if (soft) setRefreshing(true)
    else setLoading(true)
    setError(undefined)
    clearLive(REDEEM_CODES_LIVE)
    try {
      setOverview(await adminHttp.adminListRedeemCodes())
    } catch (reason) {
      setError(reason)
      notifyLive({
        id: REDEEM_CODES_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "请检查网络后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (active) void load()
    return () => clearLive(REDEEM_CODES_LIVE)
  }, [active])

  const counts: Record<StatusFilter, number> = {
    all: overview?.total ?? 0,
    unused: overview?.unused ?? 0,
    redeemed: overview?.redeemed ?? 0,
    expired: overview?.expired ?? 0,
    revoked: overview?.revoked ?? 0,
  }

  const filteredCodes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (overview?.codes ?? []).filter((code) => {
      const matchesStatus = status === "all" || code.status === status
      const searchable = [
        code.code_preview,
        String(code.member_seats),
        String(code.ocr_credits ?? ""),
        String(code.wallet_cents ?? ""),
        code.product ?? "",
        code.plan_name,
        code.note ?? "",
        code.batch_id ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return matchesStatus && (!normalized || searchable.includes(normalized))
    })
  }, [overview, query, status])

  const emptyLedger = !loading && !error && (overview?.total ?? 0) === 0

  const visibleIds = filteredCodes.map((code) => code.id)
  // 活选集 — 只数台账里仍存在的码；刷新或删除后旧 id 自然退出。
  const liveSelected = (overview?.codes ?? []).filter((code) => selectedIds.has(code.id))
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
    <div className="flex w-full flex-col gap-4">
      <h1 className="sr-only">兑换</h1>

      <PlatformAdminSurface
        toolbar={
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <PlatformAdminSearch
                value={query}
                onChange={setQuery}
                label="搜索兑换码"
                placeholder="搜索尾号、内容、批次或备注"
                className="w-full sm:flex-1 sm:max-w-sm"
              />
              <div className="ml-auto flex items-center gap-2">
                <PlatformAdminRefresh
                  busy={loading || refreshing}
                  onClick={() => void load(true)}
                />
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Ticket data-icon="inline-start" />
                  创建兑换码
                </Button>
              </div>
            </div>
            <PlatformAdminFilter
              label="按状态筛选"
              value={status}
              options={FILTERS.map((filter) => ({
                id: filter.id,
                label: filter.label,
                count: counts[filter.id],
              }))}
              onValueChange={setStatus}
            />
          </div>
        }
      >

        {loading ? (
          <PlatformAdminEmpty icon={Ticket} busy title="正在读取兑换码…" />
        ) : error ? (
          <PlatformAdminEmpty
            icon={XCircle}
            className="min-h-72"
            action={
              <Button variant="outline" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        ) : emptyLedger ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <>
            {liveSelected.length > 0 ? (
              <div
                role="toolbar"
                aria-label="批量操作"
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2.5 py-2"
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
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    <X aria-hidden />
                    清除选择
                  </Button>
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
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10 pr-0">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={!allVisibleSelected && someVisibleSelected}
                      aria-label="选择当前筛选的全部兑换码"
                      onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                    />
                  </TableHead>
                  <TableHead>兑换码</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>兑换人</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead className="sticky right-0 z-10 w-32 bg-popover text-right">
                    操作
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCodes.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7}>
                      <PlatformAdminEmpty
                        icon={Search}
                        className="min-h-36"
                        title="没有匹配的兑换码"
                        description="试试清空搜索或切换状态。"
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCodes.map((code) => (
                    <TableRow
                      key={code.id}
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
                        <button
                          type="button"
                          onClick={() => setSelected(code)}
                          className="group flex cursor-pointer items-center gap-3 text-left focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <IdentityTile icon={Ticket} status={code.status} />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <IdCode
                              value={code.code_preview}
                              className="text-sm text-foreground group-hover:underline group-hover:underline-offset-4"
                            />
                            {code.note ? (
                              <span className="max-w-52 truncate text-xs text-muted-foreground">
                                {code.note}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <GrantAmounts code={code} />
                      </TableCell>
                      <TableCell>
                        <StatusChip status={code.status} />
                      </TableCell>
                      <TableCell>
                        <span className="block text-sm">
                          {code.used_by_email ?? (code.status === "redeemed" ? "—" : "—")}
                        </span>
                        {code.used_by_workspace ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {code.used_by_workspace}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {code.used_at
                          ? formatDate(code.used_at)
                          : formatDate(code.created_at)}
                      </TableCell>
                      <TableCell className="sticky right-0 bg-popover">
                        <RowActions
                          code={code}
                          copied={copiedId === code.id}
                          onCopy={() => {
                            void copyText(code.code_preview, `已复制 ${code.code_preview}`).then(
                              (ok) => {
                                if (ok) setCopiedId(code.id)
                              },
                            )
                          }}
                          onDelete={() => setPendingDelete(code)}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </>
        )}
      </PlatformAdminSurface>

      <CreateRedeemCodeSheet
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
  copied,
  onCopy,
  onDelete,
}: {
  code: AdminRedeemCodeView
  copied: boolean
  onCopy: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <IconAction
        label="复制尾号"
        ariaLabel={`复制 ${code.code_preview}`}
        onClick={onCopy}
      >
        {copied ? <Check aria-hidden className="text-st-good-ink" /> : <Copy aria-hidden />}
      </IconAction>
      {canDelete(code.status) ? (
        <IconAction
          label="删除"
          ariaLabel={`删除 ${code.code_preview}`}
          destructive
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </IconAction>
      ) : null}
    </div>
  )
}

function IconAction({
  label,
  ariaLabel,
  destructive = false,
  onClick,
  children,
}: {
  label: string
  ariaLabel: string
  destructive?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={destructive ? "ghost" : "outline"}
            aria-label={ariaLabel}
            className={
              destructive
                ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                : undefined
            }
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function StatusChip({ status }: { status: string }) {
  const normalized = (status in STATUS_LABELS ? status : "unused") as CodeStatus
  return <StateChip status={normalized} label={STATUS_LABELS[normalized]} />
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <PlatformAdminEmpty
      icon={KeyRound}
      title="还没有兑换码"
      description="创建一批兑换码，交付后可兑换成员名额。"
      action={<Button onClick={onCreate}>创建第一批兑换码</Button>}
    />
  )
}

function CreateRedeemCodeSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (created: AdminRedeemCodesCreated) => void
}) {
  const [product, setProduct] = useState<"member_seats" | "wallet_credits">("member_seats")
  const [memberSeats, setMemberSeats] = useState("1")
  const [tier, setTier] = useState<Exclude<PlanKey, "lite">>("pro")
  const [walletYuan, setWalletYuan] = useState("100")
  const [quantity, setQuantity] = useState("10")
  const [durationDays, setDurationDays] = useState("30")
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

  const memberSeatsNumber = Number(memberSeats)
  const quantityNumber = Number(quantity)
  const durationNumber = Number(durationDays)
  const isWallet = product === "wallet_credits"
  const memberSeatsOk =
    Number.isInteger(memberSeatsNumber) &&
    memberSeatsNumber >= 1 &&
    memberSeatsNumber <= MAX_MEMBER_SEATS_PER_WORKSPACE
  // Same floor and ceiling a paid top-up has: ¥1 – ¥10000, in 分.
  const walletCents = topupCentsFromYuan(walletYuan)
  const walletOk = walletCents !== null && walletCents >= MIN_TOPUP_CENTS && walletCents <= MAX_TOPUP_CENTS
  const grantOk = isWallet ? walletOk : memberSeatsOk
  const quantityOk = Number.isInteger(quantityNumber) && quantityNumber >= 1 && quantityNumber <= 500
  // A wallet balance never expires, so the term is neither asked for nor sent.
  const durationOk =
    isWallet || (Number.isInteger(durationNumber) && durationNumber >= 1 && durationNumber <= 3650)
  const previewPlan = !isWallet ? PLAN_CATALOG.find((plan) => plan.key === tier) : undefined

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
    if (!grantOk || !quantityOk || !durationOk) return
    setSaving(true)
    const request: AdminRedeemCodeCreateRequestView = {
      product,
      member_seats: isWallet ? 0 : memberSeatsNumber,
      tier: isWallet ? undefined : tier,
      ocr_credits: 0,
      wallet_cents: isWallet ? (walletCents ?? 0) : 0,
      quantity: quantityNumber,
      duration_days: isWallet ? 1 : durationNumber,
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
              <Field>
                <FieldLabel>兑换内容</FieldLabel>
                <Tabs
                  value={product}
                  onValueChange={(next) =>
                    setProduct(next === "wallet_credits" ? "wallet_credits" : "member_seats")
                  }
                >
                  <TabsList aria-label="兑换内容" className="h-9 w-full">
                    <TabsIndicator />
                    <TabsTrigger value="member_seats" className="h-8 flex-1 text-sm">
                      成员名额
                    </TabsTrigger>
                    <TabsTrigger value="wallet_credits" className="h-8 flex-1 text-sm">
                      钱包额度
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {!isWallet ? (
                  <FieldDescription>
                    成员名额码为覆盖式生效：用户兑换后其 Workspace 的原有套餐批次立即终止，剩余时长不结转、不抵扣。
                  </FieldDescription>
                ) : null}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {isWallet ? (
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
                  <>
                    <Field>
                      <FieldLabel htmlFor="redeem-seats">成员名额</FieldLabel>
                      <Input
                        id="redeem-seats"
                        type="number"
                        min={1}
                        max={MAX_MEMBER_SEATS_PER_WORKSPACE}
                        value={memberSeats}
                        onChange={(event) => setMemberSeats(event.target.value)}
                        placeholder={`1 – ${MAX_MEMBER_SEATS_PER_WORKSPACE} 名成员`}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="redeem-tier">档位</FieldLabel>
                      <Select
                        value={tier}
                        onValueChange={(next) => {
                          if (next) setTier(next as Exclude<PlanKey, "lite">)
                        }}
                      >
                        <SelectTrigger id="redeem-tier" aria-label="成员名额档位">
                          <SelectValue>
                            {() => previewPlan?.name ?? tier}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PAID_TIERS.map((plan) => (
                            <SelectItem key={plan.key} value={plan.key}>
                              {plan.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="redeem-duration">有效天数</FieldLabel>
                      <Input
                        id="redeem-duration"
                        type="number"
                        min={1}
                        max={3650}
                        value={durationDays}
                        onChange={(event) => setDurationDays(event.target.value)}
                        placeholder="天数"
                      />
                    </Field>
                  </>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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
                {isWallet ? (
                  <>
                    <span className="font-mono tabular-nums">
                      {walletOk ? formatYuan(centsToMicrofen(walletCents ?? 0)) : "—"}
                    </span>{" "}
                    · 钱包额度
                  </>
                ) : (
                  <>
                    <span className="font-mono tabular-nums">
                      {memberSeatsOk ? memberSeatsNumber : "—"}
                    </span>{" "}
                    名成员 /{" "}
                    <span className="font-mono tabular-nums">
                      {durationOk ? durationNumber : "—"}
                    </span>{" "}
                    天{previewPlan ? " · " + previewPlan.name : ""}
                  </>
                )}
              </p>
            </FieldGroup>
          </div>
          <PlatformAdminDialogFooter>
            <Button type="submit" disabled={saving || !grantOk || !quantityOk || !durationOk}>
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
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`复制 ${code.code_preview}`}
                      onClick={() => void copyText(code.code_preview, `已复制 ${code.code_preview}`)}
                    >
                      <Copy aria-hidden />
                    </Button>
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
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium">{amount}</span>
      <span className="font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">
        {detail}
      </span>
    </span>
  )
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
    "product: " + (first?.product ?? ""),
    "duration_days: " + String(first?.duration_days ?? ""),
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
