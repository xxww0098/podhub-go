import { ArrowLeft } from "lucide-react"
import { IdentityMark } from "@/components/identity-mark"
import { SETTINGS_SECTION_ICONS } from "@/components/settings-section-icons"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { AccountOverview } from "@/bindings/commands"
import type { SettingsSection, SettingsSectionRow } from "@/lib/settings-sections"

export function SettingsNavigation({ rows, pane, onSelect, onBack, overview }: {
  rows: readonly SettingsSectionRow[]
  pane: SettingsSection | ""
  onSelect: (value: SettingsSection) => void
  onBack: () => void
  overview?: AccountOverview
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const groups = new Map<string, SettingsSectionRow[]>()
  for (const row of rows) {
    const group = groups.get(row.group) ?? []
    group.push(row)
    groups.set(row.group, group)
  }
  function leaveDrawer() {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <nav aria-label="设置分区">
      <SidebarGroup className="sticky top-0 z-10 bg-sidebar">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="返回业务页面" aria-label="返回业务页面" onClick={() => { onBack(); leaveDrawer() }}>
              <ArrowLeft />
              <span>返回业务页面</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      {[...groups.entries()].map(([group, items]) => (
        <SidebarGroup key={group}>
          <SidebarGroupLabel>{group}</SidebarGroupLabel>
          <SidebarMenu>
            {items.map((item) => {
              const Icon = SETTINGS_SECTION_ICONS[item.id]
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={pane === item.id}
                    tooltip={item.label}
                    aria-label={item.label}
                    aria-current={pane === item.id ? "page" : undefined}
                    onClick={() => { onSelect(item.id); leaveDrawer() }}
                  >
                    {item.account ? <IdentityMark kind="user" role={overview?.session.role} name={overview?.session.name ?? overview?.session.email ?? ""} imageUrl={overview?.session.avatar_url} className="size-6 shrink-0 group-data-[collapsible=icon]:size-4" /> : <Icon aria-hidden />}
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </nav>
  )
}
