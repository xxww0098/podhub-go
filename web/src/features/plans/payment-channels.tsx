import { Building2, CreditCard } from "lucide-react"

import type { PaymentMethodsData } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The channels the platform admin switched on in 平台管理 → 支付, rendered as
 * one radio list. Plans checkout and the wallet recharge dialog share it so a
 * channel that works for seats reads identically for top-ups.
 */
export function PaymentChannelList({
  methods,
  loading,
  error,
  value,
  onChange,
  onRetry,
  emptyHint,
}: {
  methods?: PaymentMethodsData
  loading?: boolean
  error?: boolean
  value: string
  onChange: (provider: string) => void
  onRetry: () => void
  emptyHint: string
}) {
  const availableMethods = paymentMethodKeys(methods)
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-11 animate-pulse rounded-lg border border-border/60 bg-muted/20" />
        <div className="h-11 animate-pulse rounded-lg border border-border/60 bg-muted/20" />
      </div>
    )
  }
  if (error) {
    // The refusal text already rides the live toast; the slot keeps only the retry.
    return (
      <div className="flex items-center rounded-lg border border-border/80 bg-muted/20 px-3 py-2">
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    )
  }
  if (availableMethods.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        {emptyHint}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="支付渠道">
      {availableMethods.map((method) => {
        const isAlipay = method.includes("alipay")
        const isWechat = method.includes("wechat")
        const isManual = method === "manual"
        const isSelected = value === method
        return (
          <button
            key={method}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(method)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all cursor-pointer",
              isSelected
                ? "border-brand/70 bg-brand-soft/40 ring-1 ring-brand/40 dark:border-brand/60 dark:bg-brand-soft/25 dark:ring-brand/30"
                : "border-border/80 bg-background hover:bg-muted/40",
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              {isAlipay ? (
                <AlipayLogo className="size-8" />
              ) : isWechat ? (
                <WechatLogo className="size-8" />
              ) : isManual ? (
                <span className="flex size-8 items-center justify-center rounded-lg bg-st-attest-soft text-st-attest-ink">
                  <Building2 className="size-4" />
                </span>
              ) : (
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <CreditCard className="size-4" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                {paymentProviderLabel(method)}
                {isAlipay ? (
                  <span className="rounded bg-brand-soft px-1.5 py-0.5 text-meta font-semibold text-brand-ink">
                    推荐
                  </span>
                ) : null}
              </span>
              <span className="block break-words text-meta text-muted-foreground">
                {isAlipay
                  ? "支付宝扫码 / 花呗 / 余额"
                  : isWechat
                    ? "微信扫一扫，即时到账"
                    : isManual
                      ? "对公汇款 / 线下转账"
                      : "在线结算"}
              </span>
            </span>
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border transition-all",
                isSelected
                  ? "border-brand bg-brand text-brand-foreground"
                  : "border-muted-foreground/40",
              )}
            >
              {isSelected ? <span className="size-1.5 rounded-full bg-brand-foreground" /> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function paymentProviderLabel(provider: string) {
  return (
    ({
      easypay_alipay: "EasyPay · 支付宝",
      easypay_wechat: "EasyPay · 微信支付",
      alipay: "支付宝",
      wechat: "微信支付",
      stripe: "Stripe",
      airwallex: "Airwallex",
      manual: "人工转账",
      // A fully credited order never touches a channel; the stored label is
      // the server's own marker.
      credit: "折算抵扣",
    } as Record<string, string>)[provider] ?? provider
  )
}

export function paymentMethodKeys(methods?: PaymentMethodsData) {
  return methods
    ? [...methods.providers, ...(methods.manual ? ["manual"] : [])]
    : []
}

const PAYMENT_ORDER_PRESENTATION = {
  pending: { label: "待支付", tone: "flight" },
  paid: { label: "已到账", tone: "good" },
  canceled: { label: "已取消", tone: "bad" },
} as const

/**
 * A pending order's `entry_state` narrows the chip: a stored entry is the
 * ordinary 待支付, an attempt with no entry yet is 待确认, and an upstream order
 * the channel cannot re-present is 待渠道确认 (the reservation is held).
 */
export function paymentOrderPresentation(status: string, entryState?: string) {
  if (status === "pending" && entryState === "entry_confirming") {
    return { label: "待渠道确认", tone: "unknown" as const }
  }
  if (status === "pending" && entryState === "entry_unknown") {
    return { label: "待确认", tone: "unknown" as const }
  }
  return (
    PAYMENT_ORDER_PRESENTATION[
      status as keyof typeof PAYMENT_ORDER_PRESENTATION
    ] ?? { label: status || "未知状态", tone: "unknown" as const }
  )
}

function AlipayLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} fill="none">
      <rect width="1024" height="1024" rx="220" fill="#1677FF" />
      <path
        d="M784.6 630.7c-52.9-20.9-122.9-46.7-203.4-74.9 31.4-66.2 56.7-142.9 73.1-224.2H808v-59.5H574.9V200h-78.6v72.1H256v59.5h332.9c-14.2 64.9-35.3 125.6-60.8 178.5-68.5-23.7-138.8-43.1-205.3-56.1l-18.4 56.4c64.5 13.1 133.5 32.5 200.7 56.1-51.2 87.7-119.5 161.8-199 217.1l43.2 46.5c86.4-61.1 160.7-142.9 216.7-239.7 72 26 135 50.1 184 70.3-43.4 97.4-124.9 178.6-231.1 228.1l40.4 50.4c126.9-59.2 222.8-158.4 272.2-277.6l-8.2-7.8z"
        fill="#ffffff"
      />
    </svg>
  )
}

function WechatLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} fill="none">
      <rect width="1024" height="1024" rx="220" fill="#07C160" />
      <path
        d="M400 240c-141.4 0-256 93.1-256 208 0 65.5 37.4 123.8 96 161.4l-24 72 84-42c30.2 10.7 64.1 16.6 100 16.6 13.6 0 26.9-0.9 39.8-2.6-6-20.7-9.8-42.5-9.8-65.4 0-128.1 121.8-232 272-232 9.4 0 18.6 0.4 27.8 1.3C707.9 299.8 565.4 240 400 240z"
        fill="#ffffff"
      />
      <circle cx="310" cy="350" r="25" fill="#07C160" />
      <circle cx="450" cy="350" r="25" fill="#07C160" />
      <path
        d="M700 480c-121.5 0-220 86-220 192 0 60.5 32.1 114.3 82.5 149l-20.6 61.9 72.2-36.1c25.9 9.2 55 14.2 85.9 14.2 121.5 0 220-86 220-192S821.5 480 700 480z"
        fill="#ffffff"
      />
      <circle cx="630" cy="570" r="20" fill="#07C160" />
      <circle cx="750" cy="570" r="20" fill="#07C160" />
    </svg>
  )
}
