import {
  ChevronRight,
  CircleHelp,
  FileImage,
  Images,
  Plus,
  Trash2,
} from "lucide-react"
import {
  type CategoryFieldOption,
  type CategoryFieldView,
  type CategorySchemaView,
  type FieldValueOrigin,
  type WorkflowCategoryDraft,
  type WorkflowDraftSelection,
  type WorkflowDraftValue,
  type WorkflowValidationIssue,
} from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  issuesForField,
  occupancyLabel,
  readWorkflowValue,
  fieldDisplayValueAsText,
  fieldOccupancy,
  fixedTextValue,
  textValue,
  type FieldOccupancy,
  type WorkflowValueLocation,
} from "./workflow-draft"

export function categoryFieldDomId(fieldKey: string, controlKey?: string) {
  return `workflow-${(controlKey ?? fieldKey).replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`
}
import { DictionaryDrawerField } from "./dictionary-drawer-field"
import {
  displayFieldName,
  displayGroupName,
  fieldPlaceholder,
  selection,
  singleSelection,
} from "./workflow-shared"

type FixedSelectOption = {
  value: string
  label: string
}

const FIXED_SELECT_OPTIONS: Partial<Record<string, FixedSelectOption[]>> = {
  dimension_unit: [
    { value: "mm", label: "mm" },
    { value: "cm", label: "cm" },
    { value: "in", label: "in" },
  ],
  weight_unit: [
    { value: "g", label: "g" },
    { value: "kg", label: "kg" },
    { value: "lb", label: "lb" },
  ],
  currency_code: [
    { value: "RUB", label: "俄罗斯卢布（RUB）" },
    { value: "CNY", label: "人民币（CNY）" },
    { value: "USD", label: "美元（USD）" },
    { value: "EUR", label: "欧元（EUR）" },
  ],
  vat: [
    { value: "0", label: "不征税（0%）" },
    { value: "0.1", label: "10%" },
    { value: "0.2", label: "20%" },
  ],
}

export function fixedSelectOptions(fieldKey: string): readonly FixedSelectOption[] | undefined {
  return FIXED_SELECT_OPTIONS[fieldKey]
}

const CLEAR_FIXED_SELECT = "__unset__"

export function dictionarySelections(value: WorkflowDraftValue | undefined) {
  if (value?.kind === "multi_select") return value.value
  if (value?.kind === "single_select") return [value.value]
  return []
}

export function dictionarySelectionText(selected: WorkflowDraftSelection[]) {
  if (!selected.length) return undefined
  const labels = selected.map((item) => item.value.trim() || String(item.dictionary_value_id))
  const visible = labels.slice(0, 2)
  const hiddenCount = labels.length - visible.length
  return `${visible.join("、")}${hiddenCount ? ` +${hiddenCount}` : ""}`
}

export function toggleDictionarySelection(
  field: CategoryFieldView,
  value: WorkflowDraftValue | undefined,
  option: CategoryFieldOption,
): WorkflowDraftValue | undefined {
  const selected = dictionarySelections(value)
  const exists = selected.some((item) => item.dictionary_value_id === option.id)

  if (!field.constraints.collection) {
    return exists ? undefined : { kind: "single_select", value: selection(option) }
  }

  const next = exists
    ? selected.filter((item) => item.dictionary_value_id !== option.id)
    : field.constraints.max_value_count && selected.length >= field.constraints.max_value_count
      ? selected
      : [...selected, selection(option)]
  return next.length ? { kind: "multi_select", value: next } : undefined
}

function ozonChineseDescription(field: CategoryFieldView) {
  if (field.source !== "attribute") return undefined
  return /[\u3400-\u9fff]/u.test(field.description) ? field.description : undefined
}

function supportsRawType(rawType: string | undefined) {
  if (!rawType?.trim()) return false
  const normalized = rawType.trim().toLowerCase().replaceAll(/[- ]/g, "_")
  return [
    "integer", "int", "int32", "int64", "long",
    "decimal", "float", "double", "number", "numeric",
    "boolean", "bool", "url", "uri", "link",
    "url_list", "urls", "uri_list", "link_list",
    "enum", "enumeration", "select", "dictionary",
    "multiselect", "multi_select", "multi_enum", "enum_list",
    "string", "text", "char", "textarea", "rich_text", "richtext",
  ].includes(normalized)
}

