import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ButtonProps = React.ComponentProps<typeof Button>

/**
 * A button that shows only its glyph. The label is the accessible name and the
 * hover/focus tooltip, so nothing is lost to screen readers or keyboards.
 *
 * Use for toolbar and row actions with an unambiguous glyph (refresh, filter,
 * export, edit, copy, more). Keep text on commit buttons in dialogs and forms
 * (保存, 确认, 取消, 删除): a glyph alone is too easy to misread there.
 *
 * `size` defaults to `icon`; pass `icon-sm` or `icon-xs` for dense rows.
 */
export function IconButton({
  icon: Icon,
  iconClassName,
  label,
  tip,
  size = "icon",
  variant = "ghost",
  tooltipSide = "bottom",
  disabledReason,
  children,
  ...props
}: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: LucideIcon
  iconClassName?: string
  /** Accessible name. Also the tooltip text unless `tip` is given. */
  label: string
  /** Shorter tooltip when `label` carries an identifier (a product title, an order number). */
  tip?: string
  tooltipSide?: "top" | "right" | "bottom" | "left"
  /** When set and the button is disabled, the tooltip says why. */
  disabledReason?: string
  /** An optional badge or spinner drawn beside the glyph. */
  children?: React.ReactNode
}) {
  const shown = tip ?? label
  const text = props.disabled && disabledReason ? `${shown}：${disabledReason}` : shown
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={size}
            variant={variant}
            aria-label={label}
            {...props}
          />
        }
      >
        <Icon aria-hidden className={iconClassName} />
        {children}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={6}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
