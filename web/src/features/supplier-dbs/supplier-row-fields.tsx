/**
 * 行编辑器三个页签共用的字段原语——字段标签与值、分区标题、
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
import { FieldMeta } from "@/components/field-meta"
import { notifyError } from "@/lib/notify"

import { FieldNote } from "./supplier-row-media"
import {
  BooleanPropEditor,
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

/** 同一字段组内对齐标签和值。 */
export function PropRow({
  name,
  required,
  essential,
  note,
  locked,
  wide,
  children,
}: {
  name: string
  required?: boolean
  /** 选品所需的核心信息，不等同于接口必填约束。 */
  essential?: boolean
  note?: string
  locked?: boolean
  /** 长文本字段占满整行网格。 */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5${wide ? " col-span-full" : ""}`} data-prop-row={name}>
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5 text-meta font-medium text-muted-foreground">
        <span className="break-words">{name}</span>
        {locked ? (
          <Lock aria-label="仅管理员可见" className="size-3 shrink-0 text-faint-foreground" />
        ) : null}
        <FieldMeta name={name} required={required} essential={essential} description={note} />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SheetSection({
  title,
  locked,
  note,
  action,
  children,
}: {
  title: React.ReactNode
  locked?: boolean
  /** 必要注释 → 圆圈感叹号图标 + tooltip，不进正文。 */
  note?: string
  /** 标题行右缘的控件（默认字段的平台切换），不占正文高度。 */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4" data-supplier-row-section="" data-row-section={typeof title === "string" ? title : undefined}>
      <h3 className="flex flex-wrap items-center gap-1.5 text-lg font-semibold tracking-[-0.01em] text-foreground">
        {title}
        {note ? <FieldNote text={note} /> : null}
        {locked ? (
          <Lock aria-label="仅管理员可见" className="size-3 text-faint-foreground" />
        ) : null}
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </h3>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
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
    <div className="flex flex-col gap-1.5">
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
          className="w-full cursor-pointer font-mono"
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
 * 自定义属性行 — 常显输入框与下拉框。值写
 * `props[prop_id]`；新建选项先改属性定义再点选。
 */
export function CustomPropField({
  def,
  row,
  onPatch,
  onUpdateProp,
}: {
  def: SupplierDbPropDef
  row: Pick<SupplierDbRow, "props">
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
        <BooleanPropEditor
          ariaLabel={ariaLabel}
          checked={typeof value === "boolean" ? value : undefined}
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
          placeholder={`请输入${def.name}`}
          onCommit={commitValue}
        />
      )
    default:
      return (
        <TextCellEditor
          ariaLabel={ariaLabel}
          value={typeof value === "string" ? value : ""}
          placeholder={`请输入${def.name}`}
          onCommit={commitValue}
        />
      )
  }
}
