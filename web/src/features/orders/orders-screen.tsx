import { useEffect, useState } from "react"
import { Receipt, RefreshCw } from "lucide-react"

import type { AdminPaymentOrderView } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { PlatformAdminEmpty, PlatformAdminFact, PlatformAdminRefresh, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { useScreenActive } from "@/components/screen-pane"
import { formatPlan } from "@/components/workspace-display"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTimeShort } from "@/lib/format"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

export function OrdersScreen({
  onSessionMayChange,
}: {
  /** Confirming a remittance upgrades member seats on the paid Workspace — refresh the shell overview. */
  onSessionMayChange?: () => void | Promise<void>
} = {}) {
  const active = useScreenActive()
  const [orders, setOrders] = useState<AdminPaymentOrderView[]>()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<AdminPaymentOrderView>()

  async function reload() {
    setBusy(true)
    try {
      setOrders(await adminHttp.adminListOrders())
    } catch (reason) {
      notifyCommandError(reason, "加载支付订单失败")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (active) void reload()
  }, [active])

  async function confirm(order: AdminPaymentOrderView) {
    setBusy(true)
    try {
      await adminHttp.adminConfirmOrder(order.public_id)
      setConfirming(undefined)
      notifySuccess("已确认到账")
      await reload()
      await onSessionMayChange?.()
    } catch (reason) {
      notifyCommandError(reason, "确认失败")
      setBusy(false)
    }
  }

  async function cancel(publicId: string) {
    setBusy(true)
    try {
      await adminHttp.adminCancelOrder(publicId)
      notifySuccess("已取消订单")
      await reload()
    } catch (reason) {
      notifyCommandError(reason, "取消失败")
      setBusy(false)
    }
  }

  const pendingCount =
    orders?.filter((order) => order.status === "pending").length ?? 0

  return (
    <div className="flex min-w-0 w-full flex-col gap-4">
      <h1 className="sr-only">订单</h1>
      <PlatformAdminSurface
        summary={
          orders && orders.length > 0 ? (
            <>
              <PlatformAdminFact label="订单" value={orders.length} mono />
              <PlatformAdminFact label="待确认" value={pendingCount} mono />
            </>
          ) : undefined
        }
        toolbar={
          /* An empty ledger owns its own refresh action; a lone button on an
             otherwise blank ribbon would read as an orphaned control. */
          orders && orders.length > 0 ? (
            <div className="ml-auto">
              <PlatformAdminRefresh busy={busy} onClick={() => void reload()} />
            </div>
          ) : undefined
        }
      >
        {!orders || orders.length === 0 ? (
          <PlatformAdminEmpty
            icon={Receipt}
            busy={busy}
            title={busy ? "正在加载订单…" : "暂无订单"}
            description={
              busy ? "正在读取平台支付订单…" : "加购订单会在这里等待确认收款。"
            }
            action={
              busy ? undefined : (
                <Button
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => void reload()}
                >
                  <RefreshCw data-icon="inline-start" />
                  刷新
                </Button>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>单号</TableHead>
                <TableHead>工作空间</TableHead>
                <TableHead>权益</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.public_id}>
                  <TableCell className="font-mono text-xs">{order.public_id}</TableCell>
                  <TableCell>
                    <span className="block">{order.workspace_name}</span>
                    <span className="block text-meta text-muted-foreground">
                      {order.created_by_email}
                    </span>
                  </TableCell>
                  <TableCell>
                    {order.member_seats > 0
                      ? `${order.member_seats} 席 · ${order.months} 个月 · ${formatPlan(order.plan)}`
                      : formatPlan(order.plan)}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    ¥{(order.amount_cents / 100).toFixed(0)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="whitespace-nowrap">
                      {order.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
                    {formatDateTimeShort(order.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {order.status === "pending" ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          disabled={busy}
                          onClick={() => void cancel(order.public_id)}
                        >
                          取消
                        </Button>
                        <Button
                          size="sm"
                          className="cursor-pointer"
                          disabled={busy}
                          onClick={() => setConfirming(order)}
                        >
                          确认收款
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PlatformAdminSurface>
      <PlatformAdminDialog
        open={confirming != null}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined)
        }}
        title="确认到账"
        description="核对工作空间与实付金额后确认入账。"
        width="sm:max-w-md"
        footer={
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(undefined)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !confirming}
              onClick={() => confirming && void confirm(confirming)}
            >
              {busy ? <Spinner data-icon="inline-start" /> : <Receipt data-icon="inline-start" />}
              确认入账
            </Button>
          </>
        }
      >
          {confirming ? (
            <dl className="divide-y divide-border px-5 py-2 text-compact">
              <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <dt className="text-muted-foreground">目标工作空间</dt>
                <dd className="min-w-0 break-words sm:text-right font-medium text-foreground">{confirming.workspace_name}</dd>
              </div>
              <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <dt className="text-muted-foreground">入账成员名额</dt>
                <dd className="min-w-0 break-words sm:text-right font-mono font-medium text-foreground">
                  {confirming.member_seats} 名成员 · {confirming.months} 个月 · {formatPlan(confirming.plan)}
                </dd>
              </div>
              <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <dt className="text-muted-foreground">实付金额</dt>
                <dd className="min-w-0 break-words sm:text-right font-mono font-semibold text-foreground">
                  ¥{(confirming.amount_cents / 100).toFixed(0)}
                </dd>
              </div>
              <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 text-xs">
                <dt className="text-muted-foreground">订单单号</dt>
                <dd className="min-w-0 break-all sm:text-right font-mono text-muted-foreground">{confirming.public_id}</dd>
              </div>
            </dl>
          ) : null}
      </PlatformAdminDialog>
    </div>
  )
}
