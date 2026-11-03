import { useEffect, useRef } from "react"
import { PanelLeft } from "lucide-react"
import { useWorkflowProgress } from "@/features/workflow/workbench/listing-workbench-store"
import { WorkflowTaskProgress } from "@/features/workflow/workflow-task-progress"
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
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

export function SidebarCollapseButton() {
  const { toggleSidebar, state, isMobile } = useSidebar()
  const collapsed = state === "collapsed"
  const collapseLabel = collapsed ? "展开侧栏" : "折叠侧栏"
  if (isMobile) return null

  return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={collapseLabel}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
              className="shell-sidebar-toggle flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          }
        >
          <PanelLeft className="size-4" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{collapseLabel}</TooltipContent>
      </Tooltip>
  )
}

export function NavGroup({
  label,
  items,
  screen,
  onScreenChange,
}: {
  label: string
  items: readonly NavItem[]
  screen: AppScreen | null
  onScreenChange: (screen: AppScreen) => void
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    groupRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" })
  }, [screen])
  return (
    <SidebarGroup ref={groupRef} role="group" aria-label={label}>
      <SidebarGroupLabel>
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const Icon = item.icon
            const active = screen === item.id
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={active}
                  tooltip={SCREEN_LABELS[item.id]}
                  aria-label={SCREEN_LABELS[item.id]}
                  data-screen={item.id}
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
                >
                  <Icon aria-hidden />
                  <span className="select-none">{SCREEN_LABELS[item.id]}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
