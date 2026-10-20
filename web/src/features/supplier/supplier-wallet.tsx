/**
 * 厂家钱包：可提现余额、提现冻结，以及提现申请。
 * 一个登录可以属于多家工厂，申请必须点名 sourceId。失败只走 toast。
 */
import { useCallback, useState } from "react"

import {
  listSupplierWallets,
  listSupplierWithdrawals,
  requestSupplierWithdrawal,
  type SupplierWalletView,
  type SupplierWithdrawalView,
} from "@/bindings/http-supplier-portal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents, formatYuan, topupCentsFromYuan } from "@/lib/money"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"

import { SUPPLIER_PORTAL_POLL_MS } from "./supplier-board"
import {
  channelLabel,
  withdrawalBadgeVariant,
  withdrawalStatusLabel,
} from "./supplier-money"

const MIN_WITHDRAW_CENTS = 100
const MAX_WITHDRAW_CENTS = 100_000_000
const MICROFEN_PER_FEN = 1_000_000
/** 收款方式档位；显示名统一走 channelLabel（supplier-money.ts）。 */
const CHANNELS = ["alipay", "wechat", "bank"] as const

type Draft = {
  sourceId: string
  yuan: string
  channel: (typeof CHANNELS)[number]
  account: string
  realName: string
}

const EMPTY_DRAFT: Draft = {
  sourceId: "",
  yuan: "",
  channel: "alipay",
  account: "",
  realName: "",
}

