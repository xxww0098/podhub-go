/** Creator scope organizes the already authorized library list returned by Cloud. */
import { LockKeyhole, ShieldCheck } from "lucide-react"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function supplierDbCreatorOptions(dbs: SupplierDb[]) {
  const creators = new Map<string, string>()
  for (const db of dbs) {
    const id = db.createdBy?.trim()
    if (id) creators.set(id, db.creatorName?.trim() || creators.get(id) || id)
  }
  const nameCounts = new Map<string, number>()
  for (const name of creators.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  return [
    { value: "all", label: "全部管理员" },
    ...[...creators].sort((a, b) => a[1].localeCompare(b[1], "zh")).map(([value, label]) => ({ value, label: `${label}${(nameCounts.get(label) ?? 0) > 1 ? ` · ${value.slice(0, 8)}` : ""}创建` })),
    ...(dbs.some((db) => !db.createdBy?.trim()) ? [{ value: "unknown", label: "历史归属未知" }] : []),
  ]
}

export function supplierDbsInScope(dbs: SupplierDb[], scope: string): SupplierDb[] {
  if (scope === "all") return dbs
  return dbs.filter((db) => scope === "unknown" ? !db.createdBy?.trim() : db.createdBy === scope)
}

export function SupplierDbScope({ superAdmin, dbs, value, onChange }: {
  superAdmin: boolean
  dbs: SupplierDb[]
  value: string
  onChange: (scope: string) => void
}) {
  const options = supplierDbCreatorOptions(dbs)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2" data-supplier-db-scope="">
      {superAdmin ? <>
        <ShieldCheck aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-meta text-muted-foreground">库创建人</span>
        <Select items={options} value={value} onValueChange={(next) => next && onChange(next)}>
          <SelectTrigger size="sm" aria-label="按库创建人筛选"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </> : <>
        <LockKeyhole aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-compact font-medium">仅我创建</span>
      </>}
      <span className="text-meta text-muted-foreground">{supplierDbsInScope(dbs, superAdmin ? value : "all").length} 个库</span>
    </div>
  )
}
