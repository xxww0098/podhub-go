import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange?: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  descriptionClassName?: string
  confirmText?: React.ReactNode
  cancelText?: React.ReactNode
  variant?: "default" | "destructive" | "brand"
  icon?: React.ReactNode
  busy?: boolean
  disabled?: boolean
  onConfirm: () => void | Promise<void>
  onCancel?: () => void
  children?: React.ReactNode
  size?: "sm" | "md" | "lg"
  footerLayout?: "equal" | "end"
  showCloseButton?: boolean
  className?: string
}

const sizeClasses = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionClassName,
  confirmText = "确认",
  cancelText = "取消",
  variant = "destructive",
  icon,
  busy = false,
  disabled = false,
  onConfirm,
  onCancel,
  children,
  size = "sm",
  footerLayout = "equal",
  showCloseButton = true,
  className,
}: ConfirmDialogProps) {
  const handleCancel = React.useCallback(() => {
    if (busy) return
    onCancel?.()
    onOpenChange?.(false)
  }, [busy, onCancel, onOpenChange])

  const handleConfirm = React.useCallback(() => {
    if (busy || disabled) return
    onConfirm()
  }, [busy, disabled, onConfirm])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        if (!next) {
          onCancel?.()
        }
        onOpenChange?.(next)
      }}
    >
      <DialogContent
        className={cn(sizeClasses[size], className)}
        showCloseButton={showCloseButton && !busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className={descriptionClassName}>
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {children}

        <DialogFooter
          className={cn(
            footerLayout === "equal" ? "gap-2 sm:gap-2" : "m-0 gap-2 sm:justify-end"
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={footerLayout === "equal" ? "flex-1" : undefined}
            disabled={busy}
            onClick={handleCancel}
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={variant}
            size="sm"
            className={footerLayout === "equal" ? "flex-1" : undefined}
            disabled={disabled || busy}
            onClick={handleConfirm}
          >
            {busy ? <Spinner data-icon="inline-start" /> : icon}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
