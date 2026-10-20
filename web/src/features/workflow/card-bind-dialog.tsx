import type { ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function CardBindDialog({
  open,
  onOpenChange,
  title,
  description,
  showCloseButton = true,
  busy = false,
  videoPanel,
  footer,
  children,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: string
  description: string
  showCloseButton?: boolean
  busy?: boolean
  videoPanel: ReactNode
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="@container grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton={showCloseButton}
        aria-busy={busy || undefined}
      >
        <DialogHeader className="gap-1 border-b border-border px-5 py-3">
          <DialogTitle className="pr-6 text-base font-semibold tracking-[-0.01em]">
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription className="text-xs text-muted-foreground">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="grid min-h-0 overflow-y-auto @min-[40rem]:grid-cols-[minmax(0,1fr)_20rem] @min-[40rem]:overflow-hidden">
          <div className="min-h-0 bg-card p-5 @min-[40rem]:overflow-y-auto">{children}</div>
          <aside className="flex h-full min-h-52 flex-col border-t border-border bg-card @min-[40rem]:min-h-0 @min-[40rem]:border-t-0 @min-[40rem]:border-l">
            {videoPanel}
          </aside>
        </div>
        <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-card px-5 py-3 sm:gap-2">
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
