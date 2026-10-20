import { Skeleton } from "@/components/ui/skeleton"

/** 首屏骨架：问候行 + 4 张 KPI 卡 + 主区双列，与真实版式同栅格。 */
export function ConsoleSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" aria-busy="true" aria-label="正在加载概览">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-34" />
        <Skeleton className="h-34" />
        <Skeleton className="h-34" />
        <Skeleton className="h-34" />
      </div>
      <div className="grid flex-1 gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(20rem,5fr)]">
        <Skeleton className="min-h-78" />
        <Skeleton className="min-h-78" />
      </div>
    </div>
  )
}
