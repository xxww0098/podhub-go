import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The ledger table. The listing workbench overrides row height to a stable 80px
 * for virtualization.
 */
function Table({
  className,
  containerClassName,
  containerRef,
  onContainerScroll,
  ...props
}: React.ComponentProps<"table"> & {
  /** Bound the ledger's own scroll so filters and tallies stay on screen. */
  containerClassName?: string
  containerRef?: React.Ref<HTMLDivElement>
  onContainerScroll?: React.UIEventHandler<HTMLDivElement>
}) {
  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      onScroll={onContainerScroll}
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        /*
          Separate borders, not collapsed. A collapsed border belongs to the
          table, so a `position: sticky` header cell leaves its own edge behind
          and scrolls content under a line-less bar. Every rule below therefore
          hangs the divider on the cell, which travels with it when it pins.
        */
        className={cn(
          "w-full caption-bottom border-separate border-spacing-0 text-sm",
          className,
        )}
        {...props}
      />
    </div>
  )
}

/** No border rule here: TableHead carries it, so a caller's own edge wins. */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={className}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child>*]:border-b-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/60 font-medium [&_td]:border-t [&_td]:border-t-border [&>tr:last-child>*]:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "transition-colors duration-150 hover:bg-muted/60 has-aria-expanded:bg-muted/60 data-[state=selected]:bg-brand-soft/60",
        className
      )}
      {...props}
    />
  )
}

/**
 * The ledger's expandable detail row — a full-width `<tr>` whose cell wraps
 * the content in a grid-rows track so the drawer rolls open instead of
 * snapping. `closing` rewinds the roll before the caller unmounts the row;
 * the motion lives in the `table-expanded-row` utility (see index.css).
 */
function TableExpandedRow({
  className,
  colSpan,
  closing = false,
  children,
  ...props
}: React.ComponentProps<"tr"> & {
  /** Every column the detail must span — the caller knows its own table. */
  colSpan: number
  /** True while the close animation plays; the caller unmounts after it. */
  closing?: boolean
}) {
  return (
    <tr
      data-slot="table-expanded-row"
      data-closing={closing || undefined}
      className={cn("table-expanded-row bg-muted/40 hover:bg-muted/40", className)}
      {...props}
    >
      <td data-slot="table-cell" colSpan={colSpan} className="border-b border-border px-2.5">
        <div data-slot="table-expanded-track">
          <div data-slot="table-expanded-clip">
            <div data-slot="table-expanded-inner">{children}</div>
          </div>
        </div>
      </td>
    </tr>
  )
}

function TableHead({ className, scope = "col", ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-8 border-b border-border px-2.5 text-left align-middle text-meta font-semibold tracking-[0.09em] whitespace-nowrap text-faint-foreground uppercase [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "border-b border-border px-2.5 py-2 align-middle [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableExpandedRow,
  TableCell,
  TableCaption,
}
