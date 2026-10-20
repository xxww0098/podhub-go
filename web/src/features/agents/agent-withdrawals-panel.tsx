import { useCallback, useEffect, useState } from "react"
import { Check, Copy, Landmark, X } from "lucide-react"

import type { AdminAgentWithdrawal } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { payoutChannelLabel, WITHDRAWAL_STATUS_LABELS, WITHDRAWAL_STATUS_TONES } from "@/features/agents/agent-labels"
import { PlatformAdminSection } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/error-message"
import { copyToClipboard } from "@/lib/clipboard"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"
import {
  clearLive,
  notifyCommandError,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"

const WITHDRAWALS_LIVE = "agent-withdrawals-load"

/**
 * The manual-payout queue: pending withdrawals the platform owes a human
 * transfer, plus the decided history. Paying or rejecting is the only write —
 * the row's payout account is the snapshot the Agent filed, so nothing the
 * admin sees here can be redirected.
 */
export function AgentWithdrawalsPanel() {
  const active = useScreenActive()
  const [tab, setTab] = useState<"pending" | "paid" | "rejected">("pending")
  const [pendingCount, setPendingCount] = useState(0)
  const [rows, setRows] = useState<AdminAgentWithdrawal[]>([])
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState<AdminAgentWithdrawal>()
  const [rejecting, setRejecting] = useState<AdminAgentWithdrawal>()
  const [copied, setCopied] = useState<string>()

  const load = useCallback(async () => {
    try {
      const [listed, pending] = await Promise.all([
        adminHttp.adminListAgentWithdrawals(tab === "pending" ? undefined : tab),
        adminHttp.adminListAgentWithdrawals("pending"),
      ])
      setRows(tab === "pending" ? pending : listed)
      setPendingCount(pending.length)
      clearLive(WITHDRAWALS_LIVE)
    } catch (reason) {
      notifyLive({
        id: WITHDRAWALS_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "提现列表读取失败。"),
        action: { label: "重试", onClick: () => void load() },
      })
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    if (active) void load()
    return () => clearLive(WITHDRAWALS_LIVE)
  }, [active, load])

  async function copyAccount(account: string) {
    await copyToClipboard(account, {
      success: `已复制 ${account}`,
      failure: "复制失败，请手动选择账号。",
      onCopied: () => setCopied(account),
    })
  }

  return (
    <PlatformAdminSection
      title="提现审核"
      count={pendingCount}
      action={
        <Tabs
          value={tab}
          onValueChange={(next) =>
            setTab(next === "paid" ? "paid" : next === "rejected" ? "rejected" : "pending")
          }
        >
          <TabsList aria-label="提现状态" className="h-9">
            <TabsIndicator />
            <TabsTrigger value="pending" className="h-8">待处理</TabsTrigger>
            <TabsTrigger value="paid" className="h-8">已打款</TabsTrigger>
            <TabsTrigger value="rejected" className="h-8">已拒绝</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {loading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          正在读取提现…
        </p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {tab === "pending" ? "没有在途提现申请。" : "暂无记录。"}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>代理</TableHead>
                <TableHead>单号</TableHead>
                <TableHead>收款方式</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>申请时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.public_id}>
                  <TableCell className="text-xs">{row.agent_email}</TableCell>
                  <TableCell className="font-mono text-xs">{row.public_id}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md text-xs whitespace-nowrap hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      aria-label={`复制 ${row.account}`}
                      onClick={() => void copyAccount(row.account)}
                    >
                      {payoutChannelLabel(row.channel)} <span className="font-mono">{row.account}</span>
                      {copied === row.account ? (
                        <Check aria-hidden className="size-3.5 text-st-good-ink" />
                      ) : (
                        <Copy aria-hidden className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                    <span className="block text-xs text-muted-foreground">{row.real_name}</span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(row.amount_cents)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTimeShort(row.requested_at)}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={row.status}
                      tone={WITHDRAWAL_STATUS_TONES[row.status] ?? "idle"}
                      label={WITHDRAWAL_STATUS_LABELS[row.status] ?? row.status}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === "pending" ? (
                      <span className="inline-flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setPaying(row)}
                        >
                          <Landmark data-icon="inline-start" />
                          已打款
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setRejecting(row)}
                        >
                          <X data-icon="inline-start" />
                          拒绝
                        </Button>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <WithdrawalPayDialog
        row={paying}
        onOpenChange={(open) => {
          if (!open) setPaying(undefined)
        }}
        onDone={() => {
          setPaying(undefined)
          void load()
        }}
      />
      <WithdrawalRejectDialog
        row={rejecting}
        onOpenChange={(open) => {
          if (!open) setRejecting(undefined)
        }}
        onDone={() => {
          setRejecting(undefined)
          void load()
        }}
      />
    </PlatformAdminSection>
  )
}

export function WithdrawalPayDialog({
  row,
  onOpenChange,
  onDone,
}: {
  row?: AdminAgentWithdrawal
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reference, setReference] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!row) return
    setSaving(true)
    try {
      await adminHttp.adminPayAgentWithdrawal(
        row.public_id,
        reference.trim() === "" ? undefined : reference.trim(),
      )
      notifySuccess(`已标记打款：${formatCents(row.amount_cents)}`)
      onDone()
    } catch (reason) {
      notifyCommandError(reason, "标记打款失败，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!saving) onOpenChange(open)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认已打款</DialogTitle>
          <DialogDescription className="break-words">
            {row
              ? `向 ${row.agent_email} 的${payoutChannelLabel(row.channel)} ${row.account}（${row.real_name}）人工转账 ${formatCents(row.amount_cents)} 后确认。`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Input
            aria-label="打款流水号"
            placeholder="流水号（可选）"
            maxLength={128}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            流水号会记录在提现单上用于对账；确认后金额从在途转为已支出。
          </p>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              确认已打款
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function WithdrawalRejectDialog({
  row,
  onOpenChange,
  onDone,
}: {
  row?: AdminAgentWithdrawal
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const canSubmit = reason.trim() !== ""

  async function submit() {
    if (!row || !canSubmit) return
    setSaving(true)
    try {
      await adminHttp.adminRejectAgentWithdrawal(row.public_id, reason.trim())
      notifySuccess("已拒绝并释放冻结金额")
      onDone()
    } catch (reason_) {
      notifyCommandError(reason_, "拒绝提现失败，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!saving) onOpenChange(open)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>拒绝提现</DialogTitle>
          <DialogDescription className="break-words">
            {row
              ? `拒绝 ${row.agent_email} 的 ${formatCents(row.amount_cents)} 提现，冻结金额回到可用余额。`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Textarea
            aria-label="拒绝原因"
            placeholder="拒绝原因（必填，会展示给代理）"
            maxLength={200}
            aria-invalid={!canSubmit}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <DialogFooter>
            <Button type="submit" variant="outline" disabled={!canSubmit || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
              确认拒绝
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
