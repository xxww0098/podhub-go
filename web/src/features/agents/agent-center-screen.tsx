import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"

import type {
  AgentLedgerEntry,
  AgentWithdrawal,
  AgentWorkbench,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AgentCard, rebateLabel } from "@/features/agents/agent-card"
import { AgentWalletCard } from "@/features/agents/agent-wallet-card"
import { errorMessage } from "@/lib/error-message"
import { formatCents } from "@/lib/money"
import { clearLive, notifyLive } from "@/lib/notify"

const AGENT_LIVE = "agent-center-load"

/**
 * 代理中心 — the one destination only an Agent sees: the terms the next
 * attribution snapshots, the funnel the commissions actually followed, and the
 * card that hands the code out. The rules live in `docs/agent-rebate.md`; this
 * screen never re-derives them.
 */
export function AgentCenterScreen() {
  const active = useScreenActive()
  const [workbench, setWorkbench] = useState<AgentWorkbench>()
  const [withdrawals, setWithdrawals] = useState<AgentWithdrawal[]>([])
  const [ledger, setLedger] = useState<AgentLedgerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    try {
      const [next, nextWithdrawals, nextLedger] = await Promise.all([
        accountHttp.agentGetWorkbench(),
        accountHttp.agentListWithdrawals(),
        accountHttp.agentListLedger(),
      ])
      setWorkbench(next)
      setWithdrawals(nextWithdrawals)
      setLedger(nextLedger)
      clearLive(AGENT_LIVE)
    } catch (reason) {
      notifyLive({
        id: AGENT_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "请检查网络后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (active) void load()
    return () => clearLive(AGENT_LIVE)
  }, [active, load])

  if (loading) {
    return (
      <div
        role="status"
        className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner className="size-4" />
        正在读取代理信息…
      </div>
    )
  }
  if (!workbench) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">代理信息暂时不可用。</p>
        <Button variant="outline" onClick={() => void load()}>
          重试
        </Button>
      </div>
    )
  }

  const policy = [
    `生效比例 ${rebateLabel(workbench.rebate_bps)}`,
    `合格首单 ≥ ${formatCents(workbench.min_order_cents)}`,
    workbench.attribution_validity_days === 0
      ? "归因永久有效"
      : `归因有效期 ${workbench.attribution_validity_days} 天`,
  ].join(" · ")

  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="sr-only">代理中心</h1>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-compact text-muted-foreground">{policy}</p>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="刷新"
          disabled={refreshing}
          onClick={() => void load(true)}
        >
          <RefreshCw aria-hidden className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border text-sm">
        <Stat label="已邀请注册" value={String(workbench.invitee_count)} />
        <Stat label="已发佣" value={String(workbench.credited_count)} />
        <Stat label="未计佣" value={String(workbench.skipped_count)} />
      </dl>

      <AgentCard workbench={workbench} origin={window.location.origin} />

      <AgentWalletCard
        workbench={workbench}
        withdrawals={withdrawals}
        ledger={ledger}
        onChanged={() => void load(true)}
      />

      <p className="text-xs text-muted-foreground">
        佣金在被邀请人完成第一笔金额达到门槛的实付订单时进入你的佣金余额；
        余额满 {formatCents(workbench.min_withdraw_cents)} 可申请提现，也可随时转入钱包。
        未计佣的行会写明原因。
      </p>
    </div>
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
