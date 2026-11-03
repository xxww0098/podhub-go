import { useEffect, useRef, type ReactNode } from "react"
import { Box, ChevronsLeftRight, UserRound, UsersRound } from "lucide-react"
import { Group, Panel, Separator as PanelSeparator, usePanelRef } from "react-resizable-panels"
import { SETTINGS_SECTION_ICONS } from "@/components/settings-section-icons"
import {
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AccountOverview } from "@/bindings/commands"
import type { SettingsSection, SettingsSectionRow } from "@/lib/settings-sections"

const SETTINGS_NAVIGATION_WIDTH = "208px"

type SettingsNavigationProps = {
  rows: readonly SettingsSectionRow[]
  pane: SettingsSection | ""
  onSelect: (value: SettingsSection) => void
  overview?: AccountOverview
}

function groupsFor(rows: readonly SettingsSectionRow[]) {
  const groups = new Map<string, SettingsSectionRow[]>()
  for (const row of rows) {
    const group = groups.get(row.group) ?? []
    group.push(row)
    groups.set(row.group, group)
  }
  return [...groups.entries()]
}

export function SettingsNavigation({ rows, pane, onSelect, hidden }: SettingsNavigationProps & { hidden?: boolean }) {
  const navRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!hidden) navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" })
  }, [pane, hidden])
  return (
    <nav ref={navRef} aria-label="设置分区" hidden={hidden} className="settings-navigation h-full overflow-y-auto overscroll-contain [--sidebar-accent:var(--brand-soft)] [--sidebar-accent-foreground:var(--brand-ink)]">
      {groupsFor(rows).map(([group, items]) => {
        const Icon = group === "个人" ? UserRound : group === "工作空间" ? UsersRound : Box
        return <div key={group} className="flex w-full min-w-0 flex-col gap-1 px-2 py-1">
          <SidebarGroupLabel
            data-settings-group={group}
            className="h-12 w-full gap-3 rounded-md px-3 text-left font-medium text-foreground [&>svg]:size-5"
          >
            <Icon aria-hidden className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-lg">{group}</span>
          </SidebarGroupLabel>
          <div className="pl-3">
            <SidebarMenu>
              {items.map((item) => {
                const Icon = SETTINGS_SECTION_ICONS[item.id]
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={pane === item.id}
                      aria-label={item.label}
                      aria-current={pane === item.id ? "page" : undefined}
                      onClick={() => onSelect(item.id)}
                    >
                      <Icon aria-hidden />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </div>
        </div>
      })}
    </nav>
  )
}

function MobileSettingsNavigation({ rows, pane, onSelect }: SettingsNavigationProps) {
  return (
    <nav aria-label="设置分区" className="border-b border-border p-3">
      <Select value={pane} onValueChange={(value) => {
        const row = rows.find((item) => item.id === value)
        if (row) onSelect(row.id)
      }}>
        <SelectTrigger aria-label="选择设置分区" className="w-full">
          <SelectValue>{rows.find((item) => item.id === pane)?.label ?? "选择设置"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {groupsFor(rows).map(([group, items]) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {items.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </nav>
  )
}

export function SettingsLayout({ children, ...props }: SettingsNavigationProps & { children: ReactNode }) {
  const { isMobile } = useSidebar()
  const navigationRef = usePanelRef()
  useEffect(() => {
    navigationRef.current?.resize(isMobile ? "0px" : SETTINGS_NAVIGATION_WIDTH)
  }, [isMobile, navigationRef])
  return (
    <div className="m-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {isMobile ? <MobileSettingsNavigation key="mobile-navigation" {...props} /> : null}
      <Group key="settings-panels" orientation="horizontal" disabled={isMobile} className="min-h-0 flex-1" id="settings-layout">
        <Panel id="settings-navigation" panelRef={navigationRef} defaultSize={SETTINGS_NAVIGATION_WIDTH} minSize={isMobile ? "0px" : "192px"} maxSize={isMobile ? "0px" : "320px"} groupResizeBehavior="preserve-pixel-size">
          <SettingsNavigation {...props} hidden={isMobile} />
        </Panel>
        {!isMobile ? (
          <PanelSeparator aria-label="调整设置分区宽度" className="group relative w-px">
            <span className="shell-resize-handle h-full">
              <ChevronsLeftRight aria-hidden className="size-3.5 group-focus-visible:opacity-100" />
            </span>
          </PanelSeparator>
        ) : null}
        <Panel id="settings-content" minSize={isMobile ? "0px" : "280px"} className="flex h-full min-w-0 flex-col">
          {children}
        </Panel>
      </Group>
    </div>
  )
}
