import { cn } from "@/lib/utils"

type BreadcrumbProps = {
  moduleLabel: string
  trail?: {
    label: string
    onExit: () => void
  }
}

/**
 * Segment-track location chrome. Notion-style: bare text segments joined by a
 * hairline "/" divider, no rail or boxed current page. Ancestors stay ghost
 * buttons that exit on click; hover is the only fill. Tenant scope lives in
 * the sidebar switcher, not here.
 *
 * Trail mount/unmount keeps a reserved slot so the header does not reflow when
 * a record drill opens or closes.
 */
export function Breadcrumb({ moduleLabel, trail }: BreadcrumbProps) {
  return (
    <nav aria-label="面包屑" className="flex min-w-0 items-center">
      <ol className="flex min-w-0 items-center">
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
          <span className="px-1 text-sm text-faint-foreground">/</span>
          <span
            aria-current={trail ? "page" : undefined}
            className={segmentClass("max-w-[16rem]")}
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
