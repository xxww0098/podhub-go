import { cn } from "@/lib/utils"
import { ChevronRight } from "lucide-react"

type BreadcrumbProps = {
  moduleLabel: string
  groupLabel?: string
  alwaysVisible?: boolean
  trail?: {
    label: string
    onExit: () => void
  }
}

/** Show the path when a detail needs a way back; keep static page names off the canvas. */
export function Breadcrumb({ moduleLabel, groupLabel, alwaysVisible = false, trail }: BreadcrumbProps) {
  return (
    <nav aria-label="面包屑" className={cn("flex min-w-0 items-center", !trail && !alwaysVisible && "sr-only")}>
      <ol className="flex min-w-0 items-center">
        {groupLabel ? (
          <li className="shell-breadcrumb-group flex shrink-0 items-center text-muted-foreground">
            <span>{groupLabel}</span>
            <ChevronRight aria-hidden className="mx-2 size-4" />
          </li>
        ) : null}
        <li className="min-w-0">
          {trail ? (
            <button
              type="button"
              onClick={trail.onExit}
              className="flex max-w-[10rem] cursor-pointer items-center truncate rounded-md px-2 py-1 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {moduleLabel}
            </button>
          ) : (
            <span aria-current="page" className={segmentClass("max-w-[14rem]")}>
              {moduleLabel}
            </span>
          )}
        </li>
        <li
          className={cn(
            "flex min-w-0 items-center overflow-hidden transition-[max-width,opacity] duration-200 ease-settle",
            trail ? "max-w-[20rem] opacity-100" : "pointer-events-none max-w-0 opacity-0",
          )}
          aria-hidden={!trail}
        >
          <ChevronRight aria-hidden className="mx-2 size-4 shrink-0 text-faint-foreground" />
          <span
            aria-current={trail ? "page" : undefined}
            className={segmentClass("max-w-[16rem]")}
            title={trail?.label}
          >
            {trail?.label ?? "\u00a0"}
          </span>
        </li>
      </ol>
    </nav>
  )
}

function segmentClass(maxWidth: string) {
  return cn(
    "flex items-center truncate rounded-md px-2 py-1 text-sm font-semibold text-foreground",
    maxWidth,
  )
}
