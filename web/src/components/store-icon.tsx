import { forwardRef } from "react"
import { Store, type LucideIcon } from "lucide-react"

/**
 * The one glyph for a Seller store. Lucide's default 2px stroke clogs the
 * awning at the 14-16px sizes buttons and filters render it at, so every store
 * mark shares a lighter stroke. Callers size it with `size-*` as for any icon.
 */
export const StoreIcon: LucideIcon = forwardRef<SVGSVGElement, React.ComponentProps<LucideIcon>>(
  function StoreIcon({ strokeWidth = 1.5, ...props }, ref) {
    return <Store ref={ref} strokeWidth={strokeWidth} {...props} />
  },
)
