/**
 * 行编辑器页头 — 身份行（封面缩略 + 名称/编号/类目）+ 规格切换条 + 就绪导航。
 * 规格切换是整份编辑器的主体切换（换行），就绪缺项芯片点了跳对应页签。
 * 从 supplier-row-panel 拆出：面板管 chrome 与页签状态，页头自持「新增规格」表单态。
 */
import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"


/** 缺项芯片（key + 标签）：键序由面板的 READINESS_TAB 维持，与 READINESS_LABELS 一致。 */
export interface ReadinessChip {
  key: string
  label: string
}

export function SupplierRowHeader({
  row,
  rows = [],
  onSelectRow,
  onCreateVariant,
  onDeleteVariant,
  onTogglePublish,
  missing,
  onJumpMissing,
}: {
  row: SupplierDbRow
  rows?: readonly SupplierDbRow[]
  onSelectRow?: (productId: string) => void
  onCreateVariant?: (size: string) => Promise<boolean>
  /** 删除当前规格 tab — 只剩一个规格时不出现（单规格删除归 ⋯ 菜单）。 */
  onDeleteVariant?: () => void
  onTogglePublish: () => void | Promise<void>
  missing: readonly ReadinessChip[]
  onJumpMissing: (key: string) => void
}) {
  const [newSize, setNewSize] = useState("")
  const [addingVariant, setAddingVariant] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const variants = row.variantGroup?.trim()
    ? rows.filter(
        (item) =>
          !item.archived &&
          item.sourceId === row.sourceId &&
          item.variantGroup === row.variantGroup,
      )
    : [row]

  const addVariant = async () => {
    const size = newSize.trim()
    if (!size || !onCreateVariant || addingVariant) return
    if (!row.size.trim()) {
      notifyError("请先填写当前规格")
      return
    }
    if (variants.some((item) => item.size.trim() === size)) {
      notifyError("该商品下已存在这个规格")
      return
    }
    setAddingVariant(true)
    try {
      if (await onCreateVariant(size)) {
        setNewSize("")
        setAddOpen(false)
      }
    } finally {
      setAddingVariant(false)
    }
  }

  return (
    <>
      {/* 身份行：封面缩略 + 名称/编号/类目。 */}
      <div className="flex shrink-0 items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-base leading-snug font-semibold"
            title={row.title.trim() || "未命名"}
          >
            {row.title.trim() || "未命名"}
          </h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
            <span className="font-mono">{row.platformCode || "—"}</span>
            <span className="truncate">{row.size.trim() || "规格未填写"}</span>
          </p>
        </div>
        {onCreateVariant && variants.length === 1 ? <Button type="button" variant="ghost" size="icon-sm" aria-label="新增规格" aria-expanded={addOpen} onClick={() => setAddOpen((open) => !open)}><Plus aria-hidden /></Button> : null}
        <Badge variant={row.published ? "good" : "outline"}>
          {row.published ? "已上架" : "未上架"}
        </Badge>
        <span className="inline-flex items-center gap-1.5">
          <Switch
            id="supplier-row-publish"
            className="cursor-pointer"
            checked={row.published}
            aria-label={row.published ? "下架当前规格" : "上架当前规格"}
            onCheckedChange={() => void onTogglePublish()}
          />
        </span>
      </div>

      {/* 规格切换：整份编辑器的主体切换（换行），不再藏在某个分区里。 */}
      {variants.length > 1 ? <div className="flex shrink-0 items-center gap-1.5 px-5 pb-2">
        {variants.length > 1 ? <Tabs
          value={row.productId}
          onValueChange={(value) => onSelectRow?.(String(value))}
          className="min-w-0 gap-0"
        >
          <TabsList
            variant="line"
            aria-label="同款规格"
            className="gap-3 overflow-x-auto"
          >
            <TabsIndicator variant="line" />
            {variants.map((variant) => {
              // 圆点只表启停：开启（published）绿、关闭灰——提示词有无另有就绪徽标与
              // 「缺：提示词」承担。状态文案挂在无障碍名上。
              const stateLabel = `${variant.published ? "已启用" : "已停用"}${
                variant.readiness.prompt === true
                  ? " · 提示词已配置"
                  : " · 提示词待配置"
              }`
              return (
                <TabsTrigger
                  key={variant.productId}
                  variant="line"
                  value={variant.productId}
                  title={variant.published ? undefined : "已停用"}
                  className={cn(
                    "h-8 shrink-0 cursor-pointer gap-1.5 px-0.5",
                    !variant.published && "text-faint-foreground",
                  )}
                >
                  <span className="max-w-40 truncate">
                    {variant.size.trim() || "未填写"}
                  </span>
                  <span
                    role="img"
                    aria-label={stateLabel}
                    title={stateLabel}
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      variant.published
                        ? "bg-st-good"
                        : "bg-faint-foreground/50",
                    )}
                  />
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs> : null}
        {onCreateVariant ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="新增规格"
            aria-expanded={addOpen}
            className="shrink-0 cursor-pointer text-faint-foreground"
            onClick={() => setAddOpen((open) => !open)}
          >
            <Plus aria-hidden />新增规格
          </Button>
        ) : null}
        {/* 单规格行不挂删除：删它就是删行，归 ⋯ 菜单管。 */}
        {onDeleteVariant && variants.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`删除规格「${row.size.trim() || "未填写"}」`}
            title={`删除规格「${row.size.trim() || "未填写"}」`}
            className="shrink-0 cursor-pointer text-faint-foreground hover:text-destructive"
            onClick={onDeleteVariant}
          >
            <Trash2 aria-hidden />
          </Button>
        ) : null}
      </div> : null}
      {addOpen && onCreateVariant ? (
        <form
          className="flex items-center gap-2 px-5 pt-2"
          onSubmit={(event) => {
            event.preventDefault()
            void addVariant()
          }}
        >
          <Input
            aria-label="新规格"
            placeholder="新规格，如 50×70cm"
            value={newSize}
            onChange={(event) => setNewSize(event.target.value)}
            disabled={addingVariant}
            autoFocus
            className="h-8 max-w-80"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!newSize.trim() || addingVariant}
          >
            {addingVariant ? <Spinner /> : <Plus aria-hidden />}新增规格
          </Button>
        </form>
      ) : null}

      {/* 就绪导航：上架开关 + 缺项芯片（点了跳对应页签）。 */}
      {missing.length ? <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 pb-3">
        {missing.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-label={`去补${chip.label}`}
              className="cursor-pointer rounded-full border border-border px-2 py-0.5 text-meta text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              data-missing={chip.key}
              onClick={() => onJumpMissing(chip.key)}
            >
              缺 {chip.label}
            </button>
          ))}
      </div> : null}
    </>
  )
}
