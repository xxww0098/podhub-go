/**
 * 属性与类目编辑器 — 文本、数字和多行文本常显输入框，选项使用下拉框。
 *
 * 提交契约：`onCommit` 返回 `Promise<boolean>` —— true 落定，false
 * （服务端拒绝 / CAS 冲突）保留草稿并标记 `aria-invalid`；
 * 错误文案一律走 `notifyCommandError`，不落 DOM（无 role="alert"）。
 *
 * 键盘：输入框失焦 / Enter 保存，Esc 还原；表单内 Tab / Shift-Tab 正常移焦。
 *
 * `SelectOptionsPanel` / `MultiSelectOptionsPanel` / `CategoryPickerPanel` /
 * `AdjustPricePanel` 是不带 Portal 的内联体，node 测试（无 Portal 渲染）
 * 与浏览器共用同一份 DOM 形状。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Plus, RefreshCw, Search, X } from "lucide-react"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbPropOption } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"

import {
  buildCategorySearchIndex,
  isTypeLeaf,
  nodeName,
  resolveLeaf,
  searchCategoryIndex,
} from "../category-schema/category-tree"

// ---------- 金额/数值解析（原 supplier-row-sheet 的纯函数，提升为共享） ----------

/** 人民币分 — 全部金额列同币种（docs §4 币种口径），统一 ¥。 */
export function formatCnyCents(cents: number | null): string {
  return cents == null ? "—" : `¥${(cents / 100).toFixed(2)}`
}

/** 元 typed by an operator → 分；空串 = 清空（null），非法/非正 = 不写。 */
export function priceCentsFromYuan(input: string): number | null | undefined {
  const trimmed = input.trim().replace(/^[¥$]/, "")
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * 100)
}

/**
 * 非负金额（元）typed by an operator → 分；空串 = 未填（null），`0` 是合法值。
 * 运费不填即零运费（docs/supplier-dbs.md §3），所以不能借用
 * `priceCentsFromYuan` 的「须 > 0」闸。
 */
export function nonNegativeCentsFromYuan(
  input: string,
): number | null | undefined {
  const trimmed = input.trim().replace(/^[¥$]/, "")
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 100)
}

export function centsToInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2)
}

/** 正整数（克数等）typed by an operator → 整数；空串 = 清空（null），非法/非正 = 不写。 */
export function positiveIntFromInput(input: string): number | null | undefined {
  const trimmed = input.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return undefined
  return value
}

// ---------- 重量单位：库内恒为克，界面单位只列英文 ----------

/** 重量单位表 — 只列英文符号（g / kg），不出现中文「克／千克」。 */
export const WEIGHT_UNITS = [
  { value: "g", label: "g" },
  { value: "kg", label: "kg" },
] as const

export type WeightUnit = (typeof WEIGHT_UNITS)[number]["value"]

function weightUnitGrams(unit: WeightUnit): number {
  return unit === "kg" ? 1000 : 1
}

/** 默认单位：≥ 1 kg 用 kg（1.5 kg 而非 1500 g），其余用 g；面板按行挂载，单位随行会话固定。 */
export function defaultWeightUnit(grams: number | null): WeightUnit {
  return grams != null && grams >= 1000 ? "kg" : "g"
}

/** 克 → 所选单位下的输入串；空值 = 空串，小数去掉尾随零。 */
export function weightDisplayValue(
  grams: number | null,
  unit: WeightUnit,
): string {
  if (grams == null) return ""
  const value = grams / weightUnitGrams(unit)
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(3)))
}

/** 所选单位下的输入串 → 整数克；空串 = 清空（null），非法/非正 = 不写。 */
export function weightGramsFromInput(
  input: string,
  unit: WeightUnit,
): number | null | undefined {
  const trimmed = input.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const grams = Math.round(value * weightUnitGrams(unit))
  return grams > 0 ? grams : undefined
}

// ---------- 纯函数：编辑器提交/取消路径的可测试核 ----------

/** Tab/Shift-Tab 横移的目标序号；越界返回 -1（不移动）。 */
export function nextCellIndex(
  count: number,
  current: number,
  delta: number,
): number {
  const next = current + delta
  return next < 0 || next >= count ? -1 : next
}

