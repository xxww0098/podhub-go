import { useEffect, useMemo, useState } from "react"
import {
  Ban,
  Check,
  ChevronRight,
  Eraser,
  ImageIcon,
  RefreshCw,
  Search,
  X,
} from "lucide-react"

import { listingHttp } from "@/bindings/http-listing"
import type {
  CategoryFieldOption,
  CategoryFieldView,
  CategorySchemaView,
  WorkflowDraftSelection,
  WorkflowDraftValue,
} from "@/bindings/commands"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { notifyCommandError } from "@/lib/notify"
import {
  fieldOptionDisplayValue,
  isBrandField,
  NO_BRAND_DICTIONARY_VALUE_ID,
  NO_BRAND_OPTION,
  selectionDisplayValue,
} from "./workflow-draft"
import { schemaRequest, selection } from "./workflow-shared"

const REMOTE_SEARCH_DELAY_MS = 300
const REMOTE_SEARCH_LIMIT = 100
const REMOTE_SEARCH_CACHE_LIMIT = 200
const remoteSearchCache = new Map<string, CategoryFieldOption[]>()

function rememberRemoteSearch(key: string, options: CategoryFieldOption[]) {
  if (!remoteSearchCache.has(key) && remoteSearchCache.size >= REMOTE_SEARCH_CACHE_LIMIT) {
    const oldest = remoteSearchCache.keys().next().value
    if (oldest) remoteSearchCache.delete(oldest)
  }
  remoteSearchCache.set(key, options)
}

function mergeOptions(...groups: readonly CategoryFieldOption[][]): CategoryFieldOption[] {
  const seen = new Set<number>()
  return groups.flatMap((group) =>
    group.filter((option) => {
      if (seen.has(option.id)) return false
      seen.add(option.id)
      return true
    }),
  )
}

export function dictionaryOptionsForDisplay({
  inline,
  remote,
  selected,
}: {
  inline: CategoryFieldOption[]
  remote: CategoryFieldOption[]
  selected: CategoryFieldOption[]
}): CategoryFieldOption[] {
  // Preserve Ozon's stable display order. Selected values are only a recovery
  // source for choices absent from the current inline/remote pages; they must
  // never be promoted to the top merely because their state changed.
  return mergeOptions(inline, remote, selected)
}

function matchesQuery(option: CategoryFieldOption, query: string, displayValue = option.value): boolean {
  if (!query) return true
  const searchable = `${displayValue}\n${option.value}\n${option.info}`.toLocaleLowerCase()
  return searchable.includes(query.toLocaleLowerCase())
}

function cacheKey(
  schema: CategorySchemaView,
  field: CategoryFieldView,
  query: string,
  targetStoreId: string,
): string {
  return [
    targetStoreId || "active-store",
    schema.description_category_id,
    schema.type_id,
    schema.language ?? "default",
    field.key,
    query.toLocaleLowerCase(),
  ].join(":")
}

function OptionImage({ option }: { option: CategoryFieldOption }) {
  if (!option.picture) return null
  return (
    <span className="size-10 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
      <img
        src={option.picture}
        alt=""
        loading="lazy"
        className="size-full object-contain"
      />
    </span>
  )
}

export function dictionaryOptionStateClasses({
  selected,
  collection,
}: {
  selected: boolean
  collection: boolean
}) {
  return {
    row: cn(
      "group flex min-h-14 w-full items-center gap-3 rounded-lg px-3 text-left transition-[background-color,color,transform,opacity] duration-200 ease-settle active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-45",
      selected
        ? "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/25"
        : "hover:bg-muted/55",
    ),
    indicator: cn(
      "grid size-5 shrink-0 place-items-center border transition-[background-color,border-color,transform] duration-200 ease-settle",
      collection ? "rounded-md" : "rounded-full",
      selected
        ? "scale-100 border-primary bg-primary text-primary-foreground shadow-sm"
        : "scale-[0.94] border-border-strong bg-background",
    ),
    check: cn(
      "size-3.5 transition-[opacity,transform] duration-200 ease-settle",
      selected ? "scale-100 opacity-100" : "scale-50 opacity-0",
    ),
  }
}

