/** Library identity, public visibility, settings and product presets. */
import { Factory, Settings2, ChevronDown, Pencil, SlidersHorizontal, KeyRound, Trash2, Plus } from "lucide-react"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsIndicator, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { supplierDbCountryLabel } from "./supplier-db-list"

export function SupplierDbHeader({ db, listed, listedBusy, setListed, onEditDb, onOpenAccounts, onOpenProps, onDeleteDb, showCreator }: {
  db: SupplierDb
  listed: boolean
  listedBusy: boolean
  setListed: (next: boolean) => Promise<void>
  onEditDb: () => void
  onOpenAccounts: () => void
  onOpenProps: () => void
  onDeleteDb: () => void
  showCreator: boolean
}) {
  return (
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-4">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted text-base"
        >
          {db.icon.trim() ? (
            db.icon
          ) : (
            <Factory className="size-4 text-muted-foreground" />
          )}
        </span>
        <h1 className="min-w-0 truncate text-base font-semibold">
          {db.name.trim() || "未命名库"}
        </h1>
        <Badge variant="outline">{supplierDbCountryLabel(db.country)}</Badge>
        {showCreator ? <span className="text-meta text-muted-foreground">库创建人：{db.creatorName?.trim() || db.createdBy || "历史归属未知"}</span> : null}
        <span className="inline-flex items-center gap-1.5">
          <label
            htmlFor="supplier-db-header-listed"
            className={cn(
              "cursor-pointer text-meta font-medium",
              listed ? "text-st-good-ink" : "text-muted-foreground",
            )}
          >
            公开
          </label>
          <Switch
            id="supplier-db-header-listed"
            className="cursor-pointer"
            checked={listed}
            disabled={listedBusy}
            title="关闭后整库商品对卖家隐藏"
            onCheckedChange={(checked) => {
              void setListed(checked === true)
            }}
          />
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                />
              }
            >
              <Settings2 aria-hidden />
              库设置
              <ChevronDown aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="cursor-pointer"
                data-db-menu="编辑库信息"
                onClick={onEditDb}
              >
                <Pencil aria-hidden />
                编辑库信息
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                data-db-menu="自定义属性"
                onClick={onOpenProps}
              >
                <SlidersHorizontal aria-hidden />
                自定义属性
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                data-db-menu="厂家账号"
                onClick={onOpenAccounts}
              >
                <KeyRound aria-hidden />
                厂家账号
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer"
                data-db-menu="删除库"
                onClick={onDeleteDb}
              >
                <Trash2 aria-hidden />
                删除库
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

  )
}

export function SupplierDbStats({ counts, activeStat, applyStat, creating, newPage }: {
  counts: { all: number; published: number; incomplete: number }
  activeStat: string | null
  applyStat: (stat: "all" | "published" | "incomplete") => void
  creating: boolean
  newPage: () => Promise<void>
}) {
  const statTabs = [
    { key: "all", label: "全部商品", count: counts.all },
    { key: "published", label: "已上架", count: counts.published },
    { key: "incomplete", label: "待完善", count: counts.incomplete, warn: true },
  ] as const
  return (
      <div className="mx-4 mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1.5 border-b border-border">
        <Tabs
          className="min-w-0 overflow-x-auto"
          value={activeStat ?? ""}
          onValueChange={(next) => {
            if (next) applyStat(next as "all" | "published" | "incomplete")
          }}
        >
          <TabsList variant="line" aria-label="商品统计">
            <TabsIndicator variant="line" />
            {statTabs.map((stat) => (
              <TabsTrigger
                key={stat.key}
                variant="line"
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
        <div className="flex items-center gap-1.5 pb-1.5">
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={creating}
            className="cursor-pointer"
            data-new-row=""
            onClick={() => void newPage()}
          >
            <Plus aria-hidden />
            新建商品
          </Button>
        </div>
      </div>
  )
}
