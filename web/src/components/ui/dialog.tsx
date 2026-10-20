import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useScreenActive } from "@/components/screen-pane"
import { XIcon } from "lucide-react"

type DialogProps = Omit<DialogPrimitive.Root.Props, "onOpenChange"> & {
  onOpenChange?: (open: boolean) => void
}

function Dialog({ open, onOpenChange, ...props }: DialogProps) {
  const screenActive = useScreenActive()

  // ScreenPane intentionally keeps visited modules mounted. Base UI portals
  // escape the pane's hidden/inert subtree, so an inactive module's dialog
  // would otherwise remain visible over the newly selected module.
  React.useEffect(() => {
    if (!screenActive && open === true) onOpenChange?.(false)
  }, [onOpenChange, open, screenActive])

  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
      open={screenActive ? open : false}
      onOpenChange={onOpenChange}
    />
  )
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      // Base UI hides a nested dialog's backdrop; our nested dialogs still
      // need their own scrim over the parent popup.
      forceRender
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-opacity duration-150 data-closed:pointer-events-none data-closed:invisible data-ending-style:opacity-0 data-starting-style:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  layout = "default",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  layout?: "default" | "panel" | "settings"
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // grid-cols-1 pins the single track to the popup width. An implicit
          // auto track instead grows to its widest child's max-content, so one
          // long unbreakable string (a filename, a URL) stretches every row —
          // the footer buttons included — past the popup's right edge.
          "fixed top-1/2 left-1/2 z-50 grid w-full grid-cols-1 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-overlay outline-none transition-[opacity,transform,translate,scale] duration-150 ease-settle data-closed:pointer-events-none data-closed:invisible sm:max-w-md",
          "data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          layout === "panel" && "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0",
          layout === "settings" && "h-[min(90dvh,52rem)] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-7xl",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
                aria-label="关闭"
              />
            }
          >
            <XIcon aria-hidden />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, variant = "default", ...props }: React.ComponentProps<"div"> & { variant?: "default" | "panel" }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-8", variant === "panel" && "shrink-0 border-b border-border px-5 py-4 pr-14", className)}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
  variant?: "default" | "panel"
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-border bg-muted/50 p-4 sm:flex-row sm:justify-end",
        variant === "panel" && "m-0 shrink-0 rounded-none bg-transparent px-5 py-4",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  // Descriptions carry user data (file names, URLs); break inside a token
  // instead of letting it overflow the popup.
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("wrap-anywhere text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
