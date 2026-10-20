import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { useExclusiveOverlayOpen } from "@/lib/exclusive-overlay"
import { cn } from "@/lib/utils"

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: PopoverPrimitive.Root.Props) {
  const exclusive = useExclusiveOverlayOpen(open, onOpenChange, defaultOpen)
  return (
    <PopoverPrimitive.Root
      data-slot="popover"
      {...props}
      open={exclusive.open}
      onOpenChange={exclusive.onOpenChange}
    />
  )
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 w-80 max-w-[calc(100vw-24px)] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground shadow-overlay ring-1 ring-foreground/10 outline-none transition-[opacity,transform,translate,scale] duration-150 ease-settle data-ending-style:duration-100 data-starting-style:translate-y-1 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:translate-y-1 data-ending-style:scale-[0.98] data-ending-style:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
