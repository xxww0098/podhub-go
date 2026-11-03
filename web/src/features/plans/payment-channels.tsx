import { useId } from "react"
import { Building2, Check, CreditCard } from "lucide-react"

import type { PaymentMethodsData } from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
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
  layout = "list",
}: {
  methods?: PaymentMethodsData
  loading?: boolean
  error?: boolean
  value: string
  onChange: (provider: string) => void
  onRetry: () => void
  emptyHint: string
  /** `grid` lays the channels side by side with the hint as a tooltip, for narrow-height dialogs. */
  layout?: "list" | "grid" | "compact"
}) {
  const radioGroupId = useId()
  const compact = layout === "compact"
  const availableMethods = paymentMethodKeys(methods)
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-14 animate-pulse rounded-xl border border-border bg-muted/40" />
        <div className="h-14 animate-pulse rounded-xl border border-border bg-muted/40" />
      </div>
    )
  }
  if (error) {
    // The refusal text already rides the live toast; the slot keeps only the retry.
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <span className="text-compact text-muted-foreground">支付方式未能读取</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    )
  }
  if (availableMethods.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-compact leading-5 text-muted-foreground">
        {emptyHint}
      </p>
    )
  }
  return (
    <div className={cn("gap-2", compact ? "grid grid-cols-1 @xs:grid-cols-2 @sm:grid-cols-3" : layout === "grid" ? "grid grid-cols-1 sm:grid-cols-3" : "flex flex-col")} role="radiogroup" aria-label="支付渠道">
      {availableMethods.map((method) => {
        const isAlipay = method.includes("alipay")
        const isWechat = method.includes("wechat")
        const isManual = method === "manual"
        const isSelected = value === method
        const hint = isAlipay
          ? "支付宝扫码 / 花呗 / 余额"
          : isWechat
            ? "微信扫一扫，即时到账"
            : isManual
              ? "对公汇款 / 线下转账"
              : "在线结算"
        return (
          <label
            key={method}
            title={hint}
            className={cn(
              "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2 text-left outline-none transition-[border-color,box-shadow,background-color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              isSelected
                ? "border-brand bg-brand-soft/40 shadow-[0_0_0_1px_var(--brand)]"
                : "border-border-strong bg-card hover:border-muted-foreground/50 hover:bg-muted/40",
              compact && "justify-center gap-2 rounded-2xl px-2.5 text-center shadow-none",
            )}
          >
            <input type="radio" name={`${radioGroupId}-payment`} value={method} checked={isSelected} onChange={() => onChange(method)} className="sr-only" />
            <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-lg", compact ? "size-6" : "size-9")}>
              {isAlipay ? (
                <AlipayLogo className={compact ? "size-6" : "size-9"} />
              ) : isWechat ? (
                <WechatLogo className={compact ? "size-6" : "size-9"} />
              ) : isManual ? (
                <span className={cn("flex items-center justify-center rounded-lg bg-st-attest-soft text-st-attest-ink", compact ? "size-6" : "size-9")}>
                  <Building2 aria-hidden className="size-4" />
                </span>
              ) : (
                <span className={cn("flex items-center justify-center rounded-lg bg-muted text-muted-foreground", compact ? "size-6" : "size-9")}>
                  <CreditCard aria-hidden className="size-4" />
                </span>
              )}
            </span>
            <span className={cn("min-w-0", !compact && "flex-1")}>
              <span className={cn("flex items-center gap-1.5 font-medium text-foreground", compact ? "text-meta" : "text-compact")}>
                {paymentProviderLabel(method)}
                {isAlipay && !compact ? (
                  <Badge variant="brand" className="h-4.5 px-1.5">推荐</Badge>
                ) : null}
              </span>
              {layout === "list" && <span className="block break-words text-meta text-muted-foreground">{hint}</span>}
            </span>
            {!compact && <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                isSelected
                  ? "border-brand bg-brand text-brand-foreground"
                  : "border-border-strong bg-card",
              )}
            >
              {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>}
          </label>
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
  if (status === "pending" && entryState === "unselected") {
    return { label: "待选择支付方式", tone: "unknown" as const }
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
