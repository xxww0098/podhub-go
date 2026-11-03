import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { WalletLedgerEntry } from "@/features/usage/wallet-cache"
import { formatDateTime } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import { cn } from "@/lib/utils"

const ENTRY_LABELS: Record<string, string> = {
  topup: "充值",
  hold: "预留",
  settle: "结算",
  release: "释放",
  refund: "退款",
  adjustment: "调整",
}

function ledgerEntryLabel(entryType: string): string {
  return ENTRY_LABELS[entryType] ?? entryType
}

// The settle note is written by the server in English and is part of its
// replay check, so the stored text stays; only the display is localised.
const ABSORBED_NOTE = /^platform absorbed (\d+) microfen above the per-request ceiling$/

export function ledgerNoteLabel(note: string): string {
  const absorbed = ABSORBED_NOTE.exec(note)
  return absorbed ? `平台承担超出单次上限的 ${formatYuan(Number(absorbed[1]))}` : note
}

/** Signed money for a balance delta; `formatYuan` alone would print `¥-1.00`. */
export function formatSignedYuan(microfen: number): string {
  if (microfen === 0) return "—"
  return `${microfen > 0 ? "+" : "-"}${formatYuan(Math.abs(microfen))}`
}

const HEAD = "sticky top-0 z-10"

/**
 * The active Workspace's most recent wallet movements (the server returns the
 * latest 50). `ledger === null` is "not read yet" unless `failed` says the read
 * went wrong.
 */
export function WalletLedgerTable({
  ledger,
  failed,
  onRetry,
}: {
  ledger: WalletLedgerEntry[] | null
  failed: boolean
  onRetry?: () => void
}) {
  return (
    <section aria-label="钱包流水" className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-foreground">钱包流水</span>
        <span className="text-meta text-muted-foreground">最近 50 条</span>
      </div>
      {ledger === null ? (
        failed ? (
          <div role="status" className="flex items-center gap-2 text-compact text-muted-foreground">
            <span>钱包流水读取失败。</span>
            {onRetry ? (
              <Button size="xs" variant="outline" onClick={onRetry}>
                <RefreshCw aria-hidden />
                重试
              </Button>
            ) : null}
          </div>
        ) : (
          <Skeleton className="h-24" />
        )
      ) : ledger.length === 0 ? (
        <p role="status" className="text-compact text-muted-foreground">暂无钱包流水。</p>
      ) : (
        <Table containerClassName="max-h-72 overflow-y-auto">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>时间</TableHead>
              <TableHead className={HEAD}>类型</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>金额</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>变动后余额</TableHead>
              <TableHead className={HEAD}>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.map((entry, index) => (
              <TableRow key={`${entry.created_at}-${index}`}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(entry.created_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{ledgerEntryLabel(entry.entry_type)}</TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono tabular-nums",
                    entry.amount_microfen > 0 && "text-st-good-ink",
                    entry.amount_microfen < 0 && "text-st-bad-ink",
                    entry.amount_microfen === 0 && "text-muted-foreground",
                  )}
                >
                  {formatSignedYuan(entry.amount_microfen)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatYuan(entry.balance_after_microfen)}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={ledgerNoteLabel(entry.note)}>
                  {ledgerNoteLabel(entry.note) || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
