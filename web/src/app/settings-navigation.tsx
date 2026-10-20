import { Search } from "lucide-react"
import { IdentityMark } from "@/components/identity-mark"
import { SETTINGS_SECTION_ICONS } from "@/components/settings-section-icons"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AccountOverview } from "@/bindings/commands"
import type { SettingsSection, SettingsSectionRow } from "@/lib/settings-sections"
import { cn } from "@/lib/utils"

export function SettingsNavigation({ rows, pane, query, onQuery, onSelect, overview }: {
  rows: readonly SettingsSectionRow[]
  pane: SettingsSection | ""
  query: string
  onQuery: (value: string) => void
  onSelect: (value: SettingsSection) => void
  overview?: AccountOverview
}) {
  const needle = query.trim().toLocaleLowerCase()
  const groups = new Map<string, SettingsSectionRow[]>()
  for (const row of rows) {
    if (needle && ![row.label, row.title, row.description ?? "", row.group].some((value) => value.toLocaleLowerCase().includes(needle))) continue
    const group = groups.get(row.group) ?? []
    group.push(row)
    groups.set(row.group, group)
  }
  return <aside className="flex min-h-0 min-w-0 flex-col border-b border-border bg-sidebar md:w-56 md:shrink-0 md:border-r md:border-b-0">
    <div className="flex items-center gap-3 px-4 py-3 pr-14 md:hidden">
      <span className="shrink-0 text-compact font-semibold">设置</span>
      <Select items={rows.map((row) => ({ value: row.id, label: row.label }))} value={pane || null}
        onValueChange={(value) => { if (value && rows.some((row) => row.id === value)) onSelect(value as SettingsSection) }}>
        <SelectTrigger aria-label="设置分区"><SelectValue placeholder="选择分区" /></SelectTrigger>
        <SelectContent>{Array.from(new Set(rows.map((row) => row.group))).map((group) => <SelectGroup key={group}>
          <SelectLabel>{group}</SelectLabel>
          {rows.filter((row) => row.group === group).map((row) => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}
        </SelectGroup>)}</SelectContent>
      </Select>
    </div>
    <div className="hidden flex-col gap-4 px-4 pt-5 pb-3 md:flex">
      <span className="text-md font-semibold">设置</span>
      <div className="relative">
        <Input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
      </div>
    </div>
    <nav aria-label="设置分区" className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:block">
      {[...groups.entries()].map(([group, items]) => <div key={group} className="pt-4 first:pt-1">
        <p className="px-2 pb-2 text-meta text-muted-foreground">{group}</p>
        <div className="flex flex-col gap-1">{items.map((item) => {
          const Icon = SETTINGS_SECTION_ICONS[item.id]
          return <button key={item.id} type="button" aria-current={pane === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}
            className={cn("flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-compact text-secondary-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", pane === item.id && "bg-card font-medium text-foreground shadow-raise")}>
            {item.account ? <IdentityMark kind="user" role={overview?.session.role} name={overview?.session.name ?? overview?.session.email ?? ""} imageUrl={overview?.session.avatar_url} className="size-4 shrink-0" /> : <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", pane === item.id && "text-brand")} />}
            <span className="truncate">{item.label}</span>
          </button>
        })}</div>
      </div>)}
      {groups.size === 0 ? <div className="flex flex-col items-center gap-2 py-8 text-center text-compact text-muted-foreground"><Search aria-hidden className="size-5" /><p>没有匹配的设置</p></div> : null}
    </nav>
  </aside>
}
