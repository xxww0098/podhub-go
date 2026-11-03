import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChartNoAxesColumn, ClipboardList, RefreshCw, Settings2, Truck, Zap } from "lucide-react"
import type { components } from "@/api/schema"
import { ShellPanels } from "@/app/app-shell-panels"
import { IconButton } from "@/components/ui/icon-button"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getFactoryDashboard, getFactoryDispatch, listFactoryDispatches, type FactoryOrderView } from "@/factory/api"
import { FactoryDashboard } from "@/factory/dashboard/factory-dashboard"
import { useNow, useReducedMotion } from "@/factory/lib/order"
import { DispatchDetailDialog } from "@/factory/orders/factory-dispatch-dialog"
import { FactoryOrders } from "@/factory/orders/factory-orders"
import { FactoryAccountMenu } from "@/factory/sidebar/factory-account-menu"
import { FactoryWorkspaceMenu } from "@/factory/sidebar/factory-workspace-menu"
import { useAddress } from "@/hooks/use-address"
import { replaceAddress } from "@/lib/address"
import { notifyCommandError } from "@/lib/notify"

type FactoryView = "dashboard" | FactoryOrderView
type Source = components["schemas"]["SupplierSourceCard"]

const navigation = [
  { view: "dashboard", label: "控制台", icon: ChartNoAxesColumn },
  { view: "pending", label: "待生产", icon: ClipboardList },
  { view: "producing", label: "生产中", icon: Settings2 },
  { view: "urgent", label: "加急", icon: Zap },
  { view: "shipped", label: "已发货", icon: Truck },
] as const

export function factoryViewFromPath(pathname: string): FactoryView {
  const last = pathname.replace(/\/+$/, "").split("/").pop()
  return last === "pending" || last === "producing" || last === "urgent" || last === "shipped"
    ? last
    : "dashboard"
}

function factoryAddress(view: FactoryView, source_id: string): string {
  const path = view === "dashboard" ? "/supplier" : `/supplier/orders/${view}`
  const search = new URLSearchParams({ workspace: source_id })
  return `${path}?${search}`
}

export function FactoryWorkspace({ sources, accountName, accountEmail, onSignedOut }: {
  sources: Source[]
  accountName: string
  accountEmail?: string
  onSignedOut: () => void
}) {
  const address = useAddress()
  const view = factoryViewFromPath(address.pathname)
  const requested = new URLSearchParams(address.search).get("workspace")
  const source = sources.find((item) => item.source_id === requested) ?? sources[0]
  if (!source) return null

  const navigate = (next: FactoryView, source_id = source.source_id) => replaceAddress(factoryAddress(next, source_id))
  return <TooltipProvider>
    {/* Shared shell geometry matches the main workspace. */}
    {/* oxlint-disable-next-line shadcn/no-restyle */}
    <SidebarProvider defaultOpen className="workspace-shell flex h-svh flex-col overflow-hidden">
      <ShellPanels sidebar={
        // oxlint-disable-next-line shadcn/no-restyle
        <Sidebar collapsible="icon" className="shell-sidebar">
          <SidebarHeader>
            <FactoryWorkspaceMenu sources={sources} selectedId={source.source_id} onSelect={(id) => navigate(view, id)} />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>总览</SidebarGroupLabel>
              <SidebarMenu>
                {navigation.slice(0, 1).map(({ view: item, label, icon: Icon }) => <SidebarMenuItem key={item}>
                  <SidebarMenuButton isActive={view === item} aria-current={view === item ? "page" : undefined} tooltip={label} onClick={() => navigate(item)}>
                    <Icon aria-hidden /><span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>)}
              </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>订单</SidebarGroupLabel>
              <SidebarMenu>
                {navigation.slice(1).map(({ view: item, label, icon: Icon }) => <SidebarMenuItem key={item}>
                  <SidebarMenuButton isActive={view === item} aria-current={view === item ? "page" : undefined} tooltip={label} onClick={() => navigate(item)}>
                    <Icon aria-hidden /><span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>)}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter><FactoryAccountMenu name={accountName} email={accountEmail} onSignedOut={onSignedOut} /></SidebarFooter>
        </Sidebar>
      }>
        <FactoryContent key={`${source.source_id}:${view}`} source_id={source.source_id} view={view} onNavigate={(next) => navigate(next)} />
      </ShellPanels>
    </SidebarProvider>
  </TooltipProvider>
}

