/** Product summary table; all row writes are supplied by the feature controller. */
import { useEffect, useState } from "react"
import { Archive, Copy, FileText, Ellipsis, SquareArrowOutUpRight, Trash2 } from "lucide-react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDb, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { categoryShortLabel, formatCnyCents } from "./supplier-prop-editors"
import { SupplierReadinessBadge, missingReadiness } from "./supplier-readiness"

/** 状态单元格：点击切上/下架；未就绪先列缺项再拦（本地缺项 + 服务端 400 清单）。 */
function StatusCell({
  row,
  pending,
  onToggle,
}: {
  row: SupplierDbRow
  pending: boolean
  onToggle: () => Promise<{ ok: boolean; missing: string[] }>
}) {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [missing, setMissing] = useState<string[]>(missingReadiness(row))

  useEffect(() => {
    setMissing(missingReadiness(row))
  }, [row])

  const click = async () => {
    if (pending) return
    if (!row.published && missing.length) {
      setOpen(true)
      return
    }
    const result = await onToggle()
    setInvalid(!result.ok)
    if (!result.ok && result.missing.length) {
      setMissing(result.missing)
      setOpen(true)
    }
  }

  return (
    <div className="flex max-w-64 flex-col items-start gap-1">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`状态 ${row.published ? "已上架" : "未上架"}`}
            aria-invalid={invalid || undefined}
            disabled={pending}

            onClick={(event) => {
              event.stopPropagation()
              void click()
            }}
          />
        }
      >
        <Badge variant={row.published ? "good" : "outline"}>
          {row.published ? "已上架" : "未上架"}
        </Badge>
        <SupplierReadinessBadge row={row} />
      </PopoverTrigger>
      <PopoverContent className="w-64" data-status-missing="">
        <p className="text-compact font-medium">还差以下项才能上架：</p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {missing.map((item) => (
            <li
              key={item}
              className="flex items-center gap-1.5 text-compact text-muted-foreground"
            >
              <span aria-hidden className="size-1 rounded-full bg-st-bad" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-meta text-faint-foreground">
          在行页面补齐后重试上架。
        </p>
      </PopoverContent>
    </Popover>
    {missing.length > 0 ? <p className="text-meta text-muted-foreground" data-readiness-summary="">缺 {missing.join("、")}</p> : null}
    </div>
  )
}

export function SupplierDbProductsTable({ db, pageRows, liveRows, categoryTree, pendingSet, openRowId, selectedIds, rowBusyId, showCreator = false, toggleSelectAll, toggleSelectRow, onOpen, toggleStatus, onToggleFromMenu, onDuplicate, onArchive, onDelete }: {
  db: SupplierDb
  pageRows: SupplierDbRow[]
  liveRows: SupplierDbRow[]
  categoryTree: CategoryTreeNodeView[]
  pendingSet: ReadonlySet<string>
  openRowId: string | null
  selectedIds: ReadonlySet<string>
  rowBusyId: string | null
  showCreator?: boolean
  toggleSelectAll: (checked: boolean) => void
  toggleSelectRow: (productId: string, checked: boolean) => void
  onOpen: (productId: string) => void
  toggleStatus: (row: SupplierDbRow) => Promise<{ ok: boolean; missing: string[] }>
  onToggleFromMenu: (row: SupplierDbRow) => Promise<void>
  onDuplicate: (row: SupplierDbRow) => Promise<void>
  onArchive: (productId: string) => void
  onDelete: (productId: string) => void
}) {
  const allPageSelected = pageRows.length > 0 && pageRows.every((row) => selectedIds.has(row.productId))
  const somePageSelected = pageRows.some((row) => selectedIds.has(row.productId))
  return (
        <Table
          containerClassName="min-h-0 flex-1 overflow-auto overscroll-contain"
          aria-label={`${db.name || "新数据库"} 商品表`}
          data-supplier-db-table=""
        >
          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
            <TableRow >
              <TableHead className="w-10">
                <Checkbox
                  aria-label="选择本页全部行"
                  checked={allPageSelected}
                  indeterminate={!allPageSelected && somePageSelected}
                  onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                />
              </TableHead>
              <TableHead>商品</TableHead>
              {showCreator ? <TableHead className="w-32">创建人</TableHead> : null}
              <TableHead className="w-48">状态</TableHead>
              <TableHead className="w-24 text-right">成本价</TableHead>
              <TableHead className="w-24 text-right">平台价</TableHead>
              <TableHead className="w-24">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row) => {
              const pending = pendingSet.has(row.productId)
              const rowOpen = openRowId === row.productId
              const rowSelected = selectedIds.has(row.productId)
              const categoryLabel = categoryShortLabel(
                row.descriptionCategoryId,
                row.typeId,
                categoryTree,
              )
              return (
                <TableRow
                  key={row.productId}
                  data-supplier-db-row={row.productId}
                  data-open={rowOpen || undefined}
                  data-selected={rowSelected || undefined}
                  aria-selected={rowSelected || undefined}
                  aria-busy={pending || undefined}
                  data-state={rowOpen || rowSelected ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => {
                    onOpen(row.productId)
                  }}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`选择 ${row.title || "未命名"}`}
                      checked={rowSelected}
                      onCheckedChange={(checked) =>
                        toggleSelectRow(row.productId, checked === true)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground">
                        {row.gallery[0] ? (
                          <img
                            src={row.gallery[0].url}
                            alt=""
                            width={40}
                            height={40}
                            loading="lazy"
                            decoding="async"
                            className="size-full object-cover"
                          />
                        ) : (
                          <FileText
                            aria-hidden
                            className="size-4 text-faint-foreground"
                          />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {row.title || "未命名"}
                        </span>
                        <span className="block truncate text-meta text-muted-foreground">{row.size.trim() || "规格未填写"}{categoryLabel ? ` · ${categoryLabel}` : ""}</span>
                        <span className="block truncate font-mono text-meta text-muted-foreground">
                          {row.platformCode || "—"}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  {showCreator ? <TableCell><span className="block max-w-32 truncate text-compact text-muted-foreground" title={row.creatorName?.trim() || row.createdBy || "历史归属未知"}>{row.creatorName?.trim() || row.createdBy || "历史归属未知"}</span></TableCell> : null}
                  <TableCell>
                    <StatusCell
                      row={row}
                      pending={pending}
                      onToggle={() => toggleStatus(row)}
                    />
                  </TableCell>
                  <TableCell className="text-right font-mono text-compact tabular-nums">
                    {formatCnyCents(row.costCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-compact tabular-nums">
                    {formatCnyCents(row.platformPriceCents)}
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" size="sm" data-supplier-db-open={row.productId} onClick={() => onOpen(row.productId)}>编辑</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`行操作 ${row.title || "未命名"}`}
                            className="cursor-pointer"
                          />
                        }
                      >
                        <Ellipsis aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          className="cursor-pointer"
                          data-row-menu="打开"
                          onClick={() => onOpen(row.productId)}
                        >
                          <SquareArrowOutUpRight aria-hidden />
                          编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          data-row-menu={row.published ? "下架" : "上架"}
                          disabled={pending}
                          onClick={() => void onToggleFromMenu(row)}
                        >
                          {row.published ? "下架" : "上架"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          data-row-menu="复制行"
                          disabled={rowBusyId === row.productId}
                          onClick={() => void onDuplicate(row)}
                        >
                          <Copy aria-hidden />
                          复制行
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          data-row-menu="归档"
                          onClick={() => onArchive(row.productId)}
                        >
                          <Archive aria-hidden />
                          归档
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="cursor-pointer"
                          data-row-menu="删除"
                          onClick={() => onDelete(row.productId)}
                        >
                          <Trash2 aria-hidden />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {pageRows.length === 0 ? (
              <TableRow >
                <TableCell
                  colSpan={showCreator ? 7 : 6}
                  className="h-32 text-center text-compact text-faint-foreground"
                >
                  {liveRows.length === 0
                    ? "库还没有商品——「＋ 新建商品」建行"
                    : "没有匹配的商品——换个关键词，或清除筛选"}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

  )
}
