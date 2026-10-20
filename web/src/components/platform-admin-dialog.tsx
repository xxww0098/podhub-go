import type { ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * The one dialog shell every 平台管理 detail/editor rides on: a hairline
 * header, a scrolling body, and an optional hairline footer. Hand-assembling
 * this trio per pane drifts paddings and mixes `vh`/`dvh` — the shell fixes
 * the rhythm so a 详情 reads the same in 兑换 as in 账号.
 */
export function PlatformAdminDialog({
  open,
  onOpenChange,
  title,
  description,
  header,
  footer,
  width = "sm:max-w-lg",
  className,
  showCloseButton = true,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  /** Visible under the title; stays sr-only when omitted. */
  description?: string
  /**
   * Full custom header content (e.g. identity tile + name + badges) rendered
   * inside the same bordered band; must contain DialogTitle/DialogDescription.
   */
  header?: ReactNode
  /** Pinned actions under a hairline; forms keep their own footer instead. */
  footer?: ReactNode
  /** DialogContent width class, e.g. "sm:max-w-md" or "sm:max-w-4xl". */
  width?: string
  className?: string
  /**
   * Hides the corner X. Set false while a dialog can only be left through the
   * actions it renders itself (an unsaved one-time secret, say).
   */
  showCloseButton?: boolean
  children: ReactNode
}) {
  const widthClass =
    width === "sm:max-w-sm"
      ? "sm:max-w-sm"
      : width === "sm:max-w-md"
        ? "sm:max-w-md"
        : width === "sm:max-w-3xl"
          ? "sm:max-w-3xl"
          : width === "sm:max-w-4xl"
            ? "sm:max-w-4xl"
            : width === "sm:max-w-lg" ? "sm:max-w-lg" : "sm:max-w-2xl"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="panel"
        showCloseButton={showCloseButton}
        className={cn(
          "w-full",
          widthClass,
          className,
        )}
      >
        <DialogHeader variant="panel">
          {header ?? (
            <>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className={description ? undefined : "sr-only"}>
                {description ?? (typeof title === "string" ? title : "详情")}
              </DialogDescription>
            </>
          )}
        </DialogHeader>
        {children}
        {footer ? (
          <PlatformAdminDialogFooter>{footer}</PlatformAdminDialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The hairline footer, exported separately so a <form> can wrap body and
 * footer together (the submit button must live inside the form).
 */
export function PlatformAdminDialogFooter({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <DialogFooter
      variant="panel"
      className={cn(
        "gap-2",
        className,
      )}
    >
      {children}
    </DialogFooter>
  )
}

