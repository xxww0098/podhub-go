import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  XIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"

const toast = ToastPrimitive.createToastManager()

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed top-4 left-1/2 -translate-x-1/2 z-[100] mx-0 flex w-[min(100%-2rem,22rem)] max-w-sm flex-col outline-none",
        className,
      )}
      {...props}
    />
  )
}

function Toast({
  className,
  swipeDirection = ["up", "right"],
  ...props
}: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      swipeDirection={swipeDirection}
      className={cn(
        "group/toast pointer-events-auto absolute top-0 left-0 z-[calc(1000-var(--toast-index))] w-full origin-top rounded-xl border border-border bg-card text-card-foreground shadow-overlay will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "[--gap:0.625rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))] [--peek:0.625rem] [--scale:calc(max(0,1-(var(--toast-index)*0.08)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_200ms_var(--ease-settle),opacity_150ms,height_150ms]",
        "after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-limited:opacity-0 data-starting-style:[transform:translateY(-120%)] data-starting-style:opacity-0",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-120%)] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:opacity-0",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "motion-reduce:transition-none motion-reduce:data-starting-style:transform-none motion-reduce:[&[data-ending-style]]:transform-none",
        "data-[type=error]:border-st-bad/40 dark:data-[type=error]:border-st-bad/35",
        "data-[type=success]:border-st-good/40 dark:data-[type=success]:border-st-good/35",
        "data-[type=warning]:border-st-attest/40 dark:data-[type=warning]:border-st-attest/35",
        "data-[type=info]:border-brand/35 dark:data-[type=info]:border-brand/30",
        "data-[type=loading]:border-st-flight/40 dark:data-[type=loading]:border-st-flight/35",
        "data-[type=unknown]:border-st-unknown/40 dark:data-[type=unknown]:border-st-unknown/35",
        className,
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "flex h-full items-start gap-3 overflow-hidden p-3.5 transition-opacity duration-150 ease-settle data-behind:opacity-0 data-expanded:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn(
        "text-compact leading-snug font-semibold text-foreground tracking-[-0.01em] break-words text-balance",
        className,
      )}
      {...props}
    />
  )
}

function ToastDescription({
  className,
  render = <div />,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      render={render}
      className={cn(
        "whitespace-pre-line text-xs leading-relaxed text-muted-foreground tabular-nums break-words",
        className,
      )}
      {...props}
    />
  )
}

function ToastAction({
  className,
  render = <Button variant="outline" size="xs" />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("shrink-0 self-center text-xs font-medium", className)}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-xs" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="关闭通知"
      render={render}
      className={cn(
        "relative z-10 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/80 rounded-md transition-colors after:absolute after:-inset-1 after:content-['']",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  )
}

function ToastIcon({ type }: { type: string | undefined }) {
  let icon: React.ReactNode = null
  let toneClass = ""

  if (type === "success") {
    icon = <CircleCheckIcon aria-hidden="true" />
    toneClass = "bg-st-good-soft text-st-good-ink border-st-good/30"
  } else if (type === "info") {
    icon = <InfoIcon aria-hidden="true" />
    toneClass = "bg-brand-soft text-brand-ink border-brand/25"
  } else if (type === "warning") {
    icon = <TriangleAlertIcon aria-hidden="true" />
    toneClass = "bg-st-attest-soft text-st-attest-ink border-st-attest/30"
  } else if (type === "error") {
    icon = <OctagonXIcon aria-hidden="true" />
    toneClass = "bg-st-bad-soft text-st-bad-ink border-st-bad/30"
  } else if (type === "loading") {
    icon = <Spinner aria-hidden="true" />
    toneClass = "bg-st-flight-soft text-st-flight-ink border-st-flight/25"
  } else if (type === "unknown") {
    icon = <CircleHelpIcon aria-hidden="true" />
    toneClass = "bg-st-unknown-soft text-st-unknown-ink border-st-unknown/30"
  }

  if (!icon) return null

  return (
    <span
      data-slot="toast-icon"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg border",
        "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        toneClass,
      )}
    >
      {icon}
    </span>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toastItem) => (
    <Toast key={toastItem.id} toast={toastItem}>
      <ToastContent>
        <ToastIcon type={toastItem.type} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <ToastTitle />
          <ToastDescription />
        </div>
        {toastItem.actionProps ? <ToastAction {...toastItem.actionProps} /> : null}
        <ToastClose />
      </ToastContent>
    </Toast>
  ))
}

function Toaster({
  children,
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const createToastManager = ToastPrimitive.createToastManager
const useToastManager = ToastPrimitive.useToastManager

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
}
