/** Product summary table; all row writes are supplied by the feature controller. */
import { Fragment, useEffect, useState } from "react"
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Ellipsis,
  Factory,
  FileText,
  PackageOpen,
  Pencil,
  Plus,
  SearchX,
  Trash2,
} from "lucide-react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDb, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { fixedTagsReady } from "@/lib/fixed-tags"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconButton } from "@/components/ui/icon-button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { categoryShortLabel, formatCnyCents } from "./supplier-prop-editors"
import { supplierProductGroups } from "./supplier-product-groups"
import { missingReadiness } from "./supplier-readiness"
import type { SupplierRowTab } from "./supplier-row-body"

const rowName = (row: SupplierDbRow) => row.title || row.size || row.platformCode || "未命名"

/** 草稿是默认态：轻量圆点即可；已发布 / 部分发布才用实色徽标抢注意力。 */
function DraftMark() {
  return (
    <span className="inline-flex items-center gap-1.5 text-compact text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-border-strong" />
      草稿
    </span>
  )
}

function PublishState({
  published,
  count = 1,
  publishedCount = 0,
}: {
  published: boolean
  count?: number
  publishedCount?: number
}) {
  if (count > 1) {
    if (publishedCount === count) return <Badge variant="good">已发布</Badge>
    if (publishedCount > 0) {
      return (
        <Badge variant="warning">
          {publishedCount}/{count} 已发布
        </Badge>
      )
    }
    return <DraftMark />
  }
  return published ? <Badge variant="good">已发布</Badge> : <DraftMark />
}

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={`状态 ${row.published ? "已发布" : "草稿"}`}
            aria-invalid={invalid || undefined}
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation()
              void click()
            }}
          />
        }
      >
        <PublishState published={row.published} />
      </PopoverTrigger>
      <PopoverContent className="w-64" data-status-missing="">
        <p className="text-compact font-medium">还差以下项才能发布到商品库：</p>
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
          在行页面补齐后重试发布。
        </p>
      </PopoverContent>
    </Popover>
  )
}

function MissingList({ missing }: { missing: string[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {missing.map((item) => (
        <li
          key={item}
          className="flex items-center gap-1.5 text-compact text-muted-foreground"
        >
          <span aria-hidden className="size-1 rounded-full bg-st-attest" />
          {item}
        </li>
      ))}
    </ul>
  )
}

/** 单规格：缺项直接可读；可上架时只留一个安静的对勾。 */
function VariantReadiness({
  row,
  onOpen,
}: {
  row: SupplierDbRow
  onOpen: () => void
}) {
  const missing = missingReadiness(row)
  const [open, setOpen] = useState(false)
  if (!missing.length) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-compact font-medium text-st-good-ink">
        <CheckCircle2 aria-hidden className="size-3.5" />
        可上架
      </span>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm text-compact font-medium text-st-attest-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`查看 ${rowName(row)} 的缺项`}
          />
        }
      >
        <CircleAlert aria-hidden className="size-3.5" />
        缺 {missing.length} 项
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-compact font-medium">上架前还差</p>
        <MissingList missing={missing} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={() => {
            setOpen(false)
            onOpen()
          }}
        >
          去完善
        </Button>
      </PopoverContent>
    </Popover>
  )
}

