import { Button } from "@/components/ui/button"
import type { ReconcileFilter } from "./reconcile-filter"

export function ReconcileFilterBar({
  value,
  counts,
  onChange,
}: {
  value: ReconcileFilter
  counts: { checking: number; needsManual: number }
  onChange: (next: ReconcileFilter) => void
}) {
  if (value === "all" && counts.checking === 0 && counts.needsManual === 0) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-1" role="group" aria-label="核对状态筛选">
      <Button type="button" size="sm" variant={value === "all" ? "secondary" : "outline"} onClick={() => onChange("all")}>全部</Button>
      <Button type="button" size="sm" variant={value === "checking" ? "secondary" : "outline"} onClick={() => onChange("checking")}>核对中 {counts.checking}</Button>
      <Button type="button" size="sm" variant={value === "needs_manual" ? "secondary" : "outline"} onClick={() => onChange("needs_manual")}>需人工核对 {counts.needsManual}</Button>
    </div>
  )
}