function FactoryContent({ source_id, view, onNavigate }: {
  source_id: string
  view: FactoryView
  onNavigate: (view: FactoryView) => void
}) {
  const [search, setSearch] = useState("")
  const [urgentState, setUrgentState] = useState<"all" | "dispatched" | "accepted">("all")
  const [urgentReason, setUrgentReason] = useState<"all" | "deadline" | "nudge">("all")
  const [cursors, setCursors] = useState([""])
  const [page, setPage] = useState(0)
  const [openId, setOpenId] = useState<string>()
  const queryClient = useQueryClient()
  const now = useNow(useReducedMotion())
  const dashboard = useQuery({
    queryKey: ["factory", source_id, "dashboard"],
    queryFn: () => getFactoryDashboard(source_id),
    enabled: view === "dashboard",
    refetchInterval: 15_000,
  })
  const orders = useQuery({
    queryKey: ["factory", source_id, "orders", view, search, urgentState, urgentReason, cursors[page]],
    queryFn: () => listFactoryDispatches(source_id, {
      view: view as FactoryOrderView, search, cursor: cursors[page],
      status: view === "urgent" ? urgentState : undefined,
      reason: view === "urgent" ? urgentReason : undefined,
    }),
    enabled: view !== "dashboard",
    refetchInterval: 15_000,
  })
  const detail = useQuery({
    queryKey: ["factory", source_id, "dispatch", openId],
    queryFn: () => getFactoryDispatch(openId!),
    enabled: !!openId,
  })
  useEffect(() => {
    if (!openId || !detail.isError) return
    notifyCommandError(detail.error, "订单详情没读出来，请稍后重试。")
    setOpenId(undefined)
  }, [detail.error, detail.isError, openId])
  const active = view === "dashboard" ? dashboard : orders
  const label = navigation.find((item) => item.view === view)?.label ?? "控制台"
  const data = orders.data
  const nextCursor = data?.has_more ? data.cursor : ""
  const nextValid = Boolean(nextCursor && !cursors.slice(0, page + 1).includes(nextCursor))
  const resetPage = () => { setCursors([""]); setPage(0) }
  return <SidebarInset className="min-h-0 overflow-hidden">
    <header className="shell-header flex shrink-0 items-center gap-3 border-b border-border px-3">
      <SidebarTrigger />
      <span className="hidden text-sm text-muted-foreground sm:inline">{view === "dashboard" ? "总览" : "订单"}</span>
      <span aria-hidden className="hidden text-muted-foreground sm:inline">/</span>
      <span className="text-sm font-semibold">{label}</span>
      <div className="flex-1" />
      {active.dataUpdatedAt ? <span className="hidden text-meta text-muted-foreground tabular-nums sm:inline">
        更新于 {new Date(active.dataUpdatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
      </span> : null}
      <IconButton icon={RefreshCw} label="刷新" variant="outline" size="icon-sm" disabled={active.isFetching} onClick={() => void active.refetch()} />
    </header>
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4">
      {view === "dashboard" ? <>
        {dashboard.isError ? <p role="alert" className="mb-3 text-sm text-destructive">
          {dashboard.data ? "统计刷新失败，当前显示上次读取的数据。" : "无法读取订单统计，请点击刷新重试。"}
        </p> : null}
        <FactoryDashboard counts={dashboard.data?.counts} urgent_orders={dashboard.data?.urgent_orders ?? []}
          now={now} loading={dashboard.isPending && !dashboard.isError}
          onOpenOrder={setOpenId} onOpenList={onNavigate} />
      </> : <FactoryOrders
        view={view} rows={data?.dispatches ?? []} now={now}
        loading={orders.isFetching && !orders.data}
        error={orders.isError ? "订单读取失败" : data?.has_more && !nextValid ? "订单分页信息无效" : undefined}
        search={search} onSearchChange={(value) => { setSearch(value); resetPage() }}
        urgentState={urgentState} urgentReason={urgentReason}
        onUrgentStateChange={(value) => { setUrgentState(value); resetPage() }}
        onUrgentReasonChange={(value) => { setUrgentReason(value); resetPage() }}
        hasPrevious={page > 0} hasNext={nextValid}
        onPrevious={() => setPage((value) => Math.max(0, value - 1))}
        onNext={() => {
          if (!nextValid) return
          setCursors((previous) => [...previous.slice(0, page + 1), nextCursor])
          setPage((value) => value + 1)
        }}
        onOpenOrder={setOpenId} onRetry={() => void orders.refetch()}
      />}
    </main>
    <DispatchDetailDialog open={!!openId} detail={detail.data} busy={detail.isFetching}
      onOpenChange={(open) => { if (!open) setOpenId(undefined) }}
      onAction={async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["factory", source_id, "dashboard"] }),
          queryClient.invalidateQueries({ queryKey: ["factory", source_id, "orders"] }),
          detail.refetch(),
        ])
      }}
    />
  </SidebarInset>
}
