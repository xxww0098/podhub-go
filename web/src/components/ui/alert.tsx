import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Alerts carry the same six tones as the ledger, so a Result Unknown notice and
 * a Result Unknown row are visibly the same fact stated twice.
 */
const alertVariants = cva(
  "group/alert relative grid w-full gap-1 rounded-xl border px-3.5 py-3 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-card-foreground",
        destructive:
          "border-st-bad/30 bg-st-bad-soft text-st-bad-ink *:data-[slot=alert-description]:text-st-bad-ink/85",
        unknown:
          "border-st-unknown/35 bg-st-unknown-soft text-st-unknown-ink *:data-[slot=alert-description]:text-st-unknown-ink/85",
        attest:
          "border-st-attest/30 bg-st-attest-soft text-st-attest-ink *:data-[slot=alert-description]:text-st-attest-ink/85",
        good: "border-st-good/30 bg-st-good-soft text-st-good-ink *:data-[slot=alert-description]:text-st-good-ink/85",
        brand:
          "border-brand/25 bg-brand-soft text-brand-ink *:data-[slot=alert-description]:text-brand-ink/85",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  role = "alert",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
