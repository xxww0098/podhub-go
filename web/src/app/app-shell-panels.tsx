import { useEffect, type ReactNode } from "react"
import { ChevronsLeftRight } from "lucide-react"
import { Group, Panel, Separator as PanelSeparator, usePanelRef } from "react-resizable-panels"
import { useSidebar } from "@/components/ui/sidebar"

// The panel is the width authority for the full menu and the compact rail.
const SIDEBAR_WIDTH = "208px"
const SIDEBAR_WIDTH_ICON = "48px"
const SIDEBAR_WIDTH_MAX = "320px"

export function ShellPanels({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const { isMobile, open } = useSidebar()
  const sidebarRef = usePanelRef()

  useEffect(() => {
    if (!sidebarRef.current) return
    sidebarRef.current.resize(open ? SIDEBAR_WIDTH : SIDEBAR_WIDTH_ICON)
  }, [open, sidebarRef])

  return (
    <Group orientation="horizontal" disabled={isMobile} data-mobile={isMobile || undefined} className="shell-panels min-h-0 flex-1" id="app-layout">
      <Panel
        id="navigation"
        panelRef={sidebarRef}
        defaultSize={open ? SIDEBAR_WIDTH : SIDEBAR_WIDTH_ICON}
        minSize={open ? SIDEBAR_WIDTH : SIDEBAR_WIDTH_ICON}
        maxSize={open ? SIDEBAR_WIDTH_MAX : SIDEBAR_WIDTH_ICON}
        groupResizeBehavior="preserve-pixel-size"
      >
        {sidebar}
      </Panel>
      <PanelSeparator disabled={isMobile || !open} aria-label="调整侧栏宽度" className="shell-resize-handle">
        <ChevronsLeftRight aria-hidden className="size-3.5" />
      </PanelSeparator>
      <Panel id="workspace" minSize={isMobile ? "0px" : "280px"} className="flex h-full min-w-0 flex-col">
        {children}
      </Panel>
    </Group>
  )
}
