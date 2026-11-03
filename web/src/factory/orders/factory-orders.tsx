import { ChevronLeft, ChevronRight, ChevronUp, Eye, RefreshCw, Search } from "lucide-react"

import type { components } from "@/api/schema"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ProductionThumbnail } from "@/factory/components/production-thumbnail"
import type { FactoryOrderView } from "@/factory/api"
import { countdownLabel, deadlineInstant, isUrgent, URGENT_WINDOW_MS } from "@/factory/lib/order"
import { cn } from "@/lib/utils"

export type FactoryUrgentState = "all" | "dispatched" | "accepted"
export type FactoryUrgentReason = "all" | "deadline" | "nudge"

type DispatchRow = components["schemas"]["SupplierDispatchRow"]

export type FactoryOrdersProps = {
  view: FactoryOrderView
  rows: DispatchRow[]
  now: number
  loading?: boolean
  error?: string
  search: string
  onSearchChange: (value: string) => void
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  onOpenOrder: (dispatch_id: string) => void
  onRetry: () => void
  urgentState?: FactoryUrgentState
  urgentReason?: FactoryUrgentReason
  onUrgentStateChange?: (value: FactoryUrgentState) => void
  onUrgentReasonChange?: (value: FactoryUrgentReason) => void
}

const viewLabels: Record<FactoryOrderView, string> = {
  pending: "待生产",
  producing: "生产中",
  urgent: "加急",
  shipped: "已发货",
}

function orderState(state: string): { label: string; variant: "brand" | "good" | "warning" | "outline" } {
  switch (state) {
    case "dispatched": return { label: "待接单", variant: "brand" }
    case "accepted": return { label: "生产中", variant: "warning" }
    case "shipped": return { label: "已发货", variant: "good" }
    default: return { label: "未知状态", variant: "outline" }
  }
}

function Product({ row, large, shipped }: { row: DispatchRow; large: boolean; shipped: boolean }) {
  const first = row.lines[0]
  const name = first?.name || first?.offer_id || "商品信息不可用"
  return <div className="flex min-w-0 items-center gap-3">
    <ProductionThumbnail url={row.thumbnail_url} className={shipped ? "size-18" : large ? "size-14" : "size-12"} />
    <div className="min-w-0">
      <div className="truncate font-medium" title={name}>{name}{row.lines.length > 1 ? " 等" : ""}</div>
      {!shipped && first?.offer_id && first.offer_id !== first.name ? <div className="truncate text-meta text-muted-foreground" title={first.offer_id}>{first.offer_id}</div> : null}
    </div>
  </div>
}

function urgentReasons(row: DispatchRow, now: number): string {
  const deadline = deadlineInstant(row.deadline)
  const reasons: string[] = []
  if (deadline !== null && deadline - now <= URGENT_WINDOW_MS) {
    reasons.push(deadline <= now ? "已超时" : "临近截止")
  }
  if ((row.nudge_count ?? 0) > 0) reasons.push("被催单")
  return reasons.join("、") || "—"
}

