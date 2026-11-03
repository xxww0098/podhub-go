import type { OzonStoreView } from "@/bindings/commands"
import { RotateCcw } from "lucide-react"

import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"

import { financeBalanceDisplay } from "./finance-balance"

export function FinanceBalanceCell({
  store,
  reading,
  onRetry,
}: {
  store: OzonStoreView
  reading: boolean
  onRetry: () => void
}) {
  const shown = financeBalanceDisplay(store.finance_balance, {
    configured: store.configured,
    reading,
  })
  return (
    <div className="flex items-center gap-1 text-xs">
      <span
        className={cn(shown.muted ? "text-faint-foreground" : "font-mono tabular-nums")}
        title={shown.title}
      >
        {shown.text}
      </span>
      {shown.retry ? (
        <IconButton
          icon={RotateCcw}
          label="重试读取期末余额"
          tip="重试"
          size="icon-xs"
          onClick={(event) => {
            event.stopPropagation()
            onRetry()
          }}
        />
      ) : null}
    </div>
  )
}
