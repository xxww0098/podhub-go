import type { ComponentType, ReactNode } from "react"
import {
  RefreshCw,
  Search,
  X,
} from "lucide-react"

import { PageToolbar } from "@/components/page-toolbar"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type AdminIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>

/**
 * One work surface under 平台管理 nav. Three bands on one rhythm: an optional
 * facts strip, an optional toolbar, then the ledger — a hairline-ruled list
 * that sits directly on the pane.
 *
 * The rule always belongs to the ledger's top edge. A pane that has no toolbar
 * (集成) therefore still opens on a line rather than floating its first row in
 * the sheet, and a pane that has one does not stack a second header band.
 */
export function PlatformAdminSurface({
  summary,
  toolbar,
  children,
  className,
  bodyClassName,
}: {
  /** Short label/value facts about this pane, above the controls. */
  summary?: ReactNode
  /** Filters, search and primary actions for this pane. */
  toolbar?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {summary || toolbar ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pb-2">
        {summary ? <PlatformAdminSummary className="min-w-0 flex-1 basis-full sm:basis-auto">{summary}</PlatformAdminSummary> : null}
        {toolbar ? <PageToolbar primary={toolbar} className="min-w-0 flex-1 basis-80" /> : null}
      </div> : null}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 border-t border-border",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  )
}

/** Compact facts above a pane's ledger — not a header inside the body. */
export function PlatformAdminSummary({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-compact text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * One underline tab. Switching a pane's own view is not navigation, so it gets
 * the sheet's flat brand underline rather than a pill box — the same mark the
 * settings rail uses for "you are here".
 */
export function PlatformAdminTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active || undefined}
      onClick={onClick}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-1.5 px-2.5 text-compact font-medium text-faint-foreground transition-colors",
        "hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "data-active:text-foreground data-active:shadow-[inset_0_-2px_0_0_var(--brand)]",
      )}
    >
      {children}
    </button>
  )
}

/**
 * A labelled region inside a pane, for surfaces that stack more than one
 * ledger (代理 keeps its roster above the commission ledger). The micro-caps
 * heading is the same one the settings rail and 提示词's master list use, so a
 * second region reads as structure rather than as a second screen.
 */
export function PlatformAdminSection({
  title,
  count,
  description,
  action,
  children,
  className,
}: {
  title: string
  /** Row tally, shown next to the heading in the mono face. */
  count?: number
  /** One line on what the region holds, under the heading. */
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-1.5">
        <h3 className="flex items-baseline gap-2 text-compact font-medium text-foreground">
          {title}
          {count !== undefined ? (
            <span className="font-mono tabular-nums">{count}</span>
          ) : null}
        </h3>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      {description ? (
        <p className="pb-2 text-meta text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  )
}

/**
 * The one placeholder every 平台管理 pane opens on — reading, empty, or
 * refused. One shape across all seven panes means a short ledger reads as
 * "nothing here yet" instead of as a surface that failed to paint.
 */
export function PlatformAdminEmpty({
  icon: Icon,
  title,
  description,
  action,
  busy = false,
  className,
}: {
  icon: AdminIcon
  /**
   * Omit only where the page may not carry copy — a failed read keeps its
   * explanation in a notification and shows just the icon and retry.
   */
  title?: string
  description?: string
  action?: ReactNode
  /** Swaps the icon for a spinner and announces the wait. */
  busy?: boolean
  className?: string
}) {
  return (
    <Empty
      role={busy ? "status" : undefined}
      className={cn("min-h-32 rounded-none border-0", className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {busy ? <Spinner /> : <Icon aria-hidden />}
        </EmptyMedia>
        {title ? <EmptyTitle>{title}</EmptyTitle> : null}
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/**
 * The toolbar search field: an icon-affixed InputGroup with a clear button
 * once text lands. Enter submits when the pane filters server-side.
 */
export function PlatformAdminSearch({
  value,
  onChange,
  placeholder,
  label,
  onSubmit,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** aria-label; defaults to the placeholder. */
  label?: string
  /** Server-filtered panes apply on Enter instead of on every keystroke. */
  onSubmit?: () => void
  className?: string
}) {
  return (
    <InputGroup className={cn("h-9 min-w-48 flex-1 sm:max-w-sm", className)}>
      <InputGroupAddon>
        <InputGroupText>
          <Search className="size-3.5" />
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="placeholder:text-muted-foreground"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit?.()
        }}
      />
      {value ? (
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton
                  size="icon-xs"
                  aria-label="清空搜索"
                  onClick={() => onChange("")}
                />
              }
            >
              <X aria-hidden />
            </TooltipTrigger>
            <TooltipContent>清空搜索</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

/** The toolbar refresh: a ghost icon that spins while its read is in flight. */
export function PlatformAdminRefresh({
  busy,
  onClick,
  label = "刷新",
}: {
  busy: boolean
  onClick: () => void
  label?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="cursor-pointer"
            aria-label={label}
            disabled={busy}
            onClick={onClick}
          />
        }
      >
        <RefreshCw
          aria-hidden
          className={cn("size-3.5", busy && "animate-spin")}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
