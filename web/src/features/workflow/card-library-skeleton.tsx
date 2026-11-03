import { Skeleton } from "@/components/ui/skeleton"

/** The listing table's shape while the card list is still unknown. */
export function CardLibrarySkeleton() {
  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col gap-4"
      data-listing-library-skeleton=""
      aria-busy="true"
      aria-label="正在加载上架方案"
    >
      <div className="flex h-fit max-h-full min-h-0 w-full flex-col overflow-hidden rounded-md border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex flex-col gap-2 px-3 py-3">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}
