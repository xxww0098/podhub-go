import { CircleAlert, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ErrorNoticeProps = {
  /** What failed, in the product's own words. */
  title: string
  /** What it does and does not mean, and the way out. */
  description?: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
} & (
  | {
      /** Centered, for a region whose whole content failed to load. */
      layout: "block"
    }
  | {
      /** A strip above or inside a surface that still has usable content. */
      layout: "banner"
    }
  | {
      /** One line beside a control that just failed. */
      layout: "text"
      /** Lets the control point at this message with `aria-describedby`. */
      id?: string
    }
)

/**
 * The one in-page error surface. Transient failures of a single action belong
 * in the toast host (`notifyCommandError`); this is for a failure that must stay
 * on screen because the content it explains is missing or stale.
 */
export function ErrorNotice(props: ErrorNoticeProps) {
  const { title, description, onRetry, retryLabel = "重试", className } = props
  const retry = onRetry ? (
    <Button type="button" size="xs" variant="outline" onClick={onRetry}>
      <RefreshCw aria-hidden />{retryLabel}
    </Button>
  ) : null

  if (props.layout === "text") {
    return (
      <p id={props.id} role="alert" className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-st-bad-ink", className)}>
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{title}</span>
      </p>
    )
  }

  if (props.layout === "banner") {
    return (
      <Alert variant="destructive" className={cn("flex items-center gap-2.5 py-2 text-xs", className)}>
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 leading-relaxed">{title}</span>
        {retry ? <span className="shrink-0">{retry}</span> : null}
      </Alert>
    )
  }

  return (
    <div role="alert" className={cn("flex min-h-40 flex-col items-center justify-center gap-1.5 px-3 text-center", className)}>
      <span className="mb-1 grid size-10 place-items-center rounded-xl border border-st-bad/30 bg-st-bad-soft text-st-bad-ink">
        <TriangleAlert className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {retry ? <div className="mt-2">{retry}</div> : null}
    </div>
  )
}
