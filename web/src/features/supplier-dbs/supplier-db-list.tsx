/**
 * 平台货源 — master-detail 布局的左栏「库列表」：一库一张卡片
 * （图标 + 名 + 商品数 + 国家 + 公开态），点卡片换右栏的库页；
 * 栏底常驻「新建平台货源」入口。公开开关在库页头部直接改；其余库级操作
 * （改名/委托/删除）收在右栏「库设置」里，侧栏不放行级操作钮；双击卡片打开
 * 与「编辑库信息」同一张改库对话框。
 * 建/改库对话框见 ./supplier-db-form-dialog。
 */
import { useRef, useState } from "react"
import { Factory, Plus, Search } from "lucide-react"

import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"

/** A country is `''` or ISO-3166-1 alpha-2; the select covers the common ones. */
export const COUNTRY_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "CN", label: "中国" },
  { code: "US", label: "美国" },
  { code: "CA", label: "加拿大" },
  { code: "MX", label: "墨西哥" },
  { code: "BR", label: "巴西" },
  { code: "IT", label: "意大利" },
  { code: "GB", label: "英国" },
]

export function supplierDbCountryLabel(code: string): string {
  if (!code) return "—"
  return COUNTRY_OPTIONS.find((option) => option.code === code)?.label ?? code
}

/**
 * 库侧栏 — 常驻左栏。搜索按库名或国家过滤（`/` 聚焦）；当前库卡片描边高亮。
 * 单击换右栏库页；双击打开屏级改库对话框（与库页「编辑库信息」同一条路径）。
 */
export function SupplierDbRail({
  dbs,
  selectedId,
  onSelect,
  onEdit,
  onCreate,
  showCreator = false,
}: {
  dbs: SupplierDb[]
  selectedId: string | null
  onSelect: (sourceId: string) => void
  /** 双击卡片 — 打开该库的改库对话框，不另放行级按钮。 */
  onEdit: (sourceId: string) => void
  onCreate: () => void
  showCreator?: boolean
}) {
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = query.trim().toLowerCase()
  const visibleDbs = needle
    ? dbs.filter(
        (db) =>
          db.name.trim().toLowerCase().includes(needle) ||
          supplierDbCountryLabel(db.country).toLowerCase().includes(needle),
      )
    : dbs

  return (
    <aside
      data-supplier-dbs="list"
      aria-label="平台货源"
      className="flex w-full shrink-0 flex-col border-b border-border bg-sidebar sm:w-52 sm:border-r sm:border-b-0"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        const typing =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable
        if (event.key === "/" && !typing) {
          event.preventDefault()
          searchRef.current?.focus()
        }
      }}
    >
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2 sm:flex-col sm:items-stretch">
        <h2 className="shrink-0 text-compact font-medium">平台货源</h2>
        <InputGroup>
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput ref={searchRef} type="search" aria-label="搜索平台货源" placeholder="搜索库名或国家…" title="搜索库名或国家（/ 聚焦）" value={query} onChange={(event) => setQuery(event.target.value)} />
        </InputGroup>
      </div>
      <ul className="flex min-h-0 flex-1 gap-1 overflow-auto overscroll-contain px-3 pb-3 sm:flex-col">
        {visibleDbs.map((db) => {
          const name = db.name.trim() || "未命名库"
          const active = db.sourceId === selectedId
          return (
            <li key={db.sourceId} className="w-44 shrink-0 sm:w-full">
              <Button
                type="button" variant={active ? "outline" : "ghost"} size="lg"
                data-supplier-db-row={db.sourceId} aria-current={active || undefined}
                aria-label={`打开 ${name}`} title="双击编辑库信息"
                className="w-full justify-start text-left"
                onClick={() => onSelect(db.sourceId)} onDoubleClick={() => onEdit(db.sourceId)}
              >
                <span aria-hidden className="shrink-0 text-base">{db.icon.trim() || <Factory className="size-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-compact font-medium">{name}</span>
                    <span className="font-mono text-meta tabular-nums">{db.rowCount}</span>
                  </span>
                  <span className="flex items-center gap-1 text-meta text-muted-foreground">
                    <span className="truncate">{supplierDbCountryLabel(db.country)} · {db.listed ? "公开" : "未公开"}{showCreator ? ` · ${db.creatorName?.trim() || db.createdBy || "历史归属未知"}` : ""}</span>
                  </span>
                </span>
              </Button>
            </li>
          )
        })}
        {visibleDbs.length === 0 ? (
          <li className="py-6 text-center text-compact text-faint-foreground">
            {dbs.length === 0 ? "还没有平台货源" : "没有匹配的库——换个关键词"}
          </li>
        ) : null}
      </ul>
      <div className="border-t border-border p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full cursor-pointer"
          onClick={onCreate}
        >
          <Plus aria-hidden />
          新建平台货源
        </Button>
      </div>
    </aside>
  )
}

/** 右栏空态 — 一个库都没有时的建库入口（对话框在屏级）。 */
export function SupplierDbEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty data-supplier-dbs-empty="list" className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Factory />
        </EmptyMedia>
        <EmptyTitle>还没有平台货源</EmptyTitle>
        <EmptyDescription>
          一个库 = 一个厂家。新建后在右栏添商品行。
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          size="sm"
          variant="default"
          className="cursor-pointer"
          onClick={onCreate}
        >
          <Plus aria-hidden />
          新建平台货源
        </Button>
      </EmptyContent>
    </Empty>
  )
}
