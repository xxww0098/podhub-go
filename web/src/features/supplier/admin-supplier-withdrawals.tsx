/**
 * 平台员工处理厂家提现：待打款、已打款、已拒绝。
 * 打款和拒绝都要确认。收款账号只在这张工作表上给打款的人看，不进成功提示。
 */
import { useCallback, useEffect, useState } from "react"

import {
  listFactoryWithdrawals,
  payFactoryWithdrawal,
  rejectFactoryWithdrawal,
  type SupplierWithdrawalView,
} from "@/bindings/http-supplier-portal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

import {
  channelLabel,
  withdrawalBadgeVariant,
  withdrawalStatusLabel,
} from "./supplier-money"

/** 状态筛档位；标签复用 withdrawalStatusLabel，避免两套口径。 */
const FILTERS = ["", "requested", "paid", "rejected"] as const

export function AdminSupplierWithdrawals() {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("requested")
  const [rows, setRows] = useState<SupplierWithdrawalView[]>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [payTarget, setPayTarget] = useState<SupplierWithdrawalView>()
  const [rejectTarget, setRejectTarget] = useState<SupplierWithdrawalView>()
  const [reference, setReference] = useState("")
  const [reason, setReason] = useState("")
  const [confirmPay, setConfirmPay] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setRows(await listFactoryWithdrawals(status || undefined))
      setLoadFailed(false)
    } catch (error) {
      setRows(undefined)
      setLoadFailed(true)
      notifyCommandError(error, "提现列表读取失败，请稍后重试。")
    }
  }, [status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function pay() {
    if (!payTarget) return
    const note = reference.trim()
    if (note.length < 1 || note.length > 64) {
      setInvalid(true)
      notifyError("打款单号须为 1–64 个字符")
      return
    }
    setBusy(true)
    try {
      await payFactoryWithdrawal(payTarget.withdrawal_id, note)
      notifySuccess("已标记打款")
      setConfirmPay(false)
      setPayTarget(undefined)
      await refresh()
    } catch (error) {
      notifyCommandError(error, "打款失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!rejectTarget) return
    const note = reason.trim()
    if (note.length < 1 || note.length > 200) {
      setInvalid(true)
      notifyError("驳回原因须为 1–200 个字符")
      return
    }
    setBusy(true)
    try {
      await rejectFactoryWithdrawal(rejectTarget.withdrawal_id, note)
      notifySuccess("已拒绝提现，冻结已退回")
      setConfirmReject(false)
      setRejectTarget(undefined)
      await refresh()
    } catch (error) {
      notifyCommandError(error, "拒绝失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-md font-semibold">厂家提现</h2>
          <p className="text-compact text-muted-foreground">打款后不可退回。拒绝会把冻结退回厂家可提现余额。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter || "all"}
              type="button"
              size="sm"
              variant={status === filter ? "default" : "outline"}
              aria-pressed={status === filter}
              onClick={() => setStatus(filter)}
            >
              {filter ? withdrawalStatusLabel(filter) : "全部"}
            </Button>
          ))}
        </div>
      </div>
      {rows === undefined ? (
        loadFailed ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            重试读取提现
          </Button>
        ) : (
          <Spinner className="size-4" aria-label="正在读取提现" />
        )
      ) : rows.length === 0 ? (
        <p className="text-compact text-faint-foreground">没有符合筛选的提现。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {rows.map((row) => (
            <li key={row.withdrawal_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <Badge variant={withdrawalBadgeVariant(row.status)}>
                    {withdrawalStatusLabel(row.status)}
                  </Badge>
                  <span className="font-mono tabular-nums">{formatCents(row.amount_cents)}</span>
                </span>
                <span className="break-all text-compact text-muted-foreground">
                  {channelLabel(row.channel)} · {row.account} · {row.real_name} · {formatDateTimeShort(row.requested_at_ms)}
                </span>
              </span>
              {row.status === "requested" ? (
                <span className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => { setRejectTarget(row); setReason(""); setInvalid(false) }}>拒绝</Button>
                  <Button type="button" size="sm" onClick={() => { setPayTarget(row); setReference(""); setInvalid(false) }}>打款</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={payTarget !== undefined} onOpenChange={(next) => { if (!next) setPayTarget(undefined) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>标记打款</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="pay-reference">打款单号</FieldLabel>
            <Input
              id="pay-reference"
              value={reference}
              aria-invalid={invalid && (reference.trim().length < 1 || reference.trim().length > 64)}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPayTarget(undefined)}>取消</Button>
            <Button type="button" onClick={() => {
              if (reference.trim().length < 1 || reference.trim().length > 64) {
                setInvalid(true)
                notifyError("打款单号须为 1–64 个字符")
                return
              }
              setConfirmPay(true)
            }}>继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={rejectTarget !== undefined} onOpenChange={(next) => { if (!next) setRejectTarget(undefined) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝提现</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="reject-reason">原因</FieldLabel>
            <Textarea
              id="reject-reason"
              value={reason}
              aria-invalid={invalid && (reason.trim().length < 1 || reason.trim().length > 200)}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectTarget(undefined)}>取消</Button>
            <Button type="button" variant="destructive" onClick={() => {
              if (reason.trim().length < 1 || reason.trim().length > 200) {
                setInvalid(true)
                notifyError("驳回原因须为 1–200 个字符")
                return
              }
              setConfirmReject(true)
            }}>继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmPay}
        onOpenChange={setConfirmPay}
        title="确认已打款"
        description={(payTarget?.name ?? "") + " " + formatCents(payTarget?.amount_cents ?? 0) + "。确认后这笔冻结划出，不能退回。"}
        confirmText="确认打款"
        variant="brand"
        busy={busy}
        onConfirm={() => void pay()}
      />
      <ConfirmDialog
        open={confirmReject}
        onOpenChange={setConfirmReject}
        title="确认拒绝"
        description="拒绝后冻结退回厂家可提现余额。"
        confirmText="拒绝"
        busy={busy}
        onConfirm={() => void reject()}
      />
    </section>
  )
}