/**
 * Focus the next/previous editable cell display in the same table. DOM order
 * is row-major, so 横移在行尾自然换到下一行 — the Notion wrap.
 */
export function focusAdjacentCell(from: HTMLElement, delta: 1 | -1): void {
  const table = from.closest("table")
  if (!table) return
  const displays = [...table.querySelectorAll<HTMLElement>("[data-cell-display]")]
  const next = nextCellIndex(displays.length, displays.indexOf(from), delta)
  if (next >= 0) displays[next]?.focus()
}

/** Cell-level Tab handler shared by displays and popover triggers. */
export function cellNavKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || !event.currentTarget.closest("table")) return
  event.preventDefault()
  focusAdjacentCell(event.currentTarget, event.shiftKey ? -1 : 1)
}

/** 新选项的 value：slug 化标签，撞名追加序号；纯中文标签落到 option-N。 */
export function nextOptionValue(
  label: string,
  existing: readonly SupplierDbPropOption[],
): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .slice(0, 48)
  const base = slug || `option-${existing.length + 1}`
  let value = base
  let suffix = 2
  while (existing.some((option) => option.value === value)) {
    value = `${base}-${suffix}`
    suffix += 1
  }
  return value
}

/** multi_select 逐项即写：在值列表里翻转一项。 */
export function toggleInList(values: readonly string[], item: string): string[] {
  return values.includes(item)
    ? values.filter((value) => value !== item)
    : [...values, item]
}

/**
 * `props[propId]` 写入面：空值（null/undefined/""）摘键而不是写空串 —
 * Notion 清空单元格同义；`false` 是勾选属性的真实值，保留。
 */
export function propsPatch(
  props: Record<string, unknown>,
  propId: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...props }
  if (value === undefined || value === null || value === "") {
    delete next[propId]
  } else {
    next[propId] = value
  }
  return next
}

/** 类目单元格的短标签：解析到树给「L2 · 类型」，否则退回坐标对。 */
export function categoryShortLabel(
  descriptionCategoryId: number | null,
  typeId: number | null,
  tree: readonly CategoryTreeNodeView[],
): string {
  if (descriptionCategoryId == null) return ""
  const leaf =
    typeId != null && tree.length
      ? resolveLeaf(descriptionCategoryId, typeId, [...tree])
      : undefined
  if (leaf) {
    const parts = leaf.pathLabel.split(" / ")
    return parts.slice(-2).join(" · ")
  }
  return `类目 ${descriptionCategoryId} / 类型 ${typeId ?? "—"}`
}

// ---------- 失焦提交的基础输入（行页面各分区也用它们） ----------

/**
 * 失焦提交的共享状态机：`edit` 记脏，`revert` 还原（Esc），`commit` 提交
 * （Enter/blur）——失败保留输入并标记错误，失焦可重试。
 */
function useCommitDraft(value: string, onCommit: (next: string) => Promise<boolean>) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const pending = useRef(false)
  const committed = useRef(value)

  useEffect(() => {
    committed.current = value
    if (!dirty) setDraft(value)
  }, [value, dirty])

  const edit = (next: string) => {
    setDraft(next)
    setDirty(true)
    setInvalid(false)
  }

  const revert = () => {
    setDraft(committed.current)
    setDirty(false)
    setInvalid(false)
  }

  const commit = async () => {
    if (pending.current) return
    if (draft === committed.current) {
      setDirty(false)
      setInvalid(false)
      return
    }
    pending.current = true
    setSaving(true)
    try {
      const ok = await onCommit(draft)
      setInvalid(!ok)
      if (ok) { committed.current = draft; setDirty(false) }
    } catch (reason) {
      setInvalid(true)
      notifyCommandError(reason, "保存失败，输入已保留")
    } finally { pending.current = false; setSaving(false) }
  }

  return { draft, saving, invalid, edit, revert, commit }
}

/**
 * A commit-on-blur input: Enter 提交、Esc 还原、失焦提交。While a save is in
 * flight the field locks instead of queueing keystrokes behind a CAS write.
 */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  inputMode,
  ariaLabel,
  mono,
}: {
  value: string
  onCommit: (next: string) => Promise<boolean>
  placeholder?: string
  inputMode?: "decimal" | "text"
  ariaLabel?: string
  mono?: boolean
}) {
  const { draft, saving, invalid, edit, revert, commit } = useCommitDraft(value, onCommit)

  return (
    <Input
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      inputMode={inputMode}
      disabled={saving}
      aria-busy={saving || undefined}
      aria-invalid={invalid || undefined}
      className={cn("h-8", mono && "font-mono tabular-nums")}
      onChange={(event) => edit(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          revert()
        }
      }}
    />
  )
}

