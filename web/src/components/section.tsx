import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type SectionProps = {
  title: string
  action?: ReactNode
  description?: string
  /** Wraps the body in a hairline panel. Off for lists that carry their own. */
  framed?: boolean
  className?: string
  children: ReactNode
}

/**
 * The page's structural unit. A labelled region — not a card — so a screen can
 * have six of them without becoming a grid of identical boxes.
 */
export function Section({
  title,
  action,
  description,
  framed = false,
  className,
  children,
}: SectionProps) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xs font-bold tracking-[0.09em] text-foreground uppercase">
            {title}
          </h2>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      {framed ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
      ) : (
        children
      )}
    </section>
  )
}

type KeyValueProps = {
  label: string
  value: ReactNode
  /** Identifiers and hashes get the mono face. */
  mono?: boolean
  className?: string
}

export function KeyValue({ label, value, mono = false, className }: KeyValueProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="text-xs tracking-[0.09em] text-faint-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 text-sm text-foreground",
          mono ? "font-mono text-sm break-all select-all" : "break-words"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export function KeyValueGrid({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {children}
    </dl>
  )
}