export function FactoryOrders({
  view, rows, now, loading = false, error, search, onSearchChange,
  hasPrevious, hasNext, onPrevious, onNext, onOpenOrder, onRetry,
  urgentState = "all", urgentReason = "all", onUrgentStateChange, onUrgentReasonChange,
}: FactoryOrdersProps) {
  const shipped = view === "shipped"
  const urgentPage = view === "urgent"
  const pendingPage = view === "pending"
  const producingPage = view === "producing"
  const detailPage = pendingPage || producingPage
  const columns = shipped ? 5 : producingPage ? 6 : 7
  const cellSpacing = pendingPage ? "py-3.5" : urgentPage ? "py-6" : producingPage ? "py-5" : shipped ? "py-4" : "py-3"
  const cellText = shipped ? "text-2xl" : pendingPage ? "text-lg" : producingPage || urgentPage ? "text-xl" : ""
  return <section aria-label={`${viewLabels[view]}订单`} className={cn("flex min-h-0 flex-1 flex-col", pendingPage ? "overflow-hidden rounded-lg border border-border bg-card" : "gap-3")}>
    <div className={cn("flex flex-wrap items-end gap-2", pendingPage && "p-4", urgentPage && "gap-4 rounded-lg border border-border bg-card p-4")}>
      <InputGroup className={cn("h-10 w-full", pendingPage && "sm:max-w-sm", producingPage && "h-12", urgentPage && "h-11 min-w-52 flex-1", shipped && "h-14")}>
        <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
        <InputGroupInput aria-label="搜索发货单号或商品" placeholder={shipped ? "搜索发货单号或商品" : "搜索发货单号、商品名称"} value={search} onChange={(event) => onSearchChange(event.target.value)} />
      </InputGroup>
      {urgentPage ? <>
        <div className="flex min-w-36 flex-1 flex-col gap-1">
        <span className="text-sm font-medium">状态</span>
        <Select value={urgentState} disabled={!onUrgentStateChange} onValueChange={(value) => {
          if (value === "all" || value === "dispatched" || value === "accepted") onUrgentStateChange?.(value)
        }}>
          <SelectTrigger aria-label="按订单状态筛选" className="h-11 w-full">
            <SelectValue>{() => ({ all: "全部状态", dispatched: "待接单", accepted: "生产中" })[urgentState]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="dispatched">待接单</SelectItem>
            <SelectItem value="accepted">生产中</SelectItem>
          </SelectContent>
        </Select>
        </div>
        <div className="flex min-w-36 flex-1 flex-col gap-1">
        <span className="text-sm font-medium">加急原因</span>
        <Select value={urgentReason} disabled={!onUrgentReasonChange} onValueChange={(value) => {
          if (value === "all" || value === "deadline" || value === "nudge") onUrgentReasonChange?.(value)
        }}>
          <SelectTrigger aria-label="按加急原因筛选" className="h-11 w-full">
            <SelectValue>{() => ({ all: "全部原因", deadline: "临近截止", nudge: "被催单" })[urgentReason]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部原因</SelectItem>
            <SelectItem value="deadline">临近截止</SelectItem>
            <SelectItem value="nudge">被催单</SelectItem>
          </SelectContent>
        </Select>
        </div>
        <Button type="button" variant="outline" size="icon" aria-label="刷新加急订单" disabled={loading} onClick={onRetry}><RefreshCw aria-hidden /></Button>
      </> : null}
    </div>

    {error ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <span>{error}{rows.length ? "，当前显示上次读取的数据。" : ""}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>
    </div> : null}

    <div className={urgentPage ? "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card" : "contents"}>
    <div className={cn("min-h-0 overflow-auto bg-card", !urgentPage && "flex-1", pendingPage ? "border-t border-border" : !urgentPage && "rounded-lg border border-border")} aria-busy={loading}>
      <Table className="min-w-[740px]" containerClassName="overflow-visible" aria-label={`${viewLabels[view]}订单列表`}>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn("h-11 px-4", detailPage && "w-48 bg-brand-soft text-lg text-foreground", producingPage && "h-14 text-xl", urgentPage && "h-14 w-48 bg-brand-soft pl-12 text-xl text-foreground", shipped && "h-14 w-60 bg-brand-soft text-2xl text-foreground")}>发货单号</TableHead>
            <TableHead className={cn("min-w-52 px-4", detailPage && "w-72 bg-brand-soft text-lg text-foreground", producingPage && "text-xl", urgentPage && "w-60 bg-brand-soft text-xl text-foreground", shipped && "w-80 bg-brand-soft text-2xl text-foreground")}>商品</TableHead>
            <TableHead className={cn("px-4", detailPage && "w-24 bg-brand-soft text-lg text-foreground", producingPage && "text-xl", urgentPage && "w-24 bg-brand-soft text-xl text-foreground", shipped && "w-52 bg-brand-soft text-2xl text-foreground")}>数量</TableHead>
            {urgentPage ? <TableHead className="w-40 bg-brand-soft px-4 text-xl text-foreground">当前状态</TableHead> : null}
            {!shipped ? <TableHead aria-sort={pendingPage ? "ascending" : undefined} className={cn("px-4", detailPage && "w-44 bg-brand-soft text-lg text-foreground", producingPage && "text-xl", urgentPage && "w-44 bg-brand-soft text-xl text-foreground")}>
              <span className="inline-flex items-center gap-1">剩余时间{pendingPage ? <ChevronUp aria-hidden className="size-3" /> : null}</span>
            </TableHead> : null}
            {!shipped && !producingPage ? <TableHead className={cn("px-4", pendingPage && "w-28 bg-brand-soft text-lg text-foreground", urgentPage && "bg-brand-soft text-xl text-foreground")}>{urgentPage ? "加急原因" : "催单"}</TableHead> : null}
            {!urgentPage ? <TableHead className={cn("px-4", detailPage && "w-32 bg-brand-soft text-lg text-foreground", producingPage && "text-xl", shipped && "w-56 bg-brand-soft text-2xl text-foreground")}>{producingPage || shipped ? "当前状态" : "状态"}</TableHead> : null}
            <TableHead className={cn("w-16 px-3 text-center", (detailPage || urgentPage || shipped) && "bg-brand-soft text-lg text-foreground", (producingPage || urgentPage) && "text-xl", shipped && "text-2xl")}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const status = orderState(row.state)
            const remaining = countdownLabel(row.deadline, now)
            const urgent = isUrgent(row, now)
            const quantity = row.lines.reduce((total, line) => total + line.quantity, 0)
            return <TableRow key={row.dispatch_id}>
              <TableCell className={cn("px-4 font-medium tabular-nums", cellSpacing, cellText, urgentPage && "pl-12")}>{row.dispatch_no || "—"}</TableCell>
              <TableCell className={cn("max-w-72 px-4", cellSpacing, cellText)}><Product row={row} large={detailPage || urgentPage} shipped={shipped} /></TableCell>
              <TableCell className={cn("px-4 tabular-nums", cellSpacing, cellText)}>{row.lines.length ? <>{producingPage || urgentPage || shipped ? "× " : null}{quantity}</> : "—"}</TableCell>
              {urgentPage ? <TableCell className={cn("px-4", cellSpacing)}><Badge variant={status.variant}>{status.label}</Badge></TableCell> : null}
              {!shipped ? <TableCell className={cn("px-4 tabular-nums", cellSpacing, cellText, (pendingPage || urgentPage) && "whitespace-nowrap", urgent ? "text-destructive" : "text-muted-foreground")}>
                {remaining ? (remaining === "超时" ? remaining : `剩余 ${remaining}`) : "—"}
                {urgent && view !== "urgent" ? <Badge variant="destructive" className="ml-2">加急</Badge> : null}
                {producingPage && (row.nudge_count ?? 0) > 0 ? <Badge variant="destructive" className="ml-2">在催</Badge> : null}
              </TableCell> : null}
              {!shipped && !producingPage ? <TableCell className={cn("px-4", cellSpacing, urgentPage && [cellText, "whitespace-nowrap"])}>{urgentPage ? urgentReasons(row, now) : (row.nudge_count ?? 0) > 0 ? <Badge variant="destructive">在催</Badge> : "—"}</TableCell> : null}
              {!urgentPage ? <TableCell className={cn("px-4", cellSpacing)}><Badge variant={status.variant} className={shipped ? "h-10" : undefined}>{shipped ? <span className="text-2xl">{status.label}</span> : status.label}</Badge></TableCell> : null}
              <TableCell className={cn("px-3 text-center", cellSpacing)}>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`查看订单 ${row.dispatch_no || row.posting_number}`} onClick={() => onOpenOrder(row.dispatch_id)}>{producingPage || urgentPage || shipped ? <ChevronRight aria-hidden className={shipped ? "size-6 text-brand" : undefined} /> : <Eye aria-hidden />}</Button>
              </TableCell>
            </TableRow>
          })}
          {rows.length === 0 ? <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns} className="h-40 text-center text-sm text-muted-foreground">
              {loading ? <span role="status" className="inline-flex items-center gap-2"><Spinner className="size-4" />正在读取订单</span> : error ? "订单读取失败" : search || (urgentPage && (urgentState !== "all" || urgentReason !== "all")) ? "没有找到匹配的订单" : `暂无${viewLabels[view]}订单`}
            </TableCell>
          </TableRow> : null}
        </TableBody>
      </Table>
    </div>

    <div className={cn("flex shrink-0 justify-end gap-2 py-2", pendingPage ? "border-t border-border bg-card px-4" : urgentPage ? "bg-card p-4" : "bg-background")} aria-label="订单分页">
      <Button type="button" variant="outline" size={shipped ? "lg" : detailPage || urgentPage ? "sm" : "icon-sm"} className={shipped ? "h-14 min-w-32" : undefined} aria-label="上一页" disabled={loading || !hasPrevious} onClick={onPrevious}><ChevronLeft aria-hidden />{shipped ? <span className="text-xl">上一页</span> : detailPage || urgentPage ? "上一页" : null}</Button>
      <Button type="button" variant="outline" size={shipped ? "lg" : detailPage || urgentPage ? "sm" : "icon-sm"} className={shipped ? "h-14 min-w-32" : undefined} aria-label="下一页" disabled={loading || !hasNext} onClick={onNext}>{shipped ? <span className="text-xl">下一页</span> : detailPage || urgentPage ? "下一页" : null}<ChevronRight aria-hidden /></Button>
    </div>
    </div>
  </section>
}
