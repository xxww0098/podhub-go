import { Tabs, TabsList, TabsIndicator, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export function SupplierDbStats({ counts, activeStat, applyStat }: {
  counts: { all: number; published: number; incomplete: number }
  activeStat: string | null
  applyStat: (stat: "all" | "published" | "incomplete") => void
}) {
  const statTabs = [
    { key: "all", label: "全部", count: counts.all },
    { key: "published", label: "已发布", count: counts.published },
    { key: "incomplete", label: "待完善", count: counts.incomplete, warn: true },
  ] as const
  return (
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Tabs
          className="min-w-0 overflow-x-auto"
          value={activeStat ?? ""}
          onValueChange={(next) => {
            if (next) applyStat(next as "all" | "published" | "incomplete")
          }}
        >
          <TabsList variant="segment" aria-label="商品统计" className="w-auto">
            <TabsIndicator variant="segment" />
            {statTabs.map((stat) => (
              <TabsTrigger
                key={stat.key}
                variant="segment"
                value={stat.key}
                data-stat={stat.key}
              >
                <span className="whitespace-nowrap">{stat.label}</span>
                <strong
                  className={cn(
                    "font-mono text-xs font-semibold tabular-nums",
                    stat.key === "incomplete" && stat.count > 0 && "text-st-attest-ink",
                  )}
                >
                  {stat.count.toLocaleString()}
                </strong>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
  )
}