export function nextDictionarySelection({
  selected,
  option,
  collection,
  maximum,
}: {
  selected: WorkflowDraftSelection[]
  option: CategoryFieldOption
  collection: boolean
  maximum?: number
}): { value: WorkflowDraftValue | undefined; close: boolean } {
  const alreadySelected = selected.some(
    (item) => item.dictionary_value_id === option.id,
  )

  if (!collection) {
    return alreadySelected
      ? { value: undefined, close: false }
      : { value: { kind: "single_select", value: selection(option) }, close: true }
  }

  if (alreadySelected) {
    return {
      value: {
        kind: "multi_select",
        value: selected.filter(
          (item) => item.dictionary_value_id !== option.id,
        ),
      },
      close: false,
    }
  }
  if (maximum && selected.length >= maximum) {
    return { value: { kind: "multi_select", value: selected }, close: false }
  }
  return {
    value: {
      kind: "multi_select",
      value: [...selected, selection(option)],
    },
    close: false,
  }
}

function selectedSummary(values: string[]): string {
  if (!values.length) return "浏览并选择"
  const visible = values.slice(0, 2).join("、")
  return values.length > 2 ? `${visible} 等 ${values.length} 项` : visible
}

/**
 * The Ozon dictionary picker, shared by the 默认字段 form control and the workbench
 * 主题 cell: one search + option list + limit/clear footer, so the two surfaces cannot
 * drift into two different ideas of what the dictionary contains.
 *
 * The caller owns `open`; every close path (backdrop, Esc, 完成, a single-select pick)
 * calls `onClose` after the internal search state is cleared.
 */
