/**
 * 属性类型 → 图标 — Notion 列头的小前缀：Aa 文本 / ＃ 数字 / ▾ 单选 /
 * ◉ 多选 / ☑ 勾选 / 📎 文件。One map so the table header, the row sheet and
 * the (V4) column menu never disagree on a glyph.
 */
import {
  AlignLeft,
  CheckSquare,
  ChevronDown,
  Hash,
  ListChecks,
  Type,
  type LucideIcon,
} from "lucide-react"

import type { SupplierDbPropType } from "@/bindings/http-supplier-dbs"
import { cn } from "@/lib/utils"

export const SUPPLIER_PROP_ICONS: Record<SupplierDbPropType, LucideIcon> = {
  text: Type,
  long_text: AlignLeft,
  number: Hash,
  select: ChevronDown,
  multi_select: ListChecks,
  checkbox: CheckSquare,
}

export const SUPPLIER_PROP_TYPE_LABELS: Record<SupplierDbPropType, string> = {
  text: "文本",
  long_text: "多行文本",
  number: "数字",
  select: "单选",
  multi_select: "多选",
  checkbox: "勾选",
}

export function SupplierPropIcon({
  type,
  className,
}: {
  type: SupplierDbPropType
  className?: string
}) {
  const Icon = SUPPLIER_PROP_ICONS[type] ?? Type
  return <Icon aria-hidden className={cn("size-3.5", className)} />
}
