import { useEffect, useState } from "react"
import { ArrowRightLeft, Banknote, Check } from "lucide-react"

import type {
  AgentLedgerEntry,
  AgentPayoutAccount,
  AgentWithdrawal,
  AgentWorkbench,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { StateChip } from "@/components/state-chip"
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
import { PayoutAccountForm } from "@/features/agents/payout-account-form"
import {
  WITHDRAWAL_STATUS_LABELS,
  WITHDRAWAL_STATUS_TONES,
  payoutChannelLabel,
} from "@/features/agents/agent-labels"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents, topupCentsFromYuan } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

const LEDGER_LABELS: Record<string, string> = {
  commission: "佣金入账",
  transfer_out: "转入钱包",
}

/**
 * The commission wallet's own card: three numbers the money actually sits in,
 * the payout account withdrawals pay to, and the two moves — withdraw to
 * 支付宝 / 微信, or transfer 1:1 into the Agent's own wallet. Every amount
 * here came off the API; this component only formats it.
 */
export function AgentWalletCard({
  workbench,
  withdrawals,
  ledger,
  onChanged,
}: {
  workbench: AgentWorkbench
  withdrawals: AgentWithdrawal[]
  ledger: AgentLedgerEntry[]
  onChanged: () => void
}) {
  const [payout, setPayout] = useState<AgentPayoutAccount | null | undefined>(
    workbench.payout_account,
  )
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)

  const pending = withdrawals.find((row) => row.status === "pending")

  return (
    <section
      aria-label="佣金余额"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">佣金余额</p>
          <p className="text-xs text-muted-foreground">
            {workbench.status === "disabled"
              ? "代理已停用，不再产生新佣金；余额仍可提现或转入钱包。"
              : "首笔合格订单的返点进入这里，可提现或转入钱包。"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(pending)}
            onClick={() => setWithdrawOpen(true)}
          >
            <Banknote data-icon="inline-start" />
            申请提现
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!workbench.wallet_transfer_available}
            title={
              workbench.wallet_transfer_available
                ? undefined
                : "需要一个你自己的工作空间来接收转入"
            }
            onClick={() => setTransferOpen(true)}
          >
            <ArrowRightLeft data-icon="inline-start" />
            转入钱包
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-px border-b border-border bg-border text-sm">
        <Stat label="可用余额" value={formatCents(workbench.wallet.available_cents)} />
        <Stat label="在途提现" value={formatCents(workbench.wallet.held_cents)} />
        <Stat label="累计佣金" value={formatCents(workbench.credited_total_cents)} />
      </dl>

      <PayoutAccountForm
        account={payout ?? null}
        onSaved={(next) => {
          setPayout(next)
          onChanged()
        }}
      />

      {withdrawals.length > 0 ? (
        <div className="border-t border-border">
          <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">提现记录</p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>单号</TableHead>
                <TableHead>收款方式</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {withdrawals.map((row) => (
                <TableRow key={row.public_id}>
                  <TableCell className="font-mono text-xs">{row.public_id}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {payoutChannelLabel(row.channel)} {row.account}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(row.amount_cents)}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={row.status}
                      tone={WITHDRAWAL_STATUS_TONES[row.status] ?? "idle"}
                      label={
                        row.status === "rejected" && row.reject_reason
                          ? `${WITHDRAWAL_STATUS_LABELS.rejected} · ${row.reject_reason}`
                          : (WITHDRAWAL_STATUS_LABELS[row.status] ?? row.status)
                      }
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTimeShort(row.decided_at ?? row.requested_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {ledger.length > 0 ? (
        <div className="border-t border-border">
          <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">佣金流水</p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>类型</TableHead>
                <TableHead className="text-right">变动</TableHead>
                <TableHead className="text-right">余额</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((entry, index) => (
                <TableRow key={`${entry.created_at}-${index}`}>
                  <TableCell className="text-sm">
                    {LEDGER_LABELS[entry.entry_type] ?? entry.entry_type}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {entry.amount_cents > 0 ? "+" : ""}
                    {formatCents(entry.amount_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatCents(entry.balance_after_cents)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTimeShort(entry.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <WithdrawDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        availableCents={workbench.wallet.available_cents}
        minWithdrawCents={workbench.min_withdraw_cents}
        payout={payout ?? null}
        onFiled={() => {
          setWithdrawOpen(false)
          onChanged()
        }}
      />
      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        availableCents={workbench.wallet.available_cents}
        onDone={() => {
          setTransferOpen(false)
          onChanged()
        }}
      />
    </section>
  )
}

function WithdrawDialog({
  open,
  onOpenChange,
  availableCents,
  minWithdrawCents,
  payout,
  onFiled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableCents: number
  minWithdrawCents: number
  payout: AgentPayoutAccount | null
  onFiled: () => void
}) {
  const [yuan, setYuan] = useState("")
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setYuan((availableCents / 100).toFixed(2))
  }, [open, availableCents])
  const cents = topupCentsFromYuan(yuan)
  const valid =
    cents !== null && cents >= minWithdrawCents && cents <= availableCents

  async function submit() {
    if (!valid || cents === null) return
    setSaving(true)
    try {
      const filed = await accountHttp.agentRequestWithdrawal(cents)
      notifySuccess(`提现申请已提交：${formatCents(filed.amount_cents)}`)
      onFiled()
    } catch (reason) {
      notifyCommandError(reason, "提现申请失败，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>申请提现</DialogTitle>
          <DialogDescription className="break-words">
            {payout
              ? `打款到 ${payoutChannelLabel(payout.channel)} ${payout.account}（${payout.real_name}）`
              : "请先保存收款方式再申请提现。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="提现金额"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="w-40"
              placeholder="金额"
              aria-invalid={yuan !== "" && !valid}
              value={yuan}
              onChange={(event) => setYuan(event.target.value)}
            />
            <span className="text-sm text-muted-foreground">元</span>
          </div>
          <p className="text-xs text-muted-foreground">
            最低 {formatCents(minWithdrawCents)}，可用 {formatCents(availableCents)}；
            申请后金额冻结，同一时间在途提现不超过一笔。
          </p>
          <DialogFooter>
            <Button type="submit" disabled={!valid || !payout || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              提交提现
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TransferDialog({
  open,
  onOpenChange,
  availableCents,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableCents: number
  onDone: () => void
}) {
  const [yuan, setYuan] = useState("")
  const [saving, setSaving] = useState(false)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (open) {
      setYuan((availableCents / 100).toFixed(2))
      setOperationId(crypto.randomUUID())
    }
  }, [open, availableCents])
  const cents = topupCentsFromYuan(yuan)
  const valid = cents !== null && cents <= availableCents

  async function submit() {
    if (!valid || cents === null) return
    setSaving(true)
    try {
      const moved = await accountHttp.agentTransferToWallet(operationId, cents)
      notifySuccess(
        `已转入钱包 ${formatCents(moved.amount_cents)} → ${moved.workspace_name}`,
      )
      onDone()
    } catch (reason) {
      notifyCommandError(reason, "转入钱包失败，请稍后重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>转入钱包</DialogTitle>
          <DialogDescription className="break-words">
            佣金余额 1:1 转入你自己的钱包，即时到账。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="转入金额"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="w-40"
              placeholder="金额"
              aria-invalid={yuan !== "" && !valid}
              value={yuan}
              onChange={(event) => setYuan(event.target.value)}
            />
            <span className="text-sm text-muted-foreground">元</span>
          </div>
          <p className="text-xs text-muted-foreground">
            最多可转 {formatCents(availableCents)}。
          </p>
          <DialogFooter>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              确认转入
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  )
}