export function SupplierWalletCard({ bare = false }: { bare?: boolean } = {}) {
  const [wallets, setWallets] = useState<SupplierWalletView[]>()
  const [withdrawals, setWithdrawals] = useState<SupplierWithdrawalView[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [nextWallets, nextWithdrawals] = await Promise.all([
        listSupplierWallets(),
        listSupplierWithdrawals(),
      ])
      setWallets(nextWallets)
      setWithdrawals(nextWithdrawals)
      setLoadFailed(false)
    } catch (reason) {
      setLoadFailed(true)
      if (!quiet) notifyCommandError(reason, "钱包读取失败，请稍后重试。")
    }
  }, [])

  useVisiblePolling({
    enabled: true,
    intervalMs: SUPPLIER_PORTAL_POLL_MS,
    onPoll: (trigger) => {
      void refresh(trigger !== "mount")
    },
  })

  const selected = wallets?.find((wallet) => wallet.source_id === draft.sourceId)

  function begin() {
    const first = wallets?.find((wallet) => wallet.available_microfen >= MIN_WITHDRAW_CENTS * MICROFEN_PER_FEN)
    setDraft({ ...EMPTY_DRAFT, sourceId: first?.source_id ?? wallets?.[0]?.source_id ?? "" })
    setInvalid(false)
    setOpen(true)
  }

  function parsedCents(): number | null {
    const cents = topupCentsFromYuan(draft.yuan)
    if (cents == null || cents < MIN_WITHDRAW_CENTS || cents > MAX_WITHDRAW_CENTS) return null
    return cents
  }

  function askConfirm() {
    const cents = parsedCents()
    const account = draft.account.trim()
    const realName = draft.realName.trim()
    const wallet = wallets?.find((item) => item.source_id === draft.sourceId)
    const enough = wallet != null && cents != null && cents * MICROFEN_PER_FEN <= wallet.available_microfen
    if (!wallet || cents == null || account.length < 1 || account.length > 64 || realName.length < 1 || realName.length > 32 || !enough) {
      setInvalid(true)
      notifyError("请看一下金额、收款账号和姓名。至少 1 元，不能超过能取的钱。")
      return
    }
    setInvalid(false)
    setConfirming(true)
  }

  async function submit() {
    const cents = parsedCents()
    if (cents == null) return
    setBusy(true)
    try {
      await requestSupplierWithdrawal({
        source_id: draft.sourceId,
        amount_cents: cents,
        channel: draft.channel,
        account: draft.account.trim(),
        real_name: draft.realName.trim(),
      })
      notifySuccess("已提交，等打款")
      setConfirming(false)
      setOpen(false)
      await refresh()
    } catch (reason) {
      notifyCommandError(reason, "没提交上，请稍后再试。")
    } finally {
      setBusy(false)
    }
  }

  if (wallets === undefined) {
    return loadFailed ? (
      <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
        重试读取钱包
      </Button>
    ) : (
      <Spinner className="size-4" aria-label="正在读取钱包" />
    )
  }
  if (wallets.length === 0) return null

  const cents = parsedCents()
  const canWithdraw = wallets.some(
    (wallet) => wallet.available_microfen >= MIN_WITHDRAW_CENTS * MICROFEN_PER_FEN,
  )
  return (
    <section className={bare ? "flex flex-col gap-3" : "flex flex-col gap-4 rounded-lg border border-border bg-card p-4"}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-compact font-medium">钱包</h2>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Button type="button" size="sm" disabled={!canWithdraw} onClick={begin}>
                    取款
                  </Button>
                </span>
              }
            />
            {canWithdraw ? null : (
              <TooltipContent>满 1 元才能取，等发货到账。</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </div>
      <ul className="flex flex-col gap-2">
        {wallets.map((wallet) => (
          <li key={wallet.source_id} className="flex flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-compact">{wallet.name}</span>
              <span className="shrink-0 font-mono text-lg tabular-nums">{formatYuan(wallet.available_microfen)}</span>
            </span>
            {wallet.held_microfen > 0 ? (
              <span className="text-meta text-muted-foreground">取款中 {formatYuan(wallet.held_microfen)}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {withdrawals.length > 0 ? (
        <ul className="flex flex-col gap-2 border-t border-border pt-3">
          {withdrawals.map((item) => (
            <li key={item.withdrawal_id} className="flex flex-wrap items-center justify-between gap-2 text-compact">
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant={withdrawalBadgeVariant(item.status)}>
                  {withdrawalStatusLabel(item.status)}
                </Badge>
                <span className="truncate">{item.name} · {channelLabel(item.channel)} · {formatCents(item.amount_cents)}</span>
              </span>
              <span className="text-meta text-muted-foreground">{formatDateTimeShort(item.requested_at_ms)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-auto">
          <DialogHeader>
            <DialogTitle>取款</DialogTitle>
            <DialogDescription>提交后这笔钱先扣住。一次只能取一笔。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {wallets.length > 1 ? (
              <Field>
                <FieldLabel>哪个厂</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  {wallets.map((wallet) => (
                    <Button
                      key={wallet.source_id}
                      type="button"
                      size="sm"
                      variant={draft.sourceId === wallet.source_id ? "default" : "outline"}
                      aria-pressed={draft.sourceId === wallet.source_id}
                      onClick={() => setDraft({ ...draft, sourceId: wallet.source_id })}
                    >
                      {wallet.name}
                    </Button>
                  ))}
                </div>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="withdraw-yuan">金额（元）</FieldLabel>
              <Input
                id="withdraw-yuan"
                inputMode="decimal"
                autoComplete="off"
                value={draft.yuan}
                aria-invalid={invalid && cents == null}
                onChange={(event) => setDraft({ ...draft, yuan: event.target.value })}
              />
              {selected ? (
                <p className="text-meta text-muted-foreground">能取 {formatYuan(selected.available_microfen)}，至少 1 元。</p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel>收款方式</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {CHANNELS.map((channel) => (
                  <Button
                    key={channel}
                    type="button"
                    size="sm"
                    variant={draft.channel === channel ? "default" : "outline"}
                    aria-pressed={draft.channel === channel}
                    onClick={() => setDraft({ ...draft, channel })}
                  >
                    {channelLabel(channel)}
                  </Button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="withdraw-account">收款账号</FieldLabel>
              <Input
                id="withdraw-account"
                autoComplete="off"
                value={draft.account}
                aria-invalid={invalid && (draft.account.trim().length < 1 || draft.account.trim().length > 64)}
                onChange={(event) => setDraft({ ...draft, account: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="withdraw-name">收款人姓名</FieldLabel>
              <Input
                id="withdraw-name"
                autoComplete="name"
                value={draft.realName}
                aria-invalid={invalid && (draft.realName.trim().length < 1 || draft.realName.trim().length > 32)}
                onChange={(event) => setDraft({ ...draft, realName: event.target.value })}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button type="button" onClick={askConfirm}>提交</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="确认取款"
        description={
          (selected?.name ?? "") +
          " 取 " +
          formatCents(cents ?? 0) +
          " 到 " +
          channelLabel(draft.channel) +
          " " +
          draft.account.trim() +
          "（" +
          draft.realName.trim() +
          "）。提交后不可自行撤回。"
        }
        confirmText="确认取款"
        variant="brand"
        busy={busy}
        onConfirm={() => void submit()}
      />
    </section>
  )
}
