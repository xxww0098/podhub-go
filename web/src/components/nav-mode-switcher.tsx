import { Tabs } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

import { NAVIGATION, type NavMode } from "@/lib/app-navigation"

/**
 * Domain switch for the sidebar list with a smooth sliding capsule indicator.
 * Collapsed, labels drop and the tabs stack as icon buttons.
 */
export function NavModeSwitcher({
  mode,
  modes,
  onModeChange,
}: {
  mode: NavMode
  modes: readonly NavMode[]
  onModeChange: (mode: NavMode) => void
}) {
  return (
    <Tabs.Root
      value={mode}
      onValueChange={(val) => onModeChange(val as NavMode)}
      className="w-full"
    >
      <Tabs.List
        aria-label="导航模式"
        className="inset-well relative flex w-full items-center gap-0.5 rounded-lg p-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:p-0"
      >
        <Tabs.Indicator
          className="absolute left-(--active-tab-left) top-(--active-tab-top) h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-card shadow-[0_1px_2px_var(--tw-shadow-color,oklch(0_0_0/0.08))] transition-[left,top,width,height] duration-200 ease-settle pointer-events-none group-data-[collapsible=icon]:bg-sidebar-accent group-data-[collapsible=icon]:shadow-none"
        />
        {modes.map((id) => {
          const option = NAVIGATION[id]
          const Icon = option.icon
          return (
            <Tabs.Tab
              key={id}
              value={id}
              aria-label={option.label}
              title={option.label}
              className={cn(
                "relative z-10 flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-xs font-medium tracking-[0.015em] text-foreground transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                "hover:text-foreground data-active:font-semibold data-active:text-foreground select-none",
                "group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:hover:bg-sidebar-accent group-data-[collapsible=icon]:data-active:[&>svg]:text-brand",
              )}
            >
              <Icon
                className="hidden size-4 group-data-[collapsible=icon]:block"
                aria-hidden
              />
              <span className="group-data-[collapsible=icon]:hidden">{option.label}</span>
            </Tabs.Tab>
          )
        })}
      </Tabs.List>
    </Tabs.Root>
  )
}
