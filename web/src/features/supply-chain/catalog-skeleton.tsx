import { Skeleton } from "@/components/ui/skeleton"

/** Card grid shown until the supplier catalog payload arrives. */
export function CatalogSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-catalog-skeleton=""
      aria-busy="true"
      aria-label="正在加载货盘"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="overflow-hidden rounded-xl border border-border bg-card">
            <Skeleton className="aspect-square w-full" />
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