export function CommitTextarea({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  rows = 4,
  className,
}: {
  value: string
  onCommit: (next: string) => Promise<boolean>
  placeholder?: string
  ariaLabel?: string
  rows?: number
  className?: string
}) {
  const { draft, saving, invalid, edit, revert, commit } = useCommitDraft(value, onCommit)

  return (
    <Textarea
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      rows={rows}
      className={className}
      disabled={saving}
      aria-busy={saving || undefined}
      aria-invalid={invalid || undefined}
      onChange={(event) => edit(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          revert()
        }
      }}
    />
  )
}

// ---------- 单元格 display（选中态） ----------

const CELL_DISPLAY_CLASS =
  "flex min-h-7 w-full cursor-default items-center rounded-md px-1.5 py-0.5 text-compact outline-none " +
  "hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 " +
  "aria-disabled:pointer-events-none aria-disabled:opacity-50 " +
  "aria-invalid:ring-2 aria-invalid:ring-destructive/40"

// ---------- 文本 / 多行文本 ----------

export function TextCellEditor({
  value, onCommit, ariaLabel, placeholder, mono, inputMode, disabled,
}: {
  value: string
  onCommit: (next: string) => Promise<boolean>
  ariaLabel: string
  placeholder?: string
  mono?: boolean
  inputMode?: "decimal" | "text"
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const committed = useRef(value)
  const inFlight = useRef(false)
  useEffect(() => {
    committed.current = value
    if (!dirty) setDraft(value)
  }, [value, dirty])

  const commit = async () => {
    if (inFlight.current) return
    if (draft === committed.current) { setDirty(false); return }
    inFlight.current = true
    setSaving(true)
    try {
      const ok = await onCommit(draft)
      setInvalid(!ok)
      if (ok) { committed.current = draft; setDirty(false) }
    } catch (reason) {
      setInvalid(true)
      notifyCommandError(reason, "保存属性失败")
    } finally { inFlight.current = false; setSaving(false) }
  }

  return <Input
    data-cell-editor="text" aria-label={ariaLabel} aria-invalid={invalid || undefined}
    aria-busy={saving || undefined} value={draft} disabled={disabled || saving}
    placeholder={placeholder ?? "请输入"} inputMode={inputMode}
    className={mono ? "font-mono tabular-nums" : undefined}
    onChange={event => { setDraft(event.target.value); setDirty(true); setInvalid(false) }}
    onBlur={() => void commit()}
    onKeyDown={event => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() }
      else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation()
        setDraft(committed.current); setDirty(false); setInvalid(false)
      }
    }}
  />
}

/** 多行属性直接展开；保存失败保留草稿，Esc 还原。 */
export function LongTextCellEditor({ value, onCommit, ariaLabel, placeholder, disabled }: {
  value: string
  onCommit: (next: string) => Promise<boolean>
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const committed = useRef(value)
  const inFlight = useRef(false)
  useEffect(() => {
    committed.current = value
    if (!dirty) setDraft(value)
  }, [value, dirty])

  const commit = async () => {
    if (inFlight.current) return
    if (draft === committed.current) { setDirty(false); return }
    inFlight.current = true
    setSaving(true)
    try {
      const ok = await onCommit(draft)
      setInvalid(!ok)
      if (ok) { committed.current = draft; setDirty(false) }
    } catch (reason) {
      setInvalid(true)
      notifyCommandError(reason, "保存属性失败")
    } finally { inFlight.current = false; setSaving(false) }
  }

  return <Textarea
    data-cell-editor="long_text" aria-label={ariaLabel} aria-invalid={invalid || undefined}
    aria-busy={saving || undefined} rows={3} value={draft} disabled={disabled || saving}
    placeholder={placeholder ?? "请输入"}
    onChange={event => { setDraft(event.target.value); setDirty(true); setInvalid(false) }}
    onBlur={() => void commit()}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation()
        setDraft(committed.current); setDirty(false); setInvalid(false)
      }
    }}
  />
}