export function DictionaryPickerDialog({
  open,
  onClose,
  field,
  schema,
  targetStoreId,
  value,
  onChange,
}: {
  open: boolean
  onClose: () => void
  field: CategoryFieldView
  schema: CategorySchemaView
  targetStoreId: string
  value?: WorkflowDraftValue
  onChange: (value: WorkflowDraftValue | undefined) => void
}) {
  const [query, setQuery] = useState("")
  const [remoteOptions, setRemoteOptions] = useState<CategoryFieldOption[]>([])
  const [searching, setSearching] = useState(false)
  const selected =
    value?.kind === "multi_select"
      ? value.value
      : value?.kind === "single_select"
        ? [value.value]
        : []
  const selectedDisplayValues = selected.map((item) => selectionDisplayValue(field, item))
  const normalizedQuery = query.trim()
  const selectedAsOptions = selected.map((item, index) => ({
    id: item.dictionary_value_id,
    value: selectedDisplayValues[index],
    info: "",
    picture: "",
  }))
  const brandField = isBrandField(field)
  const inlineOptions = brandField
    ? mergeOptions([NO_BRAND_OPTION], field.options)
    : field.options
  const availableOptions = useMemo(
    () =>
      dictionaryOptionsForDisplay({
        inline: inlineOptions,
        remote: remoteOptions,
        selected: selectedAsOptions,
      }),
    [inlineOptions, remoteOptions, selected],
  )
  const visibleOptions = availableOptions.filter((option) =>
    matchesQuery(option, normalizedQuery, fieldOptionDisplayValue(field, option)),
  )
  const maxSelected = field.constraints.max_value_count
  const atLimit = Boolean(maxSelected && selected.length >= maxSelected)

  useEffect(() => {
    if (!open) return

    if (!field.options_truncated || normalizedQuery.length < 2) {
      setRemoteOptions([])
      setSearching(false)
      return
    }

    const key = cacheKey(schema, field, normalizedQuery, targetStoreId)
    const cached = remoteSearchCache.get(key)
    if (cached) {
      setRemoteOptions(cached)
      setSearching(false)
      return
    }

    setRemoteOptions([])
    let stale = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      void listingHttp
        .listingCardSearchCategoryDictionary({
          ...schemaRequest(schema),
          target_store_id: targetStoreId || undefined,
          field_key: field.key,
          query: normalizedQuery,
          limit: REMOTE_SEARCH_LIMIT,
        })
        .then((results) => {
          if (stale) return
          rememberRemoteSearch(key, results)
          setRemoteOptions(results)
        })
        .catch((reason) => {
          if (stale) return
          notifyCommandError(reason, "Ozon 字典暂时不可用，请稍后重试。")
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, REMOTE_SEARCH_DELAY_MS)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [
    field.key,
    field.options_truncated,
    normalizedQuery,
    open,
    schema.description_category_id,
    schema.language,
    schema.type_id,
    targetStoreId,
  ])

  function isSelected(optionId: number): boolean {
    return selected.some((item) => item.dictionary_value_id === optionId)
  }

  function choose(option: CategoryFieldOption) {
    const next = nextDictionarySelection({
      selected,
      option,
      collection: field.constraints.collection,
      maximum: maxSelected,
    })
    onChange(next.value)
    if (next.close) closeDrawer()
  }

  function closeDrawer() {
    // Clear before handing control back: the caller may unmount the picker.
    setQuery("")
    setRemoteOptions([])
    onClose()
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDrawer()
        }}
      >
        <DialogContent className="flex h-[min(40rem,calc(100vh-2rem))] w-[min(560px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{field.name}</DialogTitle>
              <span className="rounded-full border border-border px-2 py-0.5 text-meta text-muted-foreground">
                {field.constraints.collection ? "多选" : "单选"}
                {maxSelected ? ` · 最多 ${maxSelected} 项` : ""}
              </span>
            </div>
            <DialogDescription>
              {field.description || "不输入也能浏览；输入名称可筛选。"}
            </DialogDescription>
          </DialogHeader>

          <div className="border-b border-border p-4">
            <div className="relative">
              {searching ? (
                <RefreshCw className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-faint-foreground" />
              ) : (
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint-foreground" />
              )}
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  field.options_truncated
                    ? "筛选已载入选项；输入 2 个字搜索完整字典"
                    : "筛选选项"
                }
                className="pl-9"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 text-meta text-muted-foreground">
              <span>
                {normalizedQuery
                  ? `当前显示 ${visibleOptions.length} 项`
                  : `已载入 ${field.options.length} 项，可直接浏览`}
              </span>
              {field.options_truncated && normalizedQuery.length === 1 ? (
                <span>再输入 1 个字可搜索完整字典</span>
              ) : field.options_truncated && normalizedQuery.length >= 2 ? (
                <span>{searching ? "正在查询 Ozon…" : "已合并 Ozon 搜索结果"}</span>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {visibleOptions.length ? (
              <div className="flex flex-col gap-1">
                {visibleOptions.map((option) => {
                  const checked = isSelected(option.id)
                  const disabled = !checked && atLimit
                  const displayValue = fieldOptionDisplayValue(field, option)
                  const stateClasses = dictionaryOptionStateClasses({
                    selected: checked,
                    collection: field.constraints.collection,
                  })
                  return (
                    <button
                      type="button"
                      key={option.id}
                      aria-pressed={checked}
                      aria-label={
                        checked
                          ? `${displayValue}，已选中，再次点击取消`
                          : displayValue
                      }
                      disabled={disabled}
                      onClick={() => choose(option)}
                      className={stateClasses.row}
                    >
                      <span
                        aria-hidden="true"
                        className={stateClasses.indicator}
                      >
                        <Check className={stateClasses.check} />
                      </span>
                      <OptionImage option={option} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{displayValue}</span>
                        {option.info ? (
                          <span className="mt-0.5 block text-meta leading-relaxed text-muted-foreground">
                            {option.info}
                          </span>
                        ) : null}
                      </span>
                      {option.picture ? (
                        <ImageIcon className="size-3.5 shrink-0 text-faint-foreground" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid min-h-44 place-items-center px-8 text-center text-sm text-muted-foreground">
                {field.options_truncated && normalizedQuery.length < 2
                  ? "当前已载入选项中没有匹配项；再输入一个字可搜索完整字典。"
                  : searching
                    ? "正在查询 Ozon 字典…"
                    : "没有匹配的选项。"}
              </div>
            )}
          </div>

          <DialogFooter className="m-0 flex-row items-center justify-between sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {field.constraints.collection
                ? `已选 ${selected.length} 项${maxSelected ? ` / 最多 ${maxSelected} 项` : ""}`
                : selected.length
                  ? `已选择：${selectedDisplayValues[0]}`
                  : "选择后自动关闭"}
            </span>
            {field.constraints.collection ? (
              <div className="flex items-center gap-2">
                {selected.length ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => onChange({ kind: "multi_select", value: [] })}
                          aria-label="清空"
                          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                        />
                      }
                    >
                      <Eraser aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>清空</TooltipContent>
                  </Tooltip>
                ) : null}
                <button
                  type="button"
                  onClick={closeDrawer}
                  className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-background"
                >
                  完成
                </button>
              </div>
            ) : selected.length ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => onChange(undefined)}
                      aria-label="取消选择"
                      className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                    />
                  }
                >
                  <X aria-hidden />
                </TooltipTrigger>
                <TooltipContent>取消选择</TooltipContent>
              </Tooltip>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function DictionaryDrawerField({
  controlId,
  field,
  schema,
  targetStoreId,
  value,
  invalid,
  onChange,
}: {
  /** Id the field label points at, so the trigger stays the labelled control. */
  controlId?: string
  field: CategoryFieldView
  schema: CategorySchemaView
  targetStoreId: string
  value?: WorkflowDraftValue
  invalid: boolean
  onChange: (value: WorkflowDraftValue | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const selected =
    value?.kind === "multi_select"
      ? value.value
      : value?.kind === "single_select"
        ? [value.value]
        : []
  const selectedDisplayValues = selected.map((item) =>
    selectionDisplayValue(field, item),
  )
  const brandField = isBrandField(field)
  const noBrandSelected = selected.some(
    (item) => item.dictionary_value_id === NO_BRAND_DICTIONARY_VALUE_ID,
  )

  /** 品牌快捷项与弹窗同一条选择规则，两个入口才写同一种值。 */
  function chooseNoBrand() {
    onChange(
      nextDictionarySelection({
        selected,
        option: NO_BRAND_OPTION,
        collection: field.constraints.collection,
        maximum: field.constraints.max_value_count,
      }).value,
    )
  }
  return (
    <>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          id={controlId}
          data-dictionary-trigger={field.key}
          data-dictionary-control
          data-selected-count={selected.length}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={invalid}
          onClick={() => setOpen(true)}
          className="flex h-9 min-w-0 flex-1 items-center gap-3 rounded-lg border border-input bg-card px-3 text-left text-sm outline-none transition-[border-color,box-shadow,background-color] hover:bg-muted/25 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 aria-invalid:border-st-bad aria-invalid:ring-[3px] aria-invalid:ring-st-bad/20"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              selected.length ? "text-foreground" : "text-faint-foreground",
            )}
          >
            {selectedSummary(selectedDisplayValues)}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">
            {selected.length
              ? `已选 ${selected.length} 项`
              : field.options.length
                ? `${field.options.length}${field.options_truncated ? "+" : ""} 个选项`
                : "查看选项"}
          </span>
          <ChevronRight className="size-4 shrink-0 text-faint-foreground" />
        </button>
        {brandField ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-no-brand-quick-choice
                  disabled={noBrandSelected}
                  onClick={chooseNoBrand}
                  aria-label={noBrandSelected ? "已选无品牌" : "无品牌"}
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-muted/35 text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-default disabled:opacity-60"
                />
              }
            >
              <Ban aria-hidden />
            </TooltipTrigger>
            <TooltipContent>{noBrandSelected ? "已选无品牌" : "无品牌"}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <DictionaryPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        field={field}
        schema={schema}
        targetStoreId={targetStoreId}
        value={value}
        onChange={onChange}
      />
    </>
  )
}
