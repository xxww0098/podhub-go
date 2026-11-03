import { ChartNoAxesColumn, ChevronRight, ClipboardList, Settings2, Truck, Zap } from "lucide-react"
import type { components } from "@/api/schema"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FactoryOrderView } from "@/factory/api"
import { ProductionThumbnail } from "@/factory/components/production-thumbnail"
import { countdownLabel } from "@/factory/lib/order"

type SupplierDispatchRow = components["schemas"]["SupplierDispatchRow"]
export type FactoryDashboardCounts = Record<FactoryOrderView, number>

export function FactoryDashboard({
  counts,
  urgent_orders,
  now,
  loading = false,
  onOpenOrder,
  onOpenList,
}: {
  counts?: FactoryDashboardCounts
  urgent_orders: SupplierDispatchRow[]
  now: number
  loading?: boolean
  onOpenOrder: (dispatch_id: string) => void
  onOpenList: (view: FactoryOrderView) => void
}) {
  const metrics = [
    { view: "pending", label: "待生产", icon: ClipboardList, tone: "bg-st-flight-soft text-st-flight-ink" },
    { view: "producing", label: "生产中", icon: Settings2, tone: "bg-st-attest-soft text-st-attest-ink" },
    { view: "urgent", label: "加急", icon: Zap, tone: "bg-st-bad-soft text-st-bad-ink" },
    { view: "shipped", label: "已发货", icon: Truck, tone: "bg-st-good-soft text-st-good-ink" },
  ] as const

  return (
    <div className="grid gap-3 sm:gap-4 lg:h-full lg:max-h-[47rem] lg:grid-rows-[auto_minmax(20rem,1fr)]">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="订单概况">
        {metrics.map(({ view, label, icon: Icon, tone }) => (
          <Button
            key={view}
            type="button"
            variant="outline"
            className="h-auto min-h-28 w-full items-start justify-start whitespace-normal text-left sm:min-h-48"
            onClick={() => onOpenList(view)}
            aria-label={`${label}，${counts ? `${counts[view]} 单` : "数据未读取"}，查看订单`}
          >
            <span className="flex min-w-0 gap-4 py-4 sm:py-5">
              <span className={`grid size-12 shrink-0 place-items-center rounded-lg sm:size-16 ${tone}`} aria-hidden="true">
                <Icon className="size-6 sm:size-8" />
              </span>
              <span className="flex min-w-0 flex-col gap-3">
                <span className="text-md font-semibold text-foreground sm:text-lg">{label}</span>
                <span className="text-3xl font-semibold leading-none tabular-nums text-foreground sm:text-5xl">
                  {counts ? counts[view].toLocaleString("zh-CN") : "—"}
                </span>
                {view === "urgent" ? <span className="text-xs font-normal leading-4 text-muted-foreground">含待生产和生产中订单</span> : null}
              </span>
            </span>
          </Button>
        ))}
      </div>

      <div className="grid items-stretch gap-3 lg:grid-cols-2">
        <Card size="sm" className="min-w-0">
          <CardHeader>
            <CardTitle>
              <span className="flex items-center gap-2 text-lg font-semibold">
                <ChartNoAxesColumn className="size-5 text-brand" aria-hidden="true" />
                订单状态分布
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-60 flex-1 items-center py-5 sm:min-h-72">
            {counts ? <StatusBars counts={counts} /> : (
              <p className="w-full text-center text-sm text-muted-foreground" role="status">
                {loading ? "正在读取订单统计" : "订单统计暂不可用"}
              </p>
            )}
          </CardContent>
        </Card>

        <Card size="sm" className="min-w-0">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>
                <span className="flex items-center gap-2 text-lg font-semibold">
                  <Zap className="size-5 text-brand" aria-hidden="true" />
                  加急订单
                </span>
              </CardTitle>
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenList("urgent")}>
                查看全部 <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-w-0 overflow-x-auto pt-3">
            {urgent_orders.length > 0 ? (
              <table className="w-full min-w-[24rem] table-fixed text-left text-md">
                <thead className="bg-muted/70 text-sm text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-[43%] rounded-l-md px-3 py-2 font-medium">商品</th>
                    <th scope="col" className="w-[21%] px-2 py-2 font-medium">当前状态</th>
                    <th scope="col" className="w-[26%] px-2 py-2 font-medium">剩余时间</th>
                    <th scope="col" className="w-[10%] rounded-r-md px-2 py-2 text-right font-medium"><span className="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {urgent_orders.slice(0, 3).map((order) => <UrgentOrder key={order.dispatch_id} order={order} now={now} onOpenOrder={onOpenOrder} />)}
                </tbody>
              </table>
            ) : (
              <p className="grid min-h-52 place-items-center text-sm text-muted-foreground" role="status">
                {loading ? "正在读取加急订单" : counts?.urgent === 0 ? "暂无加急订单" : "加急订单暂不可用"}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatusBars({ counts }: { counts: FactoryDashboardCounts }) {
  const rows = [
    { label: "待生产", value: counts.pending, color: "bg-st-flight/80" },
    { label: "生产中", value: counts.producing, color: "bg-st-attest/55" },
    { label: "已发货", value: counts.shipped, color: "bg-st-good/60" },
  ]
  const step = Math.max(1, Math.ceil(Math.max(...rows.map((row) => row.value)) / 6))
  const max = step * 6
  return (
    <div className="flex w-full flex-col self-stretch">
      <div className="relative flex flex-1">
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-16 right-10 grid grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => <span key={index} className="border-l border-dashed border-border last:border-r" />)}
        </div>
        <ul aria-label="订单状态分布" className="relative grid w-full content-evenly gap-7 py-4">
          {rows.map(({ label, value, color }) => (
            <li key={label} className="grid grid-cols-[4rem_minmax(0,1fr)_2.5rem] items-center text-md">
              <span className="text-muted-foreground">{label}</span>
              <span className="relative h-9" aria-hidden="true">
                <span className={`block h-full rounded-r ${color}`} style={{ width: `${value / max * 100}%` }} />
                <span className="absolute top-1/2 -translate-y-1/2 pl-2 font-medium tabular-nums" style={{ left: `${value / max * 100}%` }}>{value.toLocaleString("zh-CN")}</span>
              </span>
              <span className="sr-only">{value.toLocaleString("zh-CN")}</span>
            </li>
          ))}
        </ul>
      </div>
      <div aria-hidden="true" className="ml-16 mr-10 flex justify-between border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">
        {Array.from({ length: 7 }, (_, index) => <span key={index}>{(index * step).toLocaleString("zh-CN")}</span>)}
      </div>
    </div>
  )
}

function UrgentOrder({ order, now, onOpenOrder }: {
  order: SupplierDispatchRow
  now: number
  onOpenOrder: (dispatch_id: string) => void
}) {
  const first = order.lines[0]
  const title = first?.name || first?.offer_id || order.dispatch_no
  const quantity = order.lines.reduce((total, line) => total + line.quantity, 0)
  const state = order.state === "dispatched" ? "待生产" : order.state === "accepted" ? "生产中" : "未知状态"
  const remaining = countdownLabel(order.deadline, now)
  return (
    <tr className="border-b border-border/70 last:border-b-0">
      <td className="px-3 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <ProductionThumbnail url={order.thumbnail_url} className="size-14 sm:size-16" />
          <span className="min-w-0">
            <span className="block truncate font-medium" title={title}>{title}{order.lines.length > 1 ? " 等" : ""}</span>
            <span className="block text-xs text-muted-foreground">× {quantity}</span>
          </span>
        </div>
      </td>
      <td className="px-2 py-4"><Badge variant={order.state === "dispatched" ? "brand" : order.state === "accepted" ? "warning" : "secondary"}>{state}</Badge></td>
      <td className="px-2 py-4 text-muted-foreground tabular-nums">{remaining ?? "—"}</td>
      <td className="px-1 py-4 text-right">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`查看 ${order.dispatch_no} 详情`} onClick={() => onOpenOrder(order.dispatch_id)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </td>
    </tr>
  )
}