// ---------- 数字 / 金额（分） ----------

export function NumberCellEditor({
  value,
  onCommit,
  ariaLabel,
  disabled,
}: {
  value: number | null
  onCommit: (next: number | null) => Promise<boolean>
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <TextCellEditor
      ariaLabel={ariaLabel}
      value={value == null ? "" : String(value)}
      mono
      inputMode="decimal"
      placeholder="请输入数字"
      disabled={disabled}
      onCommit={async (draft) => {
        const trimmed = draft.trim()
        if (trimmed === "") return onCommit(null)
        const num = Number(trimmed)
        if (!Number.isFinite(num)) {
          notifyError("请输入数字")
          return false
        }
        return onCommit(num)
      }}
    />
  )
}

// ---------- 勾选 ----------

/** 布尔属性使用下拉框，未填与 false 分开保存。 */
export function BooleanPropEditor({ checked, onCommit, ariaLabel, disabled }: {
  checked: boolean | undefined
  onCommit: (next: boolean | undefined) => Promise<boolean>
  ariaLabel: string
  disabled?: boolean
}) {
  const [invalid, setInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const commit = async (next: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    try { setInvalid(!await onCommit(next === "unset" ? undefined : next === "yes")) }
    catch (reason) { setInvalid(true); notifyCommandError(reason, "保存属性失败") }
    finally { inFlight.current = false; setSaving(false) }
  }
  return <Select value={checked == null ? null : checked ? "yes" : "no"}
    disabled={disabled || saving} onValueChange={next => { if (next) void commit(next) }}>
    <SelectTrigger aria-label={ariaLabel} aria-invalid={invalid || undefined}
      aria-busy={saving || undefined} className="w-full">
      <SelectValue placeholder="请选择">{() => checked == null ? "请选择" : checked ? "是" : "否"}</SelectValue>
      {saving ? <Spinner /> : null}
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="unset">未填写</SelectItem>
      <SelectItem value="yes">是</SelectItem>
      <SelectItem value="no">否</SelectItem>
    </SelectContent>
  </Select>
}

// ---------- 单选 / 多选 ----------

/** 单/多选面板共享：搜索词 → 过滤表 + 是否已存在同名项。 */
function useOptionQuery(options: readonly SupplierDbPropOption[]) {
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options
  const exact = needle
    ? options.some((option) => option.label.trim().toLowerCase() === needle)
    : true
  return { query, setQuery, needle, filtered, exact }
}

/** 单/多选面板共享：新建选项动作 — 建好即选（单选 pick / 多选 toggle）。 */
function useCreateOption(
  onCreateOption: ((label: string) => Promise<SupplierDbPropOption | null>) | undefined,
  onPicked: (value: string) => void | Promise<unknown>,
) {
  const [creating, setCreating] = useState(false)
  const create = async (label: string) => {
    if (!onCreateOption || creating) return
    setCreating(true)
    const option = await onCreateOption(label)
    setCreating(false)
    if (option) await onPicked(option.value)
  }
  return { creating, create }
}

/** 单/多选面板共享的搜索框。 */
function OptionSearchBox({
  query,
  onChange,
  searchRef,
  autoFocus,
}: {
  query: string
  onChange: (next: string) => void
  searchRef?: React.Ref<HTMLInputElement>
  autoFocus?: boolean
}) {
  return (
    <div className="relative">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={searchRef}
        aria-label="搜索选项"
        autoFocus={autoFocus}
        value={query}
        placeholder="搜索选项"
        className="h-8 pl-8"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** 单/多选面板共享的选项列表（listbox + 空态）；勾选标记由谓词决定。 */
function OptionListbox({
  options,
  isSelected,
  onPick,
  multiselectable,
}: {
  options: readonly SupplierDbPropOption[]
  isSelected: (value: string) => boolean
  onPick: (value: string) => void | Promise<unknown>
  multiselectable?: boolean
}) {
  return (
    <div
      role="listbox"
      aria-label="选项"
      aria-multiselectable={multiselectable}
      className="max-h-48 overflow-y-auto overscroll-contain"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={isSelected(option.value)}
          data-option-value={option.value}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-compact outline-none hover:bg-accent focus-visible:bg-accent"
          onClick={() => void onPick(option.value)}
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {isSelected(option.value) ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-brand" />
          ) : null}
        </button>
      ))}
      {options.length === 0 ? (
        <p className="px-2 py-2 text-center text-meta text-faint-foreground">
          无匹配选项
        </p>
      ) : null}
    </div>
  )
}

