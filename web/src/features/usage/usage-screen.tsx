import { useState } from "react"

import type { AccountOverview, WorkspaceSummaryView } from "@/bindings/commands"
import { RechargeDialog } from "@/features/usage/recharge-dialog"
import { UsageStatsPanel } from "@/features/usage/usage-stats-panel"

/**
 * Active Workspace AI usage dashboard. Breadcrumb already names the module — the
 * panel owns the wallet readout, range control, KPIs and trend charts.
 *
 * 去充值 opens the recharge dialog in place; the wallet top-up is its own
 * Payment Order product, and only the Workspace owner may fund it — so the
 * button stays hidden for members rather than opening a dialog that can only
 * refuse them.
 */
export function UsageScreen({
  activeWorkspace,
  onOverviewChange,
}: {
  activeWorkspace?: WorkspaceSummaryView
  onOverviewChange?: (overview: AccountOverview) => void
}) {
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const canRecharge = activeWorkspace?.role === "owner"
  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="sr-only">用量</h1>
      <UsageStatsPanel
        workspaceId={activeWorkspace?.id}
        workspaceName={activeWorkspace?.name}
        onTopUp={canRecharge ? () => setRechargeOpen(true) : undefined}
      />
      <RechargeDialog
        open={rechargeOpen}
        onOpenChange={setRechargeOpen}
        workspaceUuid={activeWorkspace?.uuid}
        workspaceName={activeWorkspace?.name}
        onOverviewChange={onOverviewChange}
      />
    </div>
  )
}