/** 商品级就绪：一行读完「能不能上」，缺项和 Ozon / AI 进度都在同一格。 */
function GroupReadiness({
  group,
  onOpen,
}: {
  group: ReturnType<typeof supplierProductGroups>[number]
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const count = group.rows.length
  const readyCount = group.rows.filter((row) => missingReadiness(row).length === 0).length
  const missing = [...new Set(group.rows.flatMap((row) => missingReadiness(row)))]
  const ozonCount = group.rows.filter((row) => row.readiness.ozonConfig).length
  const aiCount = group.rows.filter(
    (row) => row.readiness.prompt && fixedTagsReady(row.fixedTags),
  ).length
  const allReady = readyCount === count
  const primary = allReady
    ? count > 1
      ? "全部可上架"
      : "可上架"
    : count > 1
      ? `${readyCount}/${count} 可上架`
      : `缺 ${missing.length} 项`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="group/readiness flex cursor-pointer flex-col items-start gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${rowName(group.row)} 的上架就绪情况`}
          />
        }
      >
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap text-compact font-medium ${
            allReady ? "text-st-good-ink" : "text-st-attest-ink"
          }`}
        >
          {allReady ? (
            <CheckCircle2 aria-hidden className="size-3.5" />
          ) : (
            <CircleAlert aria-hidden className="size-3.5" />
          )}
          {primary}
        </span>
        <span className="whitespace-nowrap font-mono text-meta tabular-nums text-faint-foreground">
          Ozon {ozonCount}/{count} · AI {aiCount}/{count}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-compact font-medium">
          {count === 1
            ? allReady
              ? "当前规格可上架"
              : "当前规格还不能上架"
            : allReady
              ? "全部规格可上架"
              : `${count} 个规格中 ${readyCount} 个可上架`}
        </p>
        {missing.length ? (
          <>
            <p className="mt-2 text-meta text-muted-foreground">还差</p>
            <MissingList missing={missing} />
          </>
        ) : null}
        {count > 1 ? (
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-meta text-muted-foreground">
            <span>Ozon 配置 {ozonCount}/{count}</span>
            <span>AI 识图 {aiCount}/{count}</span>
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={() => {
            setOpen(false)
            onOpen()
          }}
        >
          {allReady ? "打开商品" : "去完善"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function PublishSummary({
  group,
  canPublish,
  onExpand,
}: {
  group: ReturnType<typeof supplierProductGroups>[number]
  canPublish: boolean
  onExpand: () => void
}) {
  const count = group.rows.length
  const published = group.rows.filter((row) => row.published).length
  if (count === 1) {
    return <PublishState published={group.row.published} />
  }
  return (
    <button
      type="button"
      className="cursor-pointer rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      title={canPublish ? "展开规格后可逐个发布" : "由超级管理员发布"}
      onClick={onExpand}
    >
      <PublishState
        published={published > 0}
        count={count}
        publishedCount={published}
      />
    </button>
  )
}

function Prices({ rows }: { rows: SupplierDbRow[] }) {
  const prices = [...new Set(rows.map((row) => row.platformPriceCents))]
  if (prices.length === 1) {
    const value = prices[0]
    return value == null ? (
      <span className="text-compact text-faint-foreground">未定价</span>
    ) : (
      <span className="font-mono tabular-nums">{formatCnyCents(value)}</span>
    )
  }
  return (
    <span
      className="text-compact text-muted-foreground"
      title={rows
        .map((row) => `${row.size || row.platformCode} ${formatCnyCents(row.platformPriceCents)}`)
        .join(" · ")}
    >
      按规格
    </span>
  )
}

export function SupplierDbProductsTable({
  dbs,
  pageRows,
  liveRows,
  categoryTree,
  pendingSet,
  selectedIds,
  showCreator,
  canPublish = false,
  toggleSelectAll,
  toggleSelectRow,
  onOpen,
  onOpenProduct,
  onAddVariant,
  toggleStatus,
  onToggleFromMenu,
  onArchive,
  onDelete,
  onCreateProduct,
  onClearFilters,
  onManageFactories,
}: {
  dbs: SupplierDb[]
  pageRows: SupplierDbRow[]
  liveRows: SupplierDbRow[]
  categoryTree: CategoryTreeNodeView[]
  pendingSet: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  showCreator?: boolean
  canPublish?: boolean
  toggleSelectAll: (checked: boolean) => void
  toggleSelectRow: (productId: string, checked: boolean) => void
  onOpen: (productId: string, tab?: SupplierRowTab) => void
  onOpenProduct: (productId: string, tab?: "defaults") => void
  onAddVariant: (row: SupplierDbRow) => void
  toggleStatus: (row: SupplierDbRow) => Promise<{ ok: boolean; missing: string[] }>
  onToggleFromMenu: (row: SupplierDbRow) => Promise<void>
  onArchive: (productId: string) => void
  onDelete: (productId: string) => void
  onCreateProduct: () => void
  onClearFilters: () => void
  onManageFactories: () => void
}) {
  const groups = supplierProductGroups(pageRows)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const allPageSelected =
    pageRows.length > 0 && pageRows.every((row) => selectedIds.has(row.productId))
  const toggleGroup = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const empty = !groups.length
  const emptyState = !dbs.length
    ? {
        icon: Factory,
        title: "还没有绑定工厂",
        description: "请先绑定已有工厂，再创建商品。",
        action: (
          <Button type="button" variant="brand" size="sm" onClick={onManageFactories}>
            <Factory aria-hidden />
            绑定工厂
          </Button>
        ),
      }
    : liveRows.length
      ? {
          icon: SearchX,
          title: "没有匹配的商品",
          description: "当前搜索或筛选条件下没有结果。",
          action: (
            <Button type="button" variant="outline" size="sm" onClick={onClearFilters}>
              清除筛选
            </Button>
          ),
        }
      : {
          icon: PackageOpen,
          title: "还没有商品",
          description: "从商品库创建一个规格，再补齐资料、定价并发布。",
          action: (
            <Button type="button" variant="brand" size="sm" onClick={onCreateProduct}>
              <Plus aria-hidden />
              新增商品
            </Button>
          ),
        }

  return (
    <Table
      containerClassName="min-h-0 flex-1 overflow-auto overscroll-contain"
      aria-label="平台商品管理表"
      data-supplier-db-table=""
    >
      <TableHeader>
        <TableRow>
          <TableHead>
            <Checkbox
              aria-label="选择本页全部规格"
              checked={allPageSelected}
              indeterminate={
                !allPageSelected && pageRows.some((row) => selectedIds.has(row.productId))
              }
              onCheckedChange={(checked) => toggleSelectAll(checked === true)}
            />
          </TableHead>
          <TableHead>商品</TableHead>
          <TableHead>商品库</TableHead>
          <TableHead>规格</TableHead>
          <TableHead>上架就绪</TableHead>
          <TableHead className="text-right">平台供货价</TableHead>
          <TableHead>发布状态</TableHead>
          <TableHead>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const row = group.row
          const factory = dbs.find((db) => db.sourceId === row.sourceId)
          const open = expanded.has(group.key)
          const multi = group.rows.length > 1
          return (
            <Fragment key={group.key}>
              <TableRow data-supplier-product={row.productId} data-factory-id={row.sourceId}>
                <TableCell>
                  <Checkbox
                    aria-label={`选择 ${row.title || "未命名"}`}
                    checked={group.rows.every((item) => selectedIds.has(item.productId))}
                    indeterminate={
                      group.rows.some((item) => selectedIds.has(item.productId)) &&
                      !group.rows.every((item) => selectedIds.has(item.productId))
                    }
                    onCheckedChange={(checked) =>
                      group.rows.forEach((item) =>
                        toggleSelectRow(item.productId, checked === true),
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="supplier-product-thumbnail grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted">
                      {row.gallery[0] ? (
                        <img
                          src={row.gallery[0].url}
                          alt=""
                          width={40}
                          height={40}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : (
                        <FileText aria-hidden className="size-4 text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <button
                        type="button"
                        className="block max-w-full cursor-pointer truncate text-left text-lg font-semibold leading-snug hover:text-brand"
                        title={row.title || "未命名"}
                        data-supplier-db-open={row.productId}
                        onClick={() => onOpenProduct(row.productId)}
                      >
                        {row.title || "未命名"}
                      </button>
                      <span className="block truncate text-meta text-muted-foreground">
                        {categoryShortLabel(
                          row.descriptionCategoryId,
                          row.typeId,
                          categoryTree,
                        ) || "未设置类目"}
                        <span aria-hidden className="mx-1.5 text-border">/</span>
                        <span className="font-mono">{row.platformCode}</span>
                      </span>
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="block truncate" title={factory?.name}>
                    {factory?.name || "商品库未知"}
                  </span>
                  {showCreator ? (
                    <span className="block truncate text-meta text-faint-foreground">
                      {factory?.creatorName || factory?.createdBy || "历史归属未知"}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {multi ? (
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-sm text-compact font-medium hover:text-brand outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={open ? "收起规格" : "展开规格"}
                      aria-expanded={open}
                      onClick={() => toggleGroup(group.key)}
                    >
                      {group.rows.length} 个规格
                      <ChevronDown
                        aria-hidden
                        className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                      />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`max-w-full cursor-pointer truncate text-left text-compact hover:text-brand ${row.size.trim() ? "" : "text-muted-foreground"}`}
                      title={row.size || undefined}
                      aria-label={`编辑规格 ${row.size || row.platformCode}`}
                      onClick={() => onOpen(row.productId)}
                    >
                      {row.size.trim() || "单规格"}
                    </button>
                  )}
                </TableCell>
                <TableCell>
                  <GroupReadiness
                    group={group}
                    onOpen={() => onOpenProduct(row.productId, "defaults")}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Prices rows={group.rows} />
                </TableCell>
                <TableCell>
                  {multi ? (
                    <PublishSummary
                      group={group}
                      canPublish={canPublish}
                      onExpand={() => {
                        if (!open) toggleGroup(group.key)
                      }}
                    />
                  ) : canPublish ? (
                    <StatusCell
                      row={row}
                      pending={pendingSet.has(row.productId)}
                      onToggle={() => toggleStatus(row)}
                    />
                  ) : (
                    <PublishState published={row.published} />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5">
                    <IconButton
                      icon={Plus}
                      label="新增规格"
                      tip="新增规格"
                      size="icon-sm"
                      onClick={() => onAddVariant(row)}
                    />
                    <IconButton
                      icon={Pencil}
                      label={`编辑商品 ${row.title || "未命名"}`}
                      tip="编辑商品"
                      size="icon-sm"
                      onClick={() => onOpenProduct(row.productId)}
                    />
                  </div>
                </TableCell>
              </TableRow>
              {open
                ? group.rows.map((variant) => (
                    <TableRow
                      key={variant.productId}
                      data-supplier-db-row={variant.productId}
                      data-supplier-variant=""
                      aria-busy={
                        pendingSet.has(variant.productId) || undefined
                      }
                    >
                      <TableCell>
                        <Checkbox
                          aria-label={`选择规格 ${variant.size || variant.platformCode}`}
                          checked={selectedIds.has(variant.productId)}
                          onCheckedChange={(checked) =>
                            toggleSelectRow(variant.productId, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <span className="supplier-variant-code inline-flex items-center gap-2 font-mono text-meta text-muted-foreground">
                          <span aria-hidden className="supplier-variant-branch" />
                          {variant.platformCode}
                        </span>
                      </TableCell>
                      <TableCell />
                      <TableCell>
                        <button
                          type="button"
                          className="max-w-full cursor-pointer truncate text-left font-medium hover:text-brand"
                          title={variant.size || undefined}
                          aria-label={`编辑规格 ${variant.size || variant.platformCode}`}
                          onClick={() => onOpen(variant.productId)}
                        >
                          {variant.size.trim() || "规格未填写"}
                        </button>
                      </TableCell>
                      <TableCell>
                        <VariantReadiness
                          row={variant}
                          onOpen={() => onOpen(variant.productId)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {variant.platformPriceCents == null ? (
                          <span className="text-compact text-faint-foreground">未定价</span>
                        ) : (
                          <span className="font-mono tabular-nums">
                            {formatCnyCents(variant.platformPriceCents)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {canPublish ? (
                          <StatusCell
                            row={variant}
                            pending={pendingSet.has(variant.productId)}
                            onToggle={() => toggleStatus(variant)}
                          />
                        ) : (
                          <PublishState published={variant.published} />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            icon={Pencil}
                            label={
                              missingReadiness(variant).length ? "继续完善" : "编辑规格"
                            }
                            size="icon-sm"
                            data-supplier-db-open={variant.productId}
                            onClick={() => onOpen(variant.productId)}
                          />
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`规格操作 ${variant.size || variant.platformCode}`}
                                />
                              }
                            >
                              <Ellipsis aria-hidden />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {canPublish ? (
                                <DropdownMenuItem
                                  disabled={pendingSet.has(variant.productId)}
                                  onClick={() => void onToggleFromMenu(variant)}
                                >
                                  {variant.published ? "停用" : "发布到商品库"}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                disabled={variant.published && !canPublish}
                                onClick={() => onArchive(variant.productId)}
                              >
                                <Archive aria-hidden />
                                归档规格
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={variant.published && !canPublish}
                                onClick={() => onDelete(variant.productId)}
                              >
                                <Trash2 aria-hidden />
                                删除规格
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </Fragment>
          )
        })}
        {empty ? (
          <TableRow>
            <TableCell colSpan={8} className="h-64">
              <div className="flex flex-col items-center justify-center gap-2 text-center">
                <span className="mb-1 grid size-10 place-items-center rounded-full border border-border bg-muted/60">
                  <emptyState.icon aria-hidden className="size-4 text-muted-foreground" />
                </span>
                <p className="text-compact font-medium">{emptyState.title}</p>
                <p className="max-w-80 text-meta text-muted-foreground">
                  {emptyState.description}
                </p>
                <div className="mt-1">{emptyState.action}</div>
              </div>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}
