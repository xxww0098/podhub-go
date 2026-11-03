import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  variant = "pill",
  ...props
}: TabsPrimitive.Root.Props & { variant?: TabsVariant }) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col", variant === "segment" || variant === "capsule" ? "gap-0" : "gap-2", className)}
      {...props}
    />
  )
}

type TabsVariant = "pill" | "line" | "segment" | "capsule"

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
        variant === "segment" &&
          "grid w-full auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted p-1",
        variant === "capsule" &&
          "gap-0.5 rounded-full border border-border bg-muted/60 p-0.5",
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
        "relative z-10 flex cursor-pointer items-center justify-center max-md:min-h-11 max-md:min-w-11 font-medium text-faint-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-active:text-foreground",
        // Pill triggers carry their own inline padding so bare labels never run
        // together (提现审核's 待处理/已打款/已拒绝); caller px/w still wins.
        variant === "pill" && "rounded-[6px] px-2.5 text-xs",
        variant === "line" && "h-9 gap-1.5 rounded-[4px] px-1 text-compact",
        variant === "segment" && "h-10 min-w-0 gap-2 rounded-lg px-1 text-compact whitespace-nowrap data-active:text-brand-ink",
        variant === "capsule" && "h-8 gap-1.5 rounded-full px-3 text-compact whitespace-nowrap text-muted-foreground data-active:text-foreground",
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
        variant === "segment" &&
          "top-(--active-tab-top) h-(--active-tab-height) rounded-lg border border-border/70 bg-card shadow-sm",
        variant === "capsule" &&
          "top-(--active-tab-top) h-(--active-tab-height) rounded-full bg-card shadow-[0_1px_2px_var(--tw-shadow-color,oklch(0_0_0/0.08))]",
        "transition-[left,top,width,height] duration-200 ease-settle motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  variant = "pill",
  ...props
}: TabsPrimitive.Panel.Props & { variant?: TabsVariant }) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "flex-1 outline-none",
        variant === "segment" && "min-h-0 overflow-y-auto bg-muted/35 p-3 [scrollbar-gutter:stable] [scroll-padding-block:1rem] [overscroll-behavior:contain] sm:p-4",
        className,
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsIndicator, TabsContent }
