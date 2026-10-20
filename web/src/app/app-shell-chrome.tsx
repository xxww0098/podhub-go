import { PanelLeftClose, PanelLeftOpen, Settings, Store } from "lucide-react"
import { useWorkflowProgress } from "@/features/workflow/workbench/listing-workbench-store"
import { WorkflowTaskProgress } from "@/features/workflow/workflow-task-progress"
import { ThemeToggleCompact } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SCREEN_LABELS, type AppScreen } from "@/lib/app-screens"
import type { NavItem } from "@/lib/app-navigation"
import { preloadScreen } from "./screen-loaders"
import { prefetchScreenData } from "./prefetch-screen-data"

export function ShellHeaderActivity({
  screen,
  onOpenListing,
}: {
  screen: AppScreen
  onOpenListing: () => void
}) {
  const progress = useWorkflowProgress()
  if (screen === "listing" || !progress) return null
  return <WorkflowTaskProgress progress={progress} onOpen={onOpenListing} />
}

/** One-tap jump to 店铺 (store & Seller-key management), sitting next to the header wallet. */
export function StoreQuickButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="店铺"
            onClick={onOpen}
            onMouseEnter={() => preloadScreen("stores")}
            onFocus={() => preloadScreen("stores")}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Store className="size-4" aria-hidden />
          </button>
        }
      />
      <TooltipContent side="bottom" sideOffset={8}>店铺</TooltipContent>
    </Tooltip>
  )
}

export function SidebarUtilityBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { toggleSidebar, state } = useSidebar()
  const collapsed = state === "collapsed"
  const collapseLabel = collapsed ? "展开侧栏" : "折叠侧栏"

  return (
    <div
      role="toolbar"
      aria-label="侧栏工具"
      className="inset-well flex w-full items-center gap-0.5 rounded-lg p-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:p-0"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={collapseLabel}
              onClick={toggleSidebar}
              className="flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring group-data-[collapsible=icon]:order-last group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:hover:bg-sidebar-accent"
            />
          }
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <PanelLeftClose className="size-3.5" aria-hidden />
          )}
        </TooltipTrigger>
        <TooltipContent>{collapseLabel}</TooltipContent>
      </Tooltip>
      <ThemeToggleCompact className="size-auto h-6 min-w-0 flex-1 rounded-md group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:flex-none" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="设置"
              onClick={() => onOpenSettings()}
              className="flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:hover:bg-sidebar-accent"
            />
          }
        >
          <Settings className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>设置</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function NavGroup({
  items,
  screen,
  onScreenChange,
  badges,
}: {
  items: readonly NavItem[]
  screen: AppScreen
  onScreenChange: (screen: AppScreen) => void
  badges?: Partial<Record<AppScreen, string>>
}) {
  return (
    <SidebarGroup className="px-3.5 pb-2.5 pt-3.5">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {items.map((item) => {
            const Icon = item.icon
            const badge = badges?.[item.id]
            const active = screen === item.id
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={active}
                  tooltip={SCREEN_LABELS[item.id]}
                  aria-label={SCREEN_LABELS[item.id]}
                  aria-current={active ? "page" : undefined}
                  onMouseEnter={() => {
                    preloadScreen(item.id)
                    prefetchScreenData(item.id)
                  }}
                  onFocus={() => {
                    preloadScreen(item.id)
                    prefetchScreenData(item.id)
                  }}
                  onClick={() => onScreenChange(item.id)}
                  /* "You are here" needs no fifth device: the system already
                     says selection is Cabinet Blue and active chrome is recess
                     fill. So the row fills, the label goes to full ink, and the
                     glyph — the only mark that is the same shape in every row —
                     takes the blue. A drawn bar would be a new vocabulary for a
                     job two existing rules already do. */
                  className="data-active:[&>svg]:text-brand"
                >
                  <Icon />
                  <span className="font-medium tracking-[0.015em] select-none">{SCREEN_LABELS[item.id]}</span>
                  {badge ? (
                    <Badge
                      variant="outline"
                      className="ml-auto font-mono text-meta font-semibold tabular-nums group-data-[collapsible=icon]:hidden"
                    >
                      {badge}
                    </Badge>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
