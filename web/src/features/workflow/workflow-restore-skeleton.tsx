import { Skeleton } from "@/components/ui/skeleton"

/** Shown while a card id in the address is being opened. */
export function WorkflowRestoreSkeleton() {
  return (
    <div
      className="flex min-h-52 flex-col gap-3 p-4"
      data-listing-restore-skeleton=""
      aria-busy="true"
      aria-label="正在恢复上架方案"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}
