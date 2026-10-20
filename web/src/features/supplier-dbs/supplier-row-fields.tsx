/**
 * 行编辑器三个页签共用的字段原语——「图标 + 名 + 值」属性行、分区标题、
 * 重量（数值 + 单位）控件与自定义属性字段。从原单滚轮面板拆出，
 * 编辑语义不变：失焦/回车提交，Esc 还原，全部经 store 带 CAS。
 */
import { useState } from "react"
import { Lock } from "lucide-react"

import type {
  SupplierDbPropDef,
  SupplierDbPropOption,
  SupplierDbRow,
  UpsertSupplierDbPropRequest,
  UpsertSupplierDbRowRequest,
} from "@/bindings/http-supplier-dbs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"

import { FieldNote } from "./supplier-row-media"
import {
  CheckboxCellEditor,
  CommitInput,
  LongTextCellEditor,
  MultiSelectCellEditor,
  NumberCellEditor,
  SelectCellEditor,
  TextCellEditor,
  WEIGHT_UNITS,
  defaultWeightUnit,
  nextOptionValue,
  propsPatch,
  weightDisplayValue,
  weightGramsFromInput,
  type WeightUnit,
} from "./supplier-prop-editors"

export type Patch = Partial<UpsertSupplierDbRowRequest>
export type PatchFn = (patch: Patch) => Promise<boolean>

/** 「图标 + 名 + 值」一行 — Notion 属性列表的节奏。 */
export function PropRow({
  icon,
  name,
  locked,
  wide = false,
  children,
}: {
  icon: React.ReactNode
  name: string
  locked?: boolean
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", wide && "sm:col-span-2")}>
      <span className="flex min-w-0 items-center gap-1.5 text-compact text-muted-foreground">
        <span aria-hidden className="shrink-0 text-faint-foreground [&_svg]:size-3.5">
          {icon}
        </span>
        <span className="break-words">{name}</span>
        {locked ? (
          <Lock aria-label="仅管理员可见" className="size-3 shrink-0 text-faint-foreground" />
        ) : null}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SheetSection({
  title,
  locked,
  note,
  action,
  columns = 1,
  children,
}: {
  title: string
  locked?: boolean
  columns?: 1 | 2
  /** 必要注释 → 圆圈感叹号图标 + tooltip，不进正文。 */
  note?: string
  /** 标题行右缘的控件（默认字段的平台切换），不占正文高度。 */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="flex items-center gap-1.5 border-b border-border/60 pb-1.5 text-compact font-semibold text-foreground">
        {title}
        {note ? <FieldNote text={note} /> : null}
        {locked ? (
          <Lock aria-label="仅管理员可见" className="size-3 text-faint-foreground" />
        ) : null}
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </h3>
      <div className={columns === 2 ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : "flex flex-col gap-3"}>{children}</div>
    </section>
  )
}

/**
 * 重量控件 — 数值输入 + 单位下拉（只列英文单位 g / kg）。库内恒为整数克：
 * 单位只影响显示与换算，换单位本身不写库，提交时才乘回克。
 */
export function WeightCommitInput({
  name,
  grams,
  onCommit,
}: {
  /** 行名 — 拼进输入框的 aria-label 与错误文案。 */
  name: string
  grams: number | null
  onCommit: (grams: number | null) => Promise<boolean>
}) {
  const [unit, setUnit] = useState<WeightUnit>(() => defaultWeightUnit(grams))

  return (
    <div className="flex items-center gap-1.5 [&_input]:w-24">
      <CommitInput
        ariaLabel={`${name}（${unit}）`}
        value={weightDisplayValue(grams, unit)}
        inputMode="decimal"
        mono
        placeholder="0"
        onCommit={async (next) => {
          const nextGrams = weightGramsFromInput(next, unit)
          if (nextGrams === undefined) {
            notifyError(`${name}需为大于 0 的数值（${unit}）`)
            return false
          }
          return onCommit(nextGrams)
        }}
      />
      <Select
        value={unit}
        onValueChange={(next) => {
          if (next) setUnit(next as WeightUnit)
        }}
      >
        <SelectTrigger
          aria-label={`${name}单位`}
          className="w-16 shrink-0 cursor-pointer font-mono"
        >
          <SelectValue>{() => unit}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {WEIGHT_UNITS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="cursor-pointer font-mono"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * 自定义属性行 — 与表格单元格同一套编辑器（点击值即改）。值写
 * `props[prop_id]`；新建选项先改属性定义再点选。
 */
export function CustomPropField({
  def,
  row,
  onPatch,
  onUpdateProp,
}: {
  def: SupplierDbPropDef
  row: SupplierDbRow
  onPatch: PatchFn
  onUpdateProp?: (
    def: SupplierDbPropDef,
    patch: Partial<UpsertSupplierDbPropRequest>,
  ) => Promise<boolean>
}) {
  const value = row.props[def.propId]
  const commitValue = (next: unknown) =>
    onPatch({ props: propsPatch(row.props, def.propId, next) })
  const createOption = onUpdateProp
    ? async (label: string): Promise<SupplierDbPropOption | null> => {
        const option: SupplierDbPropOption = {
          value: nextOptionValue(label, def.options),
          label: label.trim(),
        }
        const ok = await onUpdateProp(def, {
          options: [...def.options, option],
        })
        return ok ? option : null
      }
    : undefined
  const ariaLabel = `自定义属性 ${def.name}`
  switch (def.type) {
    case "select":
      return (
        <SelectCellEditor
          ariaLabel={ariaLabel}
          value={typeof value === "string" ? value : null}
          options={def.options}
          onCommit={commitValue}
          onCreateOption={createOption}
        />
      )
    case "multi_select":
      return (
        <MultiSelectCellEditor
          ariaLabel={ariaLabel}
          values={Array.isArray(value) ? (value as string[]) : []}
          options={def.options}
          onCommit={commitValue}
          onCreateOption={createOption}
        />
      )
    case "checkbox":
      return (
        <CheckboxCellEditor
          ariaLabel={ariaLabel}
          checked={value === true}
          onCommit={commitValue}
        />
      )
    case "number":
      return (
        <NumberCellEditor
          ariaLabel={ariaLabel}
          value={typeof value === "number" ? value : null}
          onCommit={commitValue}
        />
      )
    case "long_text":
      return (
        <LongTextCellEditor
          ariaLabel={ariaLabel}
          value={typeof value === "string" ? value : ""}
          onCommit={commitValue}
        />
      )
    default:
      return (
        <TextCellEditor
          ariaLabel={ariaLabel}
          value={typeof value === "string" ? value : ""}
          onCommit={commitValue}
        />
      )
  }
}
