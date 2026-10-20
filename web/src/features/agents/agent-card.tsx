import { useState } from "react"
import { Check, Copy, Link2 } from "lucide-react"
import type { AgentWorkbench } from "@/bindings/commands"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { copyToClipboard } from "@/lib/clipboard"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"
import { COMMISSION_LABELS, PRODUCT_LABELS } from "@/features/agents/agent-labels"

/** `/login?invite=CODE` — what an Agent hands out (`docs/agent-rebate.md` §7). */
export function inviteLink(origin: string, inviteCode: string): string {
  return `${origin}/login?invite=${encodeURIComponent(inviteCode)}`
}

export function rebateLabel(bps: number): string {
  return `${(bps / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`
}

export function AgentCard({
  workbench,
  origin,
}: {
  workbench: AgentWorkbench
  origin: string
}) {
  const [copied, setCopied] = useState<"code" | "link">()
  const link = inviteLink(origin, workbench.invite_code)

  async function copy(kind: "code" | "link") {
    const value = kind === "code" ? workbench.invite_code : link
    await copyToClipboard(value, {
      success: kind === "code" ? "邀请码已复制" : "邀请链接已复制",
      failure: "复制失败，请手动选择文字。",
      onCopied: () => setCopied(kind),
    })
  }

  return (
    <section
      aria-label="代理"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">代理</p>
          <p className="text-xs text-muted-foreground">
            用邀请码或邀请链接注册的用户，首笔实付订单按{" "}
            <span className="font-mono tabular-nums">{rebateLabel(workbench.rebate_bps)}</span>{" "}
            返点，进入你的佣金余额，可提现或转入钱包。
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-sm tracking-wider select-all">
            {workbench.invite_code}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="复制邀请码"
            onClick={() => void copy("code")}
          >
            {copied === "code" ? (
              <Check data-icon="inline-start" className="text-st-good-ink" />
            ) : (
              <Copy data-icon="inline-start" />
            )}
            复制邀请码
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="复制邀请链接"
            onClick={() => void copy("link")}
          >
            {copied === "link" ? (
              <Check data-icon="inline-start" className="text-st-good-ink" />
            ) : (
              <Link2 data-icon="inline-start" />
            )}
            复制邀请链接
          </Button>
        </div>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-px border-b border-border bg-border text-sm">
        <Stat label="已邀请注册" value={String(workbench.invitee_count)} />
        <Stat label="已发佣笔数" value={String(workbench.credited_count)} />
        <Stat label="累计佣金" value={formatCents(workbench.credited_total_cents)} />
      </dl>
      {workbench.commissions.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          还没有佣金记录。被邀请用户的 Workspace 完成首笔实付后会出现在这里。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>被邀请人</TableHead>
                <TableHead>付款 Workspace</TableHead>
                <TableHead>订单</TableHead>
                <TableHead className="text-right">佣金</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workbench.commissions.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.invitee_email}</TableCell>
                  <TableCell>{row.workspace_name}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {PRODUCT_LABELS[row.product] ?? row.product} ·{" "}
                    <span className="font-mono tabular-nums">
                      {formatCents(row.order_amount_cents)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.status === "credited" ? formatCents(row.amount_cents) : "—"}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={row.status}
                      tone={row.status === "credited" ? "good" : "idle"}
                      label={
                        row.status === "credited"
                          ? COMMISSION_LABELS.credited
                          : `${COMMISSION_LABELS.skipped} · ${row.note}`
                      }
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTimeShort(row.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
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