/** 单/多选面板共享的「新建「标签」」按钮。 */
function CreateOptionButton({
  label,
  creating,
  onClick,
}: {
  label: string
  creating: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={creating}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-compact text-brand outline-none hover:bg-brand-soft disabled:opacity-50"
      onClick={onClick}
    >
      {creating ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <Plus aria-hidden className="size-3.5" />
      )}
      新建「{label}」
    </button>
  )
}

/** 选项列表 + 搜索 + 「＋新建选项」— 无 Portal 内联体，测试可直接渲染。 */
export function SelectOptionsPanel({
  options,
  value,
  onPick,
  onCreateOption,
}: {
  options: readonly SupplierDbPropOption[]
  value: string | null
  onPick: (value: string | null) => void | Promise<void>
  /** Absent → no 新建 affordance (callers without prop-def write access). */
  onCreateOption?: (label: string) => Promise<SupplierDbPropOption | null>
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, needle, filtered, exact } = useOptionQuery(options)
  const { creating, create } = useCreateOption(onCreateOption, onPick)

  return (
    <div className="flex flex-col gap-1.5" data-select-panel="">
      <OptionSearchBox
        query={query}
        onChange={setQuery}
        searchRef={searchRef}
        autoFocus
      />
      <OptionListbox
        options={filtered}
        isSelected={(item) => item === value}
        onPick={onPick}
      />
      {value != null ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-compact text-muted-foreground outline-none hover:bg-accent"
          onClick={() => void onPick(null)}
        >
          <X aria-hidden className="size-3.5" />
          清除选项
        </button>
      ) : null}
      {onCreateOption ? (
        needle && !exact ? (
          <CreateOptionButton
            label={query.trim()}
            creating={creating}
            onClick={() => void create(query.trim())}
          />
        ) : (
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-compact text-faint-foreground outline-none hover:bg-accent hover:text-foreground"
            onClick={() => searchRef.current?.focus()}
          >
            <Plus aria-hidden className="size-3.5" />
            新建选项（输入名称后创建）
          </button>
        )
      ) : null}
    </div>
  )
}

