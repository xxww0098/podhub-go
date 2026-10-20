import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Wallet } from "lucide-react"

import type {
  AccountOverview,
  AiRechargeOrderView,
  PaymentMethodsData,
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
import { AlipayQr } from "@/features/plans/alipay-qr"
import {
  PaymentChannelList,
  paymentMethodKeys,
  paymentOrderPresentation,
  paymentProviderLabel,
} from "@/features/plans/payment-channels"
import { loadWallet, rememberWallet } from "@/features/usage/wallet-cache"
import {
  commandErrorCode,
  errorMessage,
  WORKSPACE_MISMATCH_CODE,
} from "@/lib/error-message"
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, formatYuan, topupCentsFromYuan } from "@/lib/money"
import { clearLive, notifyCommandError, notifyInfo, notifyLive, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"

/**
 * 去充值 opens this dialog in place — no detour through 加购. It is the same
 * Payment Order pipeline as seat purchases (`POST /api/ai/recharge/orders`):
 * the channel list is whatever the platform admin switched on, and a pending
 * order survives the dialog closing so the operator can resume paying.
 *
 * Top-up orders are not readable through `/api/orders/{public_id}` (that query
 * is member-seats only), so status refresh polls the wallet detail's
 * `recharges` page — and there is no self-serve cancel for a pending top-up.
 */

// Mirrors MIN_TOPUP_CENTS / MAX_TOPUP_CENTS in src/ai/mod.rs (¥1 – ¥10,000).
const QUICK_YUAN = [50, 100, 200, 500, 1000] as const

const RECHARGE_METHODS_LIVE = "recharge-payment-methods-load"
const RECHARGE_ORDER_LIVE = "recharge-order-load"
const RECHARGE_SWITCHED_LIVE = "recharge-workspace-switched"

export function RechargeDialog({
  open,
  onOpenChange,
  workspaceUuid,
  workspaceName,
  onOverviewChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceUuid?: string
  workspaceName?: string
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  const [yuan, setYuan] = useState("100")
  const [operationId, setOperationId] = useState<string>(() => crypto.randomUUID())
  const [provider, setProvider] = useState("")
  const [methods, setMethods] = useState<PaymentMethodsData>()
  const [methodsLoading, setMethodsLoading] = useState(false)
  const [methodsError, setMethodsError] = useState(false)
  const [methodsReload, setMethodsReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<AiRechargeOrderView>()
  const orderRef = useRef<AiRechargeOrderView | undefined>(undefined)
  const [lockedWorkspace, setLockedWorkspace] = useState<{ uuid: string; name: string }>()
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderLoadError, setOrderLoadError] = useState(false)
  const [orderLoadReason, setOrderLoadReason] = useState<unknown>()
  const [orderReload, setOrderReload] = useState(0)
  const [, setAutoRefreshFailed] = useState(false)
  const refreshInFlight = useRef(false)
  const workspaceSwitched = Boolean(
    lockedWorkspace && workspaceUuid && lockedWorkspace.uuid !== workspaceUuid,
  )

  const amountCents = topupCentsFromYuan(yuan)
  const amountValid =
    amountCents !== null &&
    amountCents >= MIN_TOPUP_CENTS &&
    amountCents <= MAX_TOPUP_CENTS

  /** Re-read the wallet detail and fold it into dialog state; the fresh wallet publishes to the shared cache. */
  const syncFromWallet = useCallback(async (): Promise<AiRechargeOrderView | undefined> => {
    const detail = await accountHttp.accountGetWalletDetail()
    rememberWallet(detail.wallet)
    const latest = orderRef.current
    const next = latest
      ? detail.recharges.find((row) => row.public_id === latest.public_id)
      : detail.recharges.find((row) => row.status === "pending")
    if (next) {
      orderRef.current = next
      setOrder(next)
    }
    return next
  }, [])

  // Payment methods load lazily on open; failures ride the live toast.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setMethods(undefined)
    setMethodsError(false)
    setMethodsLoading(true)
    clearLive(RECHARGE_METHODS_LIVE)
    accountHttp
      .accountGetPaymentMethods()
      .then(
        (next) => {
          if (cancelled) return
          setMethods(next)
          const keys = paymentMethodKeys(next)
          setProvider(
            (prev) =>
              prev || (keys.find((k) => k.includes("alipay")) ?? keys[0] ?? ""),
          )
        },
        (reason) => {
          if (cancelled) return
          setMethodsError(true)
          notifyLive({
            id: RECHARGE_METHODS_LIVE,
            type: "error",
            reason,
            title: errorMessage(reason, "支付方式读取失败，请重新读取。"),
            action: {
              label: "重试",
              onClick: () => setMethodsReload((value) => value + 1),
            },
          })
        },
      )
      .finally(() => {
        if (!cancelled) setMethodsLoading(false)
      })
    return () => {
      cancelled = true
      clearLive(RECHARGE_METHODS_LIVE)
    }
  }, [open, methodsReload])

  useEffect(() => {
    if (!orderLoadError) {
      clearLive(RECHARGE_ORDER_LIVE)
      return
    }
    notifyLive({
      id: RECHARGE_ORDER_LIVE,
      type: "error",
      reason: orderLoadReason,
      title: "无法确认是否已有待支付的充值订单。",
      action: { label: "重试", onClick: () => setOrderReload((value) => value + 1) },
    })
    return () => clearLive(RECHARGE_ORDER_LIVE)
  }, [orderLoadError, orderLoadReason])

  useEffect(() => {
    if (!workspaceSwitched) {
      clearLive(RECHARGE_SWITCHED_LIVE)
      return
    }
    notifyLive({
      id: RECHARGE_SWITCHED_LIVE,
      type: "error",
      title: "当前工作空间已切换，请关闭后重新打开充值。",
    })
    return () => clearLive(RECHARGE_SWITCHED_LIVE)
  }, [workspaceSwitched])

  // The lock is taken when the dialog opens, not in onOpenChange: the parent
  // owns `open`, so a controlled transition never fires the callback.
  useEffect(() => {
    if (!open) {
      setLockedWorkspace(undefined)
      return
    }
    setYuan("100")
    setProvider("")
    setOperationId(crypto.randomUUID())
    if (workspaceUuid) {
      setLockedWorkspace((current) =>
        current ?? { uuid: workspaceUuid, name: workspaceName ?? workspaceUuid },
      )
    }
  }, [open, workspaceUuid, workspaceName])

  // Surface a resumable pending order: the entry persists on the order, so a
  // top-up started earlier continues here instead of blocking on a 409.
  useEffect(() => {
    if (!open || !workspaceUuid) return
    let cancelled = false
    orderRef.current = undefined
    setOrder(undefined)
    setOrderLoadError(false)
    setOrderLoadReason(undefined)
    setAutoRefreshFailed(false)
    setOrderLoading(true)
    void (async () => {
      try {
        const detail = await accountHttp.accountGetWalletDetail()
        if (cancelled) return
        rememberWallet(detail.wallet)
        const pending = detail.recharges.find((row) => row.status === "pending")
        if (!pending) return
        orderRef.current = pending
        setOperationId(pending.operation_id)
        setOrder(pending)
      } catch (reason) {
        if (!cancelled) {
          setOrderLoadReason(() => reason)
          setOrderLoadError(true)
        }
      } finally {
        if (!cancelled) setOrderLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, orderReload, workspaceUuid])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!provider || !amountValid || amountCents === null) return
    if (!lockedWorkspace || workspaceSwitched) return
    setBusy(true)
    try {
      const created = await accountHttp.accountCreateRechargeOrder({
        operation_id: operationId,
        amount_cents: amountCents,
        provider,
        // B2: the server re-resolves the active Workspace and refuses when the
        // one this dialog locked no longer matches — the top-up would otherwise
        // fund a Workspace the operator never confirmed.
        expected_workspace_uuid: lockedWorkspace.uuid,
      })
      orderRef.current = created
      setOrder(created)
      notifySuccess("充值订单已创建", {
        description: created.pay_url
          ? "请打开托管收银台完成付款。"
          : created.qr_code
            ? "请扫码完成付款。"
            : (created.remittance ?? "请把单号发给运营，确认收款后余额到账。"),
      })
    } catch (reason) {
      if (commandErrorCode(reason) === WORKSPACE_MISMATCH_CODE) {
        // The switch landed server-side in another tab/device: repaint the
        // shell's standing and the wallet badge so the local switched guard
        // can engage. A mismatch is also a 409, so this must run before the
        // pending-order adoption below.
        try {
          onOverviewChange?.(await accountHttp.accountListWorkspaces())
        } catch {
          // A failed repaint keeps the refusal toast as the only notice.
        }
        void loadWallet().catch(() => {})
        notifyCommandError(reason, "下单失败，请稍后重试。")
        return
      }
      // A Workspace carries at most one pending top-up; on 409 adopt it so the
      // operator resumes paying instead of reading a refusal.
      if ([409, 503].includes((reason as { status?: number }).status ?? 0)) {
        try {
          if (await syncFromWallet()) {
            notifyInfo("当前工作空间已有待支付的充值订单", {
              description: "已打开进行中的订单，可继续完成付款。",
            })
            return
          }
        } catch (syncReason) {
          notifyCommandError(syncReason, "无法读取进行中的充值订单。")
          return
        }
      }
      notifyCommandError(reason, "下单失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function refreshOrder(options?: { quiet?: boolean }) {
    const current = orderRef.current
    if (!current || current.status !== "pending" || refreshInFlight.current) return
    refreshInFlight.current = true
    if (!options?.quiet) setBusy(true)
    try {
      const next = await syncFromWallet()
      if (!next || next.public_id !== current.public_id) return
      setAutoRefreshFailed(false)
      if (next.status === "paid") {
        notifySuccess("充值已到账")
      }
    } catch (reason) {
      if (options?.quiet) {
        setAutoRefreshFailed(true)
      } else {
        notifyCommandError(reason, "查询订单失败。")
      }
    } finally {
      refreshInFlight.current = false
      if (!options?.quiet) setBusy(false)
    }
  }

  async function recoverOrder() {
    const current = orderRef.current
    if (!current || current.status !== "pending") return
    setBusy(true)
    try {
      const next = await accountHttp.accountRecoverRechargeOrder(current.public_id)
      orderRef.current = next
      setOrder(next)
      setAutoRefreshFailed(false)
    } catch (reason) {
      notifyCommandError(reason, "找回支付入口失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  useVisiblePolling({
    enabled: open && order?.status === "pending",
    intervalMs: 3000,
    restartKey: order?.public_id ?? "",
    onPoll: () => {
      void refreshOrder({ quiet: true })
    },
  })

  function openCheckout() {
    const current = orderRef.current
    if (!current || current.status !== "pending" || !current.pay_url) return
    window.open(current.pay_url, "_blank", "noopener")
  }

  function changeOpen(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setProvider("")
      if (orderRef.current && orderRef.current.status !== "pending") {
        orderRef.current = undefined
        setOrder(undefined)
        setOrderReload((value) => value + 1)
      }
    }
  }

  const pending = order?.status === "pending"
  const orderState = order ? paymentOrderPresentation(order.status) : undefined
  const submitBlocked =
    busy ||
    orderLoading ||
    orderLoadError ||
    workspaceSwitched ||
    !lockedWorkspace ||
    !provider ||
    !amountValid ||
    methodsLoading ||
    methodsError

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="flex max-h-[min(40rem,calc(100vh-2rem))] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="flex flex-col gap-3.5 px-6 pb-4 pt-6">
          <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
            <Wallet className="size-4" strokeWidth={2.5} />
          </span>
          <DialogHeader className="gap-1.5 pr-8">
            <DialogTitle className="text-xl font-semibold tracking-[-0.01em]">
              钱包充值
            </DialogTitle>
            <DialogDescription>
              为{lockedWorkspace ? `「${lockedWorkspace.name}」` : "当前工作空间"}
              的创建者钱包充值。同一创建者的所有工作空间共用余额。
            </DialogDescription>
          </DialogHeader>
        </div>

        {order ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-border/60 px-6 py-5">
            <div
              className="flex flex-wrap items-center justify-between gap-2"
              role="status"
              aria-live="polite"
            >
              <p className="font-mono text-sm">{order.public_id}</p>
              <StateChip
                status={order.status}
                label={orderState?.label}
                tone={orderState?.tone}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              充值 {formatYuan(order.topup_microfen)} ·{" "}
              {paymentProviderLabel(order.provider)}
            </p>
            {order.qr_code ? (
              <>
                <AlipayQr value={order.qr_code} />
                <p className="text-sm text-muted-foreground">
                  请扫码完成付款。到账后此页会自动更新。
                </p>
              </>
            ) : order.remittance ? (
              <p className="text-sm text-muted-foreground">{order.remittance}</p>
            ) : pending && !order.pay_url ? (
              <p className="text-sm text-muted-foreground">
                支付渠道结果尚未确认，请稍后刷新，继续使用原订单付款。
              </p>
            ) : null}
            {pending && order.pay_url ? (
              <Button
                type="button"
                variant="outline"
                disabled={workspaceSwitched}
                onClick={openCheckout}
              >
                在浏览器中继续支付
              </Button>
            ) : null}
            {pending && order.provider !== "manual" && !order.qr_code && !order.pay_url ? (
              <div className="flex items-center justify-between gap-2" role="status">
                <p className="text-sm text-muted-foreground">付款入口尚未就绪，可找回原订单的入口。</p>
                <Button type="button" variant="outline" disabled={busy || workspaceSwitched} onClick={() => void recoverOrder()}>
                  找回支付入口
                </Button>
              </div>
            ) : null}
            <DialogFooter className="m-0 mt-auto px-0">
              {pending ? (
                <Button
                  type="button"
                  variant="brand"
                  disabled={busy || workspaceSwitched}
                  aria-busy={busy}
                  onClick={() => void refreshOrder()}
                >
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  刷新状态
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="brand"
                  onClick={() => changeOpen(false)}
                >
                  完成
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto border-t border-border/60 px-6 py-5"
          >
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                充值金额
              </span>
              <div
                className="grid grid-cols-5 gap-1.5"
                role="group"
                aria-label="快捷金额"
              >
                {QUICK_YUAN.map((pick) => {
                  const isSelected = yuan === String(pick)
                  return (
                    <button
                      key={pick}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => { setYuan(String(pick)); setOperationId(crypto.randomUUID()) }}
                      className={cn(
                        "h-7 rounded-md text-xs font-medium transition-colors cursor-pointer",
                        isSelected
                          ? "bg-brand text-brand-foreground hover:bg-brand/90"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      ¥{pick}
                    </button>
                  )
                })}
              </div>
              <div className="flex h-10 items-center rounded-lg border border-input bg-background transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                <span className="pl-3 font-mono text-sm text-muted-foreground">¥</span>
                <Input
                  type="number"
                  min={1}
                  max={10_000}
                  step="0.01"
                  value={yuan}
                  onChange={(event) => { setYuan(event.target.value); setOperationId(crypto.randomUUID()) }}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 font-mono text-base font-semibold tabular-nums shadow-none focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  aria-label="充值金额（元）"
                  aria-invalid={yuan.trim() !== "" && !amountValid}
                  required
                />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                单笔 ¥1 – ¥10,000；同一工作空间同一时间只允许一笔待支付充值。
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                支付渠道
              </span>
              <PaymentChannelList
                methods={methods}
                loading={methodsLoading}
                error={methodsError}
                value={provider}
                onChange={(next) => { setProvider(next); setOperationId(crypto.randomUUID()) }}
                onRetry={() => setMethodsReload((value) => value + 1)}
                emptyHint="管理员尚未开通支付渠道，可先用兑换码充值。"
              />
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted-foreground">实付金额</span>
                <span className="font-mono text-xl font-bold tabular-nums tracking-tight">
                  {amountValid && amountCents !== null
                    ? formatYuan(amountCents * 1_000_000)
                    : "—"}
                </span>
              </div>
              <p className="border-t border-border/60 pt-3 text-meta leading-5 text-muted-foreground">
                支付成功后余额实时充入工作空间创建者的钱包，余额不过期。
              </p>
              <Button
                type="submit"
                variant="brand"
                disabled={submitBlocked}
                aria-busy={busy}
                className="h-10 w-full font-semibold"
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}
                创建充值订单
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