function DynamicField({
  field,
  schema,
  targetStoreId,
  value,
  issues,
  origin,
  lockedReason,
  onOpenMedia,
  controlKey,
  occupancy,
  onChange,
}: {
  field: CategoryFieldView
  schema: CategorySchemaView
  targetStoreId: string
  value?: WorkflowDraftValue
  issues: WorkflowValidationIssue[]
  origin?: FieldValueOrigin
  /**
   * Why another surface owns this key. Present means the control still renders —
   * an operator looking for 商家货号 has to find it where the field list says it
   * is — but disabled, since whatever is typed here is overwritten per row.
   */
  lockedReason?: string
  onOpenMedia?: () => void
  controlKey?: string
  occupancy?: FieldOccupancy
  onChange: (value: WorkflowDraftValue | undefined) => void
}) {
  const invalid = issues.length > 0
  const fieldId = categoryFieldDomId(field.key, controlKey)
  const collection = field.constraints.collection
  const description = ozonChineseDescription(field)
  const fieldName = displayFieldName(field)
  const fixedOptions = field.source === "fixed" ? fixedSelectOptions(field.key) : undefined
  const hasHelp = Boolean(description || field.source === "fixed")
  // Only a declared-but-unknown raw type lacks safe editing semantics. An absent
  // raw_type is a normal canonical state and still renders from `editor`.
  const unsupportedRawType =
    field.source === "attribute" &&
    Boolean(field.raw_type?.trim()) &&
    !supportsRawType(field.raw_type)

  return (
    <Field
      data-invalid={invalid}
      data-field-key={field.key}
      data-control-key={controlKey ?? field.key}
      data-occupancy={occupancy}
    >
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <FieldLabel htmlFor={lockedReason ? undefined : fieldId}>{fieldName}</FieldLabel>
        {occupancy ? (
          <span className="text-meta text-muted-foreground">
            {occupancyLabel(occupancy)}
          </span>
        ) : null}
        {hasHelp ? (
          <Tooltip>
            <TooltipTrigger
              delay={350}
              render={
                <button
                  type="button"
                  aria-label={`查看“${fieldName}”填写说明`}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-faint-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <CircleHelp aria-hidden="true" className="size-3.5" />
              说明
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              sideOffset={8}
              className="block w-[min(26rem,calc(100vw-2rem))] max-w-none px-3 py-2.5 text-left"
            >
              {description ? (
                <p className="text-xs leading-5">{description}</p>
              ) : (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-5">
                  <dt className="text-background/65">字段</dt>
                  <dd className="font-mono">{field.key}</dd>
                  <dt className="text-background/65">类型</dt>
                  <dd className="font-mono">{field.editor}</dd>
                  <dt className="text-background/65">填写</dt>
                  <dd>
                    {field.read_only
                      ? "系统填写"
                      : field.constraints.required
                        ? "必填"
                        : "选填"}
                  </dd>
                  {field.constraints.max_value_count ? (
                    <>
                      <dt className="text-background/65">数量</dt>
                      <dd>最多 {field.constraints.max_value_count} 项</dd>
                    </>
                  ) : null}
                  {fixedOptions?.length ? (
                    <>
                      <dt className="text-background/65">可选值</dt>
                      <dd>{fixedOptions.map((option) => option.label).join("、")}</dd>
                    </>
                  ) : null}
                </dl>
              )}
              <p className="mt-1.5 text-meta text-background/70">
                {description
                  ? "来源：Ozon API · ZH_HANS"
                  : "来源：Ozon API · POST /v3/product/import"}
              </p>
            </TooltipContent>
          </Tooltip>
        ) : null}
        {field.read_only && !isMediaField(field.key) ? (
          <Badge variant="outline">系统填写</Badge>
        ) : field.constraints.required ? (
          <Badge variant="brand">必填</Badge>
        ) : null}
        {lockedReason ? <Badge variant="outline">逐行生成</Badge> : null}
        {field.constraints.max_value_count ? (
          <Badge variant="code">最多 {field.constraints.max_value_count}</Badge>
        ) : null}
        {origin && !lockedReason ? <Badge variant="outline">{fieldOriginLabel(origin.kind)}</Badge> : null}
      </div>
      {lockedReason ? (
        <div
          id={fieldId}
          role="note"
          className="flex flex-col justify-center rounded-lg border border-dashed border-border/80 bg-muted/25 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <span className="inline-block size-1.5 rounded-full bg-muted-foreground/60" />
            <span>最终值不在此处配置</span>
          </div>
          <p className="mt-0.5 text-meta leading-4 text-muted-foreground">{lockedReason}</p>
        </div>
      ) : unsupportedRawType ? (
        <div
          id={fieldId}
          role="note"
          className="rounded-lg border border-dashed border-border/80 bg-muted/25 px-3 py-2 text-xs"
        >
          <p className="font-medium text-foreground">暂不支持此 Ozon 字段类型</p>
          <p className="mt-0.5 text-meta leading-4 text-muted-foreground">
            原始类型“{field.raw_type || "空"}”没有安全的编辑语义；适配前不能填写。
          </p>
        </div>
      ) : isMediaField(field.key) ? (
        <MediaFieldEditor
          field={field}
          value={value}
          invalid={invalid}
          onChange={onChange}
          onOpenMedia={onOpenMedia}
          origin={origin}
        />
      ) : fixedOptions ? (
        <FixedSelectField
          controlId={fieldId}
          field={field}
          options={fixedOptions}
          value={value}
          onChange={onChange}
          invalid={invalid}
        />
      ) : field.editor === "single_select" ? (
        <SingleSelectField
          controlId={fieldId}
          field={field}
          value={value}
          onChange={onChange}
          invalid={invalid}
        />
      ) : field.editor === "multi_select" || field.editor === "dictionary_search" ? (
        <DictionaryDrawerField
          controlId={fieldId}
          field={field}
          schema={schema}
          targetStoreId={targetStoreId}
          value={value}
          invalid={invalid}
          onChange={onChange}
        />
      ) : field.editor === "boolean" && !collection ? (
        <BooleanField
          controlId={fieldId}
          value={value}
          onChange={onChange}
          invalid={invalid}
        />
      ) : collection || field.editor === "url_list" ? (
        <Textarea
          id={fieldId}
          aria-invalid={invalid}
          disabled={field.read_only}
          rows={3}
          value={fieldDisplayValueAsText(field, value)}
          placeholder="每行一个值"
          onChange={(event) => onChange(textValue(field, event.target.value))}
        />
      ) : (
        <Input
          id={fieldId}
          aria-invalid={invalid}
          disabled={field.read_only}
          inputMode={field.editor === "integer" || field.editor === "decimal" ? "decimal" : undefined}
          value={fieldDisplayValueAsText(field, value)}
          placeholder={fieldPlaceholder(field)}
          onChange={(event) => onChange(textValue(field, event.target.value))}
        />
      )}
    </Field>
  )
}

function MediaFieldEditor({
  field,
  value,
  invalid,
  origin,
  onChange,
  onOpenMedia,
}: {
  field: CategoryFieldView
  value?: WorkflowDraftValue
  invalid: boolean
  origin?: FieldValueOrigin
  onChange: (value: WorkflowDraftValue | undefined) => void
  onOpenMedia?: () => void
}) {
  const current = fieldDisplayValueAsText(field, value)
  const urls = current.split(/\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean)
  const first = urls[0]
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex min-w-0 items-center gap-3">
        {first ? (
          <img
            src={first}
            alt=""
            className="size-14 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : (
          <span className="grid size-14 shrink-0 place-items-center rounded-lg border border-dashed border-border bg-background">
            <FileImage className="size-5 text-muted-foreground" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">
            {urls.length ? `${urls.length} 个公共媒体 URL` : "尚未绑定公共媒体"}
          </p>
          <p className="truncate text-meta text-muted-foreground">
            {first || "切片上传并取得公共 URL 后会写入这里"}
          </p>
          <p className="mt-1 text-meta text-muted-foreground">
            {origin?.kind === "system_media" ? "Public Ready · 系统媒体" : origin ? `${fieldOriginLabel(origin.kind)}写入` : "等待媒体"}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                onClick={onOpenMedia}
                aria-label="打开媒体交付"
              />
            }
          >
            <Images aria-hidden />
          </TooltipTrigger>
          <TooltipContent>打开媒体交付</TooltipContent>
        </Tooltip>
      </div>
      {field.constraints.collection || field.editor === "url_list" ? (
        <Textarea
          aria-invalid={invalid}
          disabled={false}
          rows={2}
          value={current}
          placeholder="也可粘贴已通过认证的公共 HTTPS URL，每行一个"
          onChange={(event) => onChange(textValue(field, event.target.value))}
        />
      ) : (
        <Input
          aria-invalid={invalid}
          disabled={false}
          value={current}
          placeholder="也可粘贴已通过认证的公共 HTTPS URL"
          onChange={(event) => onChange(textValue(field, event.target.value))}
        />
      )}
    </div>
  )
}

function isMediaField(fieldKey: string) {
  return /(image|video|media)/i.test(fieldKey)
}

function fieldOriginLabel(kind: FieldValueOrigin["kind"]) {
  if (kind === "manual") return "人工"
  if (kind === "seller_sku") return "SKU"
  if (kind === "ai_confirmed") return "AI"
  if (kind === "system_media") return "系统媒体"
  return "卡片默认"
}

/**
 * The option a fixed select shows. Operators write text, but a supplier
 * config projects `fixed:vat` as a decimal (Cloud `supplier_projection`,
 * admin `supplier-ozon-config.ts`); both must select the same option.
 */
export function fixedSelectCurrent(value: WorkflowDraftValue | undefined): string | null {
  if (value?.kind === "text") return value.value
  if (value?.kind === "decimal") return String(value.value)
  return null
}

function FixedSelectField({
  controlId,
  field,
  options,
  value,
  onChange,
  invalid,
}: {
  controlId: string
  field: CategoryFieldView
  options: readonly FixedSelectOption[]
  value?: WorkflowDraftValue
  onChange: (value: WorkflowDraftValue | undefined) => void
  invalid: boolean
}) {
  const current = fixedSelectCurrent(value)
  const optional = !field.constraints.required
  const displayValue = options.find((option) => option.value === current)?.label ?? current ?? ""
  return (
    <Select
      value={current}
      onValueChange={(next) =>
        onChange(fixedTextValue(next === CLEAR_FIXED_SELECT ? "" : (next ?? "")))
      }
    >
      <SelectTrigger id={controlId} className="w-full" aria-invalid={invalid}>
        <SelectValue placeholder={optional ? "跟随店铺设置" : "请选择"}>
          {current === null ? undefined : () => displayValue}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {optional ? <SelectItem value={CLEAR_FIXED_SELECT}>跟随店铺设置</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SingleSelectField({
  controlId,
  field,
  value,
  onChange,
  invalid,
}: {
  controlId: string
  field: CategoryFieldView
  value?: WorkflowDraftValue
  onChange: (value: WorkflowDraftValue | undefined) => void
  invalid: boolean
}) {
  const current = value?.kind === "single_select" ? String(value.value.dictionary_value_id) : null
  const displayValue = fieldDisplayValueAsText(field, value)
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        const option = field.options.find((candidate) => String(candidate.id) === next)
        onChange(option ? singleSelection(option) : undefined)
      }}
    >
      <SelectTrigger id={controlId} className="w-full" aria-invalid={invalid}>
        <SelectValue placeholder="选择一个 Ozon 选项">
          {current === null ? undefined : () => displayValue}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {field.options.map((option) => (
          <SelectItem key={option.id} value={String(option.id)}>
            {option.value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function BooleanField({
  controlId,
  value,
  onChange,
  invalid,
}: {
  controlId: string
  value?: WorkflowDraftValue
  onChange: (value: WorkflowDraftValue | undefined) => void
  invalid: boolean
}) {
  const current = value?.kind === "boolean" ? String(value.value) : "unset"
  const displayValue = value?.kind === "boolean" ? (value.value ? "是" : "否") : "未设置"
  return (
    <Select
      value={current}
      onValueChange={(next) =>
        onChange(next === "unset" ? undefined : { kind: "boolean", value: next === "true" })
      }
    >
      <SelectTrigger id={controlId} className="w-full" aria-invalid={invalid}>
        <SelectValue>{() => displayValue}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="unset">未设置</SelectItem>
        <SelectItem value="true">是</SelectItem>
        <SelectItem value="false">否</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** Accordion panels for non-complex fields (Variant C fold). */
export function SimpleFieldPanels({
  fieldGroups,
  schema,
  targetStoreId,
  draft,
  issues,
  onUpdateValue,
  fieldOrigins = [],
  lockedFields,
  onOpenMedia,
  defaultOpen = "all",
  forceOpen,
}: {
  fieldGroups: Array<{ name: string; fields: CategoryFieldView[] }>
  schema: CategorySchemaView
  targetStoreId: string
  draft: WorkflowCategoryDraft
  issues: WorkflowValidationIssue[]
  onUpdateValue: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  fieldOrigins?: FieldValueOrigin[]
  /** Keys another surface writes, mapped to why they are locked here. */
  lockedFields?: ReadonlyMap<string, string>
  onOpenMedia?: () => void
  /** Which simple groups start expanded. */
  defaultOpen?: "all" | "first" | "none"
  /** When true (e.g. active filter), expand every panel. */
  forceOpen?: boolean
}) {
  if (!fieldGroups.length) {
    return (
      <p className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">
        没有匹配当前筛选条件的普通字段。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {fieldGroups.map((group, index) => {
        const open =
          forceOpen ||
          defaultOpen === "all" ||
          (defaultOpen === "first" && index === 0)
        return (
          <details
            key={group.name || `group-${index}`}
            open={open}
            className="group overflow-hidden rounded-xl border border-border bg-card"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="flex-1 text-sm font-semibold">
                {displayGroupName(group.name)}
              </span>
              <span className="text-meta tabular-nums text-faint-foreground">
                {group.fields.length} 项
              </span>
            </summary>
            <div className="grid gap-x-5 gap-y-6 border-t border-border p-4 lg:grid-cols-2">
              {group.fields.map((field) => (
                <DynamicField
                  key={field.key}
                  field={field}
                  schema={schema}
                  targetStoreId={targetStoreId}
                  value={readWorkflowValue(draft, field.key)}
                  issues={issuesForField(issues, field.key)}
                  occupancy={fieldOccupancy(draft, field.key)}
                  origin={fieldOrigins.find((origin) =>
                    origin.address.kind === "plain" && origin.address.field_key === field.key,
                  )}
                  lockedReason={lockedFields?.get(field.key)}
                  onOpenMedia={onOpenMedia}
                  onChange={(value) => onUpdateValue(field.key, value, {})}
                />
              ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}

export function ComplexGroups({
  schema,
  targetStoreId,
  draft,
  issues,
  visibleFieldKeys,
  forceOpen,
  lockedFields,
  onChange,
  onAdd,
  onRemove,
}: {
  schema: CategorySchemaView
  targetStoreId: string
  draft: WorkflowCategoryDraft
  issues: WorkflowValidationIssue[]
  visibleFieldKeys: ReadonlySet<string>
  forceOpen: boolean
  /** Keys another surface writes, mapped to why they are locked here. */
  lockedFields?: ReadonlyMap<string, string>
  onChange: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onAdd: (complexId: number) => void
  onRemove: (complexId: number, itemIndex: number) => void
}) {
  const groups = schema.complex_groups
    .map((group) => ({
      ...group,
      fields: group.field_keys
        .map((key) => schema.fields.find((field) => field.key === key))
        .filter((field): field is CategoryFieldView => Boolean(field))
        .filter((field) => visibleFieldKeys.has(field.key)),
    }))
    .filter((group) => group.fields.length > 0)
  if (!groups.length) return null

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const groupDraft = draft.complex_values.find(
          (candidate) => candidate.complex_id === group.complex_id,
        )
        const items = groupDraft?.items.length ? groupDraft.items : [{ values: {} }]
        return (
          <details
            key={group.complex_id}
            open={forceOpen}
            className="group overflow-hidden rounded-xl border border-border bg-muted/15"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="flex-1 text-sm font-semibold">
                {displayGroupName(group.name)}
              </span>
              <span className="text-meta tabular-nums text-faint-foreground">
                {group.fields.length} 项
              </span>
              {group.collection ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        className="ml-1"
                        onClick={(event) => {
                          event.preventDefault()
                          onAdd(group.complex_id)
                        }}
                        aria-label="添加一项"
                      />
                    }
                  >
                    <Plus aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>添加一项</TooltipContent>
                </Tooltip>
              ) : null}
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-4">
              {items.map((item, itemIndex) => (
                <div
                  key={`${group.complex_id}-${itemIndex}`}
                  className="rounded-xl border border-border bg-background p-4"
                >
                  {group.collection || items.length > 1 ? (
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        第 {itemIndex + 1} 项
                      </p>
                      {group.collection && items.length > 1 ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => onRemove(group.complex_id, itemIndex)}
                                aria-label="删除"
                              />
                            }
                          >
                            <Trash2 aria-hidden />
                          </TooltipTrigger>
                          <TooltipContent>删除</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="grid gap-x-5 gap-y-6 lg:grid-cols-2">
                    {group.fields.map((field) => {
                      const location = { complexId: group.complex_id, itemIndex }
                      return (
                        <DynamicField
                          key={`${field.key}-${itemIndex}`}
                          controlKey={`${field.key}-${group.complex_id}-${itemIndex}`}
                          field={field}
                          schema={schema}
                          targetStoreId={targetStoreId}
                          value={item.values[field.key]}
                          issues={issuesForField(issues, field.key, location)}
                          lockedReason={lockedFields?.get(field.key)}
                          onChange={(value) => onChange(field.key, value, location)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}