export function SelectCellEditor({
  value,
  options,
  onCommit,
  onCreateOption,
  ariaLabel,
  disabled,
}: {
  value: string | null
  options: readonly SupplierDbPropOption[]
  onCommit: (next: string | null) => Promise<boolean>
  onCreateOption?: (label: string) => Promise<SupplierDbPropOption | null>
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const selected = options.find((option) => option.value === value)

  const pick = async (next: string | null) => {
    const ok = await onCommit(next)
    if (ok) {
      setInvalid(false)
      setOpen(false)
    } else {
      setInvalid(true)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            data-cell-editor="select"
            role="combobox"
            aria-haspopup="dialog"
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className="h-9 w-full justify-between"
            onKeyDown={cellNavKeyDown}
          />
        }
      >
        <span className={cn("min-w-0 flex-1 truncate text-left font-normal", !value && "text-muted-foreground")}>
          {selected?.label ?? (value || "请选择")}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent aria-label={`${ariaLabel}选项`} className="w-64 p-2">
        <SelectOptionsPanel
          options={options}
          value={value}
          onPick={pick}
          onCreateOption={
            onCreateOption
              ? async (label) => {
                  const option = await onCreateOption(label)
                  if (!option) setInvalid(true)
                  return option
                }
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  )
}

/** 多选弹层：chip 组 + 勾选列表 + 新建选项；逐项即写不收起。 */
export function MultiSelectOptionsPanel({
  options,
  values,
  onToggle,
  onClear,
  onCreateOption,
}: {
  options: readonly SupplierDbPropOption[]
  values: readonly string[]
  onToggle: (item: string) => void | Promise<unknown>
  onClear?: () => void | Promise<unknown>
  onCreateOption?: (label: string) => Promise<SupplierDbPropOption | null>
}) {
  const { query, setQuery, needle, filtered, exact } = useOptionQuery(options)
  const { creating, create } = useCreateOption(onCreateOption, onToggle)

  return (
    <div className="flex flex-col gap-1.5" data-multi-select-panel="">
      {values.length ? (
        <div className="flex flex-wrap gap-1">
          {values.map((item) => {
            const label =
              options.find((option) => option.value === item)?.label ?? item
            return (
              <Badge key={item} variant="outline" className="gap-1">
                {label}
                <button
                  type="button"
                  aria-label={`移除 ${label}`}
                  className="cursor-pointer text-faint-foreground hover:text-foreground"
                  onClick={() => void onToggle(item)}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      ) : null}
      <OptionSearchBox query={query} onChange={setQuery} />
      <OptionListbox
        options={filtered}
        isSelected={(item) => values.includes(item)}
        onPick={onToggle}
        multiselectable
      />
      {values.length && onClear ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-compact text-muted-foreground outline-none hover:bg-accent"
          onClick={() => void onClear()}
        >
          <X aria-hidden className="size-3.5" />
          清除全部
        </button>
      ) : null}
      {onCreateOption && needle && !exact ? (
        <CreateOptionButton
          label={query.trim()}
          creating={creating}
          onClick={() => void create(query.trim())}
        />
      ) : null}
    </div>
  )
}

export function MultiSelectCellEditor({
  values,
  options,
  onCommit,
  onCreateOption,
  ariaLabel,
  disabled,
}: {
  values: readonly string[]
  options: readonly SupplierDbPropOption[]
  onCommit: (next: string[]) => Promise<boolean>
  onCreateOption?: (label: string) => Promise<SupplierDbPropOption | null>
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const commit = async (next: string[]) => {
    const ok = await onCommit(next)
    setInvalid(!ok)
    return ok
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            data-cell-editor="multi_select"
            role="combobox"
            aria-haspopup="dialog"
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className="h-auto min-h-9 w-full justify-between"
            onKeyDown={cellNavKeyDown}
          />
        }
      >
        {values.length ? (
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {values.map((item) => (
              <Badge key={item} variant="outline">
                {options.find((option) => option.value === item)?.label ?? item}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-left font-normal text-muted-foreground">请选择，可多选</span>
        )}
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent aria-label={`${ariaLabel}选项`} className="w-72 p-2">
        <MultiSelectOptionsPanel
          options={options}
          values={values}
          onToggle={(item) => commit(toggleInList(values, item))}
          onClear={() => commit([])}
          onCreateOption={onCreateOption}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------- 类目坐标（两级选择器，数据源 GET /api/catalog/tree） ----------

export type CategoryCoord = {
  descriptionCategoryId: number | null
  typeId: number | null
}

/**
 * 两级类目选择器面板：搜索框（扁平命中）+ 类目两列（一级 → 二级）+ 类型列。
 * 存的是坐标对（L2 description_category_id + 类型 type_id）。
 */
export function CategoryPickerPanel({
  tree,
  value,
  onPick,
  onClear,
  loading,
  onEnsure,
}: {
  tree: readonly CategoryTreeNodeView[]
  value: CategoryCoord
  onPick: (next: { descriptionCategoryId: number; typeId: number }) => void
  onClear?: () => void
  loading?: boolean
  /** 树空或解不出当前坐标时回调补拉共享类目缓存（GET /api/catalog/tree）——弹层只在打开时挂载，挂载即触发。 */
  onEnsure?: () => Promise<boolean> | void
}) {
  const [query, setQuery] = useState("")
  const searchIndex = useMemo(() => buildCategorySearchIndex([...tree]), [tree])
  const hits = useMemo(
    () => searchCategoryIndex(searchIndex, query),
    [searchIndex, query],
  )
  const resolved =
    value.descriptionCategoryId != null && value.typeId != null && tree.length
      ? resolveLeaf(value.descriptionCategoryId, value.typeId, [...tree])
      : undefined

  // 打开即补：屏级预取落空（缓存冷 / 上游抖动 / 本地缓存陈旧残缺到解不出
  // 当前坐标）时选择器自己直调共享缓存，不留死面板。每次开弹至多补一次。
  const valueMissing =
    value.descriptionCategoryId != null &&
    value.typeId != null &&
    tree.length > 0 &&
    !resolved
  const needsTree = tree.length === 0 || valueMissing
  const ensuredRef = useRef(false)
  useEffect(() => {
    if (ensuredRef.current || loading || !needsTree) return
    ensuredRef.current = true
    void onEnsure?.()
  }, [needsTree, loading, onEnsure])

  const [l1Id, setL1Id] = useState(resolved?.l1Id ?? 0)
  const [l2Id, setL2Id] = useState(resolved?.l2Id ?? 0)

  const l1Nodes = tree.filter((node) => !isTypeLeaf(node))
  const activeL1 =
    l1Nodes.find((node) => node.description_category_id === l1Id) ?? l1Nodes[0]
  const l2Nodes = (activeL1?.children ?? []).filter((node) => !isTypeLeaf(node))
  const activeL2 =
    l2Nodes.find((node) => node.description_category_id === l2Id) ?? l2Nodes[0]
  const leaves = (activeL2?.children ?? []).filter(isTypeLeaf)

  const paneClass =
    "max-h-52 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border/60"
  const itemClass =
    "flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-compact outline-none hover:bg-accent focus-visible:bg-accent aria-current:bg-brand-soft aria-current:text-foreground"

  return (
    <div className="flex flex-col gap-2" data-category-picker="">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="搜索类目"
          autoFocus
          value={query}
          placeholder={
            loading
              ? "正在拉取类目…"
              : tree.length
                ? "输入名称或 ID"
                : "类目树不可用"
          }
          disabled={loading || tree.length === 0}
          className="h-8 pl-8"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {query.trim() ? (
        <div
          role="listbox"
          aria-label="类目搜索结果"
          className="max-h-52 overflow-y-auto overscroll-contain"
        >
          {hits.map((hit) => (
            <button
              key={`${hit.descriptionCategoryId}-${hit.typeId}`}
              type="button"
              role="option"
              data-cat-leaf={`${hit.descriptionCategoryId}:${hit.typeId}`}
              className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-left text-compact outline-none hover:bg-accent focus-visible:bg-accent"
              onClick={() =>
                onPick({
                  descriptionCategoryId: hit.descriptionCategoryId,
                  typeId: hit.typeId,
                })
              }
            >
              <span className="min-w-0 flex-1 truncate">{hit.pathLabel}</span>
            </button>
          ))}
          {hits.length === 0 ? (
            <p className="px-2 py-2 text-center text-meta text-faint-foreground">
              没有匹配类目
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-1.5">
          <div className={paneClass} role="listbox" aria-label="一级类目">
            {l1Nodes.map((node) => (
              <button
                key={node.description_category_id}
                type="button"
                role="option"
                aria-selected={node.description_category_id === activeL1?.description_category_id}
                aria-current={
                  node.description_category_id === activeL1?.description_category_id
                    ? "true"
                    : undefined
                }
                data-cat-l1={node.description_category_id}
                className={itemClass}
                onClick={() => {
                  setL1Id(node.description_category_id)
                  setL2Id(0)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{nodeName(node)}</span>
              </button>
            ))}
            {l1Nodes.length === 0 ? (
              <p className="px-2 py-3 text-center text-meta text-faint-foreground">
                {loading ? "正在拉取…" : "类目树为空"}
              </p>
            ) : null}
          </div>
          <div className={paneClass} role="listbox" aria-label="二级类目">
            {l2Nodes.map((node) => (
              <button
                key={node.description_category_id}
                type="button"
                role="option"
                aria-selected={node.description_category_id === activeL2?.description_category_id}
                aria-current={
                  node.description_category_id === activeL2?.description_category_id
                    ? "true"
                    : undefined
                }
                data-cat-l2={node.description_category_id}
                className={itemClass}
                onClick={() => setL2Id(node.description_category_id)}
              >
                <span className="min-w-0 flex-1 truncate">{nodeName(node)}</span>
              </button>
            ))}
          </div>
          <div className={paneClass} role="listbox" aria-label="类型">
            {leaves.map((leaf) => (
              <button
                key={leaf.type_id}
                type="button"
                role="option"
                aria-selected={
                  value.typeId === leaf.type_id &&
                  value.descriptionCategoryId ===
                    activeL2?.description_category_id
                }
                data-cat-leaf={`${activeL2?.description_category_id}:${leaf.type_id}`}
                className={itemClass}
                onClick={() => {
                  if (!activeL2) return
                  onPick({
                    descriptionCategoryId: activeL2.description_category_id,
                    typeId: leaf.type_id,
                  })
                }}
              >
                <span className="min-w-0 flex-1 truncate">{nodeName(leaf)}</span>
                {value.typeId === leaf.type_id &&
                value.descriptionCategoryId ===
                  activeL2?.description_category_id ? (
                  <Check aria-hidden className="size-3.5 shrink-0 text-brand" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}
      {needsTree && !loading && onEnsure ? (
        <button
          type="button"
          data-category-tree-retry=""
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-compact text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
          onClick={() => {
            void Promise.resolve(onEnsure()).then((ok) => {
              if (ok === false) notifyError("类目树读取失败，请重试")
            })
          }}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          重新读取类目树
        </button>
      ) : null}
      {value.descriptionCategoryId != null && onClear ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-compact text-muted-foreground outline-none hover:bg-accent"
          onClick={onClear}
        >
          <X aria-hidden className="size-3.5" />
          清除类目
        </button>
      ) : null}
    </div>
  )
}

export function CategoryCellEditor({
  value,
  tree,
  onCommit,
  ariaLabel,
  disabled,
  loading,
  onEnsureTree,
}: {
  value: CategoryCoord
  tree: readonly CategoryTreeNodeView[]
  onCommit: (next: CategoryCoord) => Promise<boolean>
  ariaLabel: string
  disabled?: boolean
  loading?: boolean
  /** 空树开弹时补拉共享类目缓存 — 由宿主接通 GET /api/catalog/tree。 */
  onEnsureTree?: () => Promise<boolean> | void
}) {
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const label = categoryShortLabel(
    value.descriptionCategoryId,
    value.typeId,
    tree,
  )

  const commit = async (next: CategoryCoord) => {
    const ok = await onCommit(next)
    if (ok) {
      setInvalid(false)
      setOpen(false)
    } else {
      setInvalid(true)
    }
    return ok
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-cell-display=""
            data-cell-editor="category"
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className={CELL_DISPLAY_CLASS}
            onKeyDown={cellNavKeyDown}
          />
        }
      >
        {label ? (
          <span className="block min-w-0 truncate text-compact">{label}</span>
        ) : (
          <span className="text-muted-foreground">请选择类目</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-2">
        <CategoryPickerPanel
          tree={tree}
          value={value}
          loading={loading}
          onEnsure={onEnsureTree}
          onPick={(next) => void commit(next)}
          onClear={
            value.descriptionCategoryId != null
              ? () =>
                  void commit({ descriptionCategoryId: null, typeId: null })
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------- 平台价（只读 + 「调价」弹层 → sc_price_versions 新版本） ----------

/** 调价面板：新价（元）+ 备注 → 写入新版本；旧价留在历史（append-only）。 */
export function AdjustPricePanel({
  currentCents,
  onAdjust,
}: {
  currentCents: number | null
  onAdjust: (priceCents: number, note: string) => Promise<boolean>
}) {
  const [price, setPrice] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const submit = async () => {
    const cents = priceCentsFromYuan(price)
    if (cents == null) {
      notifyError("请输入大于 0 的平台价（元）")
      setInvalid(true)
      return
    }
    setSaving(true)
    const ok = await onAdjust(cents, note.trim())
    setSaving(false)
    setInvalid(!ok)
  }

  return (
    <div className="flex flex-col gap-2" data-adjust-price-panel="">
      <p className="text-meta text-faint-foreground">
        当前 {formatCnyCents(currentCents)}；平台价只追加新版本，旧价留在历史里。
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="新平台价（元）"
          aria-invalid={invalid || undefined}
          autoFocus
          value={price}
          inputMode="decimal"
          placeholder="¥ 新价"
          className="h-8 w-28 font-mono tabular-nums"
          onChange={(event) => {
            setPrice(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <Input
          aria-label="调价备注"
          value={note}
          placeholder="备注（可选）"
          className="h-8 flex-1"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="brand"
          disabled={saving}
          className="cursor-pointer"
          onClick={() => void submit()}
        >
          {saving ? <Spinner data-icon="inline-start" /> : null}
          写入
        </Button>
      </div>
    </div>
  )
}


