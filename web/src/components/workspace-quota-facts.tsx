import { Sparkles, UsersRound, Wallet } from "lucide-react"

import type { WalletView, UsageStatsView } from "@/bindings/commands"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { loadWallet, useWallet } from "@/features/usage/wallet-cache"
import {
  loadUsageSummary,
  useUsageSummary,
} from "@/features/usage/usage-summary-cache"
import { formatYuan } from "@/lib/money"
import { preloadScreen } from "@/app/screen-loaders"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"

/**
 * Single-line wallet badge in the top header. Everything the relay bills — AI
 * calls and 识图 alike — is settled against the Workspace creator's shared prepaid balance, so the
 * readout names the money that is left. The header outlives every screen; it
 * reads the same wallet snapshot 用量 and redeem publish into, so a later
 * credit is not stuck behind the next 60s beat.
 */
export function HeaderWalletBalance({
  workspaceId,
  onOpenUsage,
  className,
}: {
  workspaceId?: number
  onOpenUsage?: () => void
  className?: string
}) {
  const wallet = useWallet()
  const stats = useUsageSummary(workspaceId)

  useVisiblePolling({
    enabled: true,
    intervalMs: 60_000,
    restartKey: workspaceId ?? "",
    onPoll: () => {
      void loadWallet().catch(() => {})
      if (workspaceId === undefined) return
      void loadUsageSummary(workspaceId).catch(() => {})
    },
  })

  if (!wallet) return null
  return (
    <WalletBalanceBadge
      wallet={wallet}
      stats={stats}
      onOpenUsage={onOpenUsage}
      className={className}
    />
  )
}

/** The badge itself, split from the read so it can be rendered from a fixture. */
export function WalletBalanceBadge({
  wallet,
  stats,
  onOpenUsage,
  open,
  defaultOpen,
  className,
}: {
  wallet: WalletView
  stats?: UsageStatsView | null
  onOpenUsage?: () => void
  open?: boolean
  defaultOpen?: boolean
  className?: string
}) {
  const quota = computeWalletBalance(wallet)
  // 消费口径与 wallet.spent_microfen 同源：charged 是结算真正扣走的钱，
  // 名义 total 在发生封顶减免时会高估消费，不再是"已花费"的读数来源。
  const spent = stats ? formatYuan(stats.charged_microfen) : formatYuan(wallet.spent_microfen)
  const requests = stats ? stats.message_count.toLocaleString("zh-CN") : "0"
  const tokens = stats ? stats.total_tokens.toLocaleString("zh-CN") : "0"

  return (
    <Tooltip open={open} defaultOpen={defaultOpen}>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpenUsage}
            onMouseEnter={() => preloadScreen("usage")}
            onFocus={() => preloadScreen("usage")}
            aria-label={`钱包余额 ${quota.available} CNY`}
            className={cn(
              "group/token flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-2.5 text-xs transition-colors hover:border-border-strong hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer select-none",
              !onOpenUsage && "cursor-default pointer-events-none",
              className,
            )}
          />
        }
      >
        <span className="flex items-center gap-1.5 text-meta font-semibold tracking-[0.09em] text-faint-foreground uppercase">
          <Wallet
            className="size-3.5 text-muted-foreground transition-colors group-hover/token:text-foreground"
            aria-hidden
          />
        </span>
        <span className="font-mono text-meta font-medium text-foreground tabular-nums">
          {quota.available}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
        align="end"
        className="flex w-44 flex-col items-stretch gap-1.5 p-3 text-xs shadow-overlay"
      >
        <div className="flex w-full items-center justify-between gap-4 font-mono">
          <span className="font-sans text-background/80 text-xs text-left">消费金额</span>
          <span className="font-semibold text-background tabular-nums text-right">{spent}</span>
        </div>
        <div className="flex w-full items-center justify-between gap-4 font-mono">
          <span className="font-sans text-background/80 text-xs text-left">API 请求次数</span>
          <span className="font-semibold text-background tabular-nums text-right">{requests}</span>
        </div>
        <div className="flex w-full items-center justify-between gap-4 font-mono">
          <span className="font-sans text-background/80 text-xs text-left">Tokens</span>
          <span className="font-semibold text-background tabular-nums text-right">{tokens}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The bar measures what has been settled against everything the Workspace ever had
 * to spend — the wallet only knows the balance it still holds and what it has
 * already burned, so the denominator is their sum. A wallet that was never
 * topped up has nothing to be a percentage of, and reads as 0% rather than full.
 */
export function computeWalletBalance(wallet: WalletView) {
  const granted = wallet.balance_microfen + wallet.spent_microfen

  const rawPercent = granted > 0 ? (wallet.spent_microfen / granted) * 100 : 0
  const clampedPercent = Math.min(Math.max(rawPercent, 0), 100)

  let tone: "normal" | "warning" | "danger" = "normal"
  if (wallet.available_microfen <= 0 || rawPercent >= 95) {
    tone = "danger"
  } else if (rawPercent >= 80) {
    tone = "warning"
  }

  return {
    // 徽章读数与用量页一致走 formatYuan 默认口径：≥¥1 两位小数（¥99.81），
    // ¥1 以下放宽到 4 位，最小计费档 ¥0.003 仍可见。
    available: formatYuan(wallet.available_microfen),
    held: formatYuan(wallet.held_microfen),
    spent: formatYuan(wallet.spent_microfen),
    granted: formatYuan(granted),
    formattedPercent: formatPercent(rawPercent),
    clampedPercent,
    tone,
  }
}

function formatPercent(rawPercent: number): string {
  if (rawPercent <= 0) return "0%"
  if (rawPercent < 0.1) return "<0.1%"
  if (rawPercent >= 100) return "100%"
  const formatted = rawPercent.toFixed(1)
  return `${formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted}%`
}

/**
 * The two Workspace-scoped quota facts the operator sidebar already prints.
 * Staff reuse the same pair on the SuperAdmin Workspace directory.
 */
export function WorkspaceQuotaFacts({
  seatsUsed,
  seats,
  tokensUsed,
  tokensMonthly,
  className,
}: {
  seatsUsed: number
  seats: number
  tokensUsed: number
  tokensMonthly: number
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="工作空间用量"
      className={cn("flex flex-col gap-1.5", className)}
    >
      <QuotaLine
        icon={UsersRound}
        label="成员"
        value={`${seatsUsed}/${seats}`}
      />
      <QuotaLine
        icon={Sparkles}
        label="Token"
        value={`${formatCompactQuota(tokensUsed)}/${formatCompactQuota(tokensMonthly)}`}
      />
    </div>
  )
}

function QuotaLine({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersRound
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-meta font-semibold tracking-[0.09em] text-faint-foreground uppercase">
        <Icon className="size-3.5 text-muted-foreground" />
        {label}
      </span>
      <span className="font-mono text-meta text-foreground tabular-nums">
        {value}
      </span>
    </div>
  )
}

export function formatCompactQuota(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`
  }
  return String(value)
}
