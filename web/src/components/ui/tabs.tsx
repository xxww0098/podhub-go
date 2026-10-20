import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

type TabsVariant = "pill" | "line"

function TabsList({
  className,
  variant = "pill",
  ...props
}: TabsPrimitive.List.Props & { variant?: TabsVariant }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "relative flex items-center text-muted-foreground",
        variant === "pill" &&
          "gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5",
        variant === "line" && "gap-5",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  variant = "pill",
  ...props
}: TabsPrimitive.Tab.Props & { variant?: TabsVariant }) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative z-10 flex cursor-pointer items-center justify-center font-medium text-faint-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-active:text-foreground",
        // Pill triggers carry their own inline padding so bare labels never run
        // together (提现审核's 待处理/已打款/已拒绝); caller px/w still wins.
        variant === "pill" && "rounded-[6px] px-2.5 text-xs",
        variant === "line" && "h-9 gap-1.5 rounded-[4px] px-1 text-compact",
        className,
      )}
      {...props}
    />
  )
}

function TabsIndicator({
  className,
  variant = "pill",
  ...props
}: TabsPrimitive.Indicator.Props & { variant?: TabsVariant }) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "absolute pointer-events-none left-(--active-tab-left) w-(--active-tab-width)",
        variant === "pill" &&
          "rounded-[6px] bg-card shadow-[0_1px_2px_var(--tw-shadow-color,oklch(0_0_0/0.08))] top-(--active-tab-top) h-(--active-tab-height)",
        variant === "line" && "bottom-0 h-0.5 rounded-full bg-foreground",
        "transition-[left,top,width,height] duration-200 ease-settle",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsIndicator, TabsContent }
