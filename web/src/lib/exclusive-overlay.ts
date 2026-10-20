import { useCallback, useEffect, useRef, useState } from "react"

/**
 * One floating layer at a time. Menus, popovers and context menus share this
 * slot so opening 运行状态 closes 按状态选择, and 绑定店铺 cannot sit on top of
 * 绑定 PSD. Dialogs stay out: a picker inside a modal must not dismiss it.
 */
let occupant: (() => void) | null = null

export function occupyOverlay(close: () => void): () => void {
  const previous = occupant
  occupant = close
  if (previous && previous !== close) previous()
  return () => {
    if (occupant === close) occupant = null
  }
}

export function useExclusiveOverlayOpen<Details = unknown>(
  open: boolean | undefined,
  onOpenChange: ((open: boolean, eventDetails: Details) => void) | undefined,
  defaultOpen = false,
): {
  open: boolean
  onOpenChange: (open: boolean, eventDetails: Details) => void
} {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const controlled = open !== undefined
  const isOpen = controlled ? Boolean(open) : uncontrolled
  const closeRef = useRef(() => {})

  const setOpen = useCallback(
    (next: boolean, eventDetails: Details) => {
      if (!controlled) setUncontrolled(next)
      onOpenChange?.(next, eventDetails)
    },
    [controlled, onOpenChange],
  )
  closeRef.current = () => setOpen(false, undefined as Details)

  useEffect(() => {
    if (!isOpen) return
    return occupyOverlay(() => closeRef.current())
  }, [isOpen])

  return { open: isOpen, onOpenChange: setOpen }
}
