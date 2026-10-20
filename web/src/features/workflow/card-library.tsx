import { useEffect, useRef, useState } from "react"
import {
  Copy,
  Layers,
  PackageOpen,
  Plus,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react"
import type {
  CategorySchemaView,
  CategoryTreeNodeView,
  ListingCardSummary,
  OzonStoreView,
  WorkflowCategoryPrompt,
  WorkflowCategoryVideo,
  WorkflowDraftValue,
} from "@/bindings/commands"
import { PageToolbar } from "@/components/page-toolbar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ReasonTooltip } from "@/components/reason-tooltip"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { CardBindDialog } from "./card-bind-dialog"
import { CardPsdPicker } from "./card-psd-picker"
import { CardBindForm, canSaveBind } from "./card-bind-form"
import {
  CardVideoPanel,
  type PendingVideoItem,
  type VideoActionPhase,
} from "./media/card-video-panel"
import { CardStoreChips, cardStoreChipLabels } from "./card-store-chips"
import { CardStorePicker } from "./card-store-picker"
import {
  categoryPathLabel,
  type CategoryTreeSelection,
} from "@/features/category-schema/category-tree"
import { parseSalePrice } from "./sale-price"
import {
  RICH_CONTENT_ATTRIBUTE_ID,
  THEME_ATTRIBUTE_ID,
  fieldByAttributeId,
  savedFormTitle,
} from "./workflow-shared"
import { draftAttributeValue } from "@/bindings/listing-projection"
import { textValue, valueAsText } from "./workflow-draft"
import {
  CardRichContentCell,
  CardRichContentDialog,
  CardThemeCell,
} from "./card-default-cells"
import { DictionaryPickerDialog } from "./dictionary-drawer-field"
import { CardLibrarySkeleton } from "./card-library-skeleton"
import { themeCoordinate, useDeferredThemeSupport } from "./card-library-theme"

/** Leaf first, ancestors underneath — a register line, not a truncated breadcrumb. */
function splitCategoryPath(path: string): { leaf: string; ancestors: string } {
  const sep = " / "
  const at = path.lastIndexOf(sep)
  if (at === -1) return { leaf: path, ancestors: "" }
  return { leaf: path.slice(at + sep.length), ancestors: path.slice(0, at) }
}

function specPromptLines(form: ListingCardSummary): { spec: string; prompt: string } {
  return {
    spec: form.size?.trim() ?? "",
    prompt: form.ai_prompt_file_name.trim(),
  }
}

function specPromptLabel(spec: string, prompt: string): string {
  if (spec && prompt) return `规格 ${spec} · 提示词 ${prompt}`
  if (spec) return `规格 ${spec}`
  if (prompt) return `提示词 ${prompt}`
  return "无规格与提示词"
}

/** Name, spec, prompt, price, category, store — the columns an operator can already see. */
export function listingCardMatchesQuery(
  form: ListingCardSummary,
  query: string,
  categoryTree: CategoryTreeNodeView[],
  stores: readonly OzonStoreView[],
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const path = categoryPathLabel(
    form.description_category_id,
    form.type_id,
    categoryTree,
  )
  const storeLabels = cardStoreChipLabels(form.target_store_id, stores)
    .map((chip) => chip.label)
    .join(" ")
  const haystack = [
    savedFormTitle(form),
    form.display_name,
    form.size ?? "",
    form.price ?? "",
    form.old_price ?? "",
    form.ai_prompt_file_name,
    form.psd_template_file_name,
    path,
    storeLabels,
    form.target_store_id,
  ]
    .join("\n")
    .toLowerCase()
  return haystack.includes(needle)
}

/**
 * The unavailable-source footnote: the one sentence the badge row, the PSD
 * picker's disabled reason, and the row footnote all render.
 */
const SOURCE_UNAVAILABLE_HINT = "来源不可用 · 请在商库确认配置"

/**
 * The rows the table shows. A carried cardId target (商详「进入上架」) is
 * pinned through any stale filter — the operator was just told the row was
 * added, so it must be visible — while every other row keeps filtering, so a
 * lingering cardId never turns the search box into a dead end. The search
 * box's own text is cleared separately by the highlight effect.
 */
export function listingCardVisibleForms(
  forms: ListingCardSummary[],
  query: string,
  categoryTree: CategoryTreeNodeView[],
  stores: readonly OzonStoreView[],
  highlightDraftId?: string,
): ListingCardSummary[] {
  // The highlight target is pinned through any stale filter — the「进入上架」
  // row must be visible — but the filter keeps answering for every other
  // row: a present cardId must not turn the search box into a dead end.
  return forms.filter(
    (form) =>
      Boolean(highlightDraftId && form.draft_id === highlightDraftId) ||
      listingCardMatchesQuery(form, query, categoryTree, stores),
  )
}

export function CardLibrary({
  forms,
  videoUploads,
  busy,
  composing,
  composeBusy,
  composeSaving,
  composeSavingLabel,
  composeName,
  composeSelection,
  composeStoreId,
  stores,
  composePsdFileName,
  composePrompts,
  composePromptId,
  composePromptRefreshBusy,
  composePendingVideos,
  composePoolVideos,
  composeVideoPhase,
  copyingCardId,
  categoryTree,
  treeBusy,
  onComposeNameChange,
  onComposeStoreChange,
  onSelectL1,
  onSelectL2,
  onSelectType,
  onRefreshCategoryTree,
  onPickComposePsd,
  onComposePromptChange,
  onRefreshComposePrompts,
  onPickComposeVideos,
  onPickComposePoolVideo,
  onUploadComposeVideos,
  onRemovePendingComposeVideo,
  onCancelCompose,
  onSaveCompose,
  onRun,
  onCopy,
  onDelete,
  onOpenStores,
  onOpenCatalog,
  onBindStores,
  onBindPsd,
  onClearPsd,
  savingPsdId,
  highlightDraftId,
  onSavePrice,
  onSaveOldPrice,
  savingPriceId,
  onSaveDefaultField,
  savingDefaultFieldId,
  onLoadCardSchema,
}: {
  forms: ListingCardSummary[]
  videoUploads: Record<string, { done: number; total: number }>
  busy: boolean
  composing: boolean
  composeBusy: boolean
  composeSaving: boolean
  /** Phase copy while saving ("正在获取类目字段…" → "正在保存卡片…"). */
  composeSavingLabel?: string
  composeName: string
  composeSelection: CategoryTreeSelection
  composeStoreId: string
  stores: OzonStoreView[]
  composePsdFileName: string
  composePrompts: WorkflowCategoryPrompt[]
  composePromptId: string
  composePromptRefreshBusy?: boolean
  composePendingVideos: PendingVideoItem[]
  composePoolVideos: WorkflowCategoryVideo[]
  composeVideoPhase: VideoActionPhase
  copyingCardId?: string
  categoryTree: CategoryTreeNodeView[]
  treeBusy: boolean
  onComposeNameChange: (value: string) => void
  onComposeStoreChange: (value: string) => void
  onSelectL1: (l1Id: number) => void
  onSelectL2: (l2Id: number) => void
  onSelectType: (descriptionCategoryId: number, typeId: number) => void
  onRefreshCategoryTree: () => void
  onPickComposePsd: () => void
  onComposePromptChange: (promptId: string) => void
  onRefreshComposePrompts?: () => void
  onPickComposeVideos: () => void
  onPickComposePoolVideo: (video: WorkflowCategoryVideo) => void
  onUploadComposeVideos: () => void
  onRemovePendingComposeVideo: (assetHandle: string) => void
  onCancelCompose: () => void
  onSaveCompose: () => void
  onRun: (form: ListingCardSummary) => void
  onCopy: (form: ListingCardSummary) => void | Promise<void>
  onDelete: (form: ListingCardSummary) => void | Promise<void>
  onOpenStores?: () => void
  onOpenCatalog?: () => void
  /** Inline store rebind from the table cell; resolves true when the write lands. */
  onBindStores?: (
    form: ListingCardSummary,
    storeIds: string[],
  ) => Promise<boolean>
  /** Inline PSD rebind from the name cell (the picker owns the file dialog). */
  onBindPsd?: (form: ListingCardSummary) => void | Promise<void>
  /** The Card whose template write is in flight, for the cell's spinner. */
  savingPsdId?: string
  /** Hands the PSD back to the online supplier template. */
  onClearPsd?: (form: ListingCardSummary) => void | Promise<void>
  highlightDraftId?: string
  /**
   * Resolves false when the write was refused — the cell keeps the typed
   * input and marks it invalid; undefined is a guard exit with no verdict.
   * Callers must forward the promise's value: swallowing it with `void`
   * turns every failure back into a silent rollback.
   */
  onSavePrice: (
    form: ListingCardSummary,
    price: number | null,
  ) => Promise<boolean | undefined>
  onSaveOldPrice: (
    form: ListingCardSummary,
    price: number | null,
  ) => Promise<boolean | undefined>
  savingPriceId?: string
  /**
   * 主题 / JSON富内容 share the price cells' contract: one card default field
   * is written, then the host syncs the rows that will not follow on their own.
   * `fieldKey` is the Card's own Schema key, resolved from the Schema read on open.
   */
  onSaveDefaultField: (
    form: ListingCardSummary,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
  ) => Promise<boolean | undefined>
  /** The Card whose 主题 / JSON富内容 default write is in flight. */
  savingDefaultFieldId?: string
  /** One Card's Category Schema, for the 主题 picker's dictionary. */
  onLoadCardSchema: (form: ListingCardSummary) => Promise<CategorySchemaView>
}) {
  const [pendingDeletes, setPendingDeletes] = useState<ListingCardSummary[]>([])
  const [query, setQuery] = useState("")
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const templates = forms
  const visible = listingCardVisibleForms(
    templates,
    query,
    categoryTree,
    stores,
    highlightDraftId,
  )
  const visibleIds = visible.map((form) => form.draft_id)
  const liveSelected = templates.filter((form) => selectedIds.has(form.draft_id))
  const selectedCount = liveSelected.length
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id))
  const selectedUploading = liveSelected.some((form) => videoUploads[form.draft_id])
  const canSaveCompose = canSaveBind({
    name: composeName,
    descriptionCategoryId: composeSelection.descriptionCategoryId,
    typeId: composeSelection.typeId,
    promptId: composePromptId,
  })
  const dialogOpen = composing
  const composeLeafChosen =
    composeSelection.descriptionCategoryId > 0 && composeSelection.typeId > 0
  // undefined = loading, null = read failed (the picker can retry on click).
  // Probes wait until after this paint and share a small concurrency cap so
  // they do not compete with the list's own first response.
  const { themeSupport, noteThemeSupport } = useDeferredThemeSupport(forms, onLoadCardSchema)

  /**
   * 主题 / JSON富内容 的名册编辑：主题走共享字典选择器（与默认字段表单同一个），
   * 富内容走粘贴弹窗。Schema 在打开时按卡坐标拉一次（工作台用同一入口），
   * 失败只报 toast 并收起，不在格子里留内联错误。
   */
  const [defaultEdit, setDefaultEdit] = useState<{
    form: ListingCardSummary
    column: "theme" | "rich_content"
  } | null>(null)
  const [defaultSchema, setDefaultSchema] = useState<
    CategorySchemaView | undefined
  >(undefined)
  const [themeDraft, setThemeDraft] = useState<WorkflowDraftValue | undefined>()
  const [themeInitial, setThemeInitial] = useState<WorkflowDraftValue | undefined>()
  const [richDraft, setRichDraft] = useState("")
  const defaultEditGeneration = useRef(0)
  const themeField = defaultSchema
    ? fieldByAttributeId(defaultSchema, THEME_ATTRIBUTE_ID)
    : undefined
  const richContentField = defaultSchema
    ? fieldByAttributeId(defaultSchema, RICH_CONTENT_ATTRIBUTE_ID)
    : undefined

  /** 卡默认里的 主题 / JSON富内容 摘要 —— 无 Schema 时按已知键扫描（见 draftAttributeValue）。 */
  const cardThemeText = (form: ListingCardSummary) =>
    valueAsText(draftAttributeValue(form.defaults, THEME_ATTRIBUTE_ID, "theme"))
      .split("\n")
      .filter(Boolean)
      .join("、")
  const cardRichContentText = (form: ListingCardSummary) =>
    valueAsText(
      draftAttributeValue(form.defaults, RICH_CONTENT_ATTRIBUTE_ID, "rich_content"),
    ).trim()

  function openDefaultEdit(
    form: ListingCardSummary,
    column: "theme" | "rich_content",
  ) {
    const generation = ++defaultEditGeneration.current
    const theme = draftAttributeValue(form.defaults, THEME_ATTRIBUTE_ID, "theme")
    setDefaultEdit({ form, column })
    setDefaultSchema(undefined)
    setThemeDraft(theme)
    setThemeInitial(theme)
    setRichDraft(cardRichContentText(form))
    void onLoadCardSchema(form)
      .then((schema) => {
        if (generation !== defaultEditGeneration.current) return
        const field =
          column === "theme"
            ? fieldByAttributeId(schema, THEME_ATTRIBUTE_ID)
            : fieldByAttributeId(schema, RICH_CONTENT_ATTRIBUTE_ID)
        if (column === "theme") {
          noteThemeSupport(themeCoordinate(form), Boolean(field))
        }
        if (!field) {
          setDefaultEdit(null)
          notifyError(
            column === "theme"
              ? "当前类目无主题属性"
              : "当前类目无 JSON富内容属性",
          )
          return
        }
        setDefaultSchema(schema)
      })
      .catch((reason) => {
        if (generation !== defaultEditGeneration.current) return
        setDefaultEdit(null)
        notifyCommandError(reason, "无法读取类目字段")
      })
  }

  function closeDefaultEdit() {
    defaultEditGeneration.current += 1
    setDefaultEdit(null)
    setDefaultSchema(undefined)
  }

  /** 选择器把所有关闭路径都当提交：与工作台逐次落库的语义一致，值不会白选。 */
  function closeThemeEdit() {
    const edit = defaultEdit
    const changed =
      JSON.stringify(themeDraft ?? null) !== JSON.stringify(themeInitial ?? null)
    closeDefaultEdit()
    if (edit && changed && themeField) {
      void onSaveDefaultField(edit.form, themeField.key, themeDraft)
    }
  }

  function commitRichContent(raw: string) {
    const edit = defaultEdit
    const field = richContentField
    if (!edit || !field) return
    const value = raw.trim() ? textValue(field, raw) : undefined
    closeDefaultEdit()
    void onSaveDefaultField(edit.form, field.key, value)
  }

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const toggleSelectRow = (draftId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(draftId)
      else next.delete(draftId)
      return next
    })
  }

  useEffect(() => {
    if (!highlightDraftId) return
    setQuery("")
  }, [highlightDraftId])

  useEffect(() => {
    if (!highlightDraftId) return
    const row = document.querySelector(
      `[data-listing-card="${CSS.escape(highlightDraftId)}"]`,
    )
    row?.scrollIntoView({ block: "nearest" })
  }, [highlightDraftId, forms.length, query])

  useEffect(() => {
    if (!templates.length || dialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable)
      if (typing) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [dialogOpen, templates.length])

  if (busy && templates.length === 0) return <CardLibrarySkeleton />

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col gap-3"
      data-testid="workflow-screen"
    >
      {templates.length ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-fit max-h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="shrink-0 border-b border-border px-3 py-2">
              <PageToolbar
                primary={
                  <>
                    <div className="relative w-56 min-w-0">
                      <Search
                        aria-hidden
                        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        ref={searchRef}
                        type="search"
                        aria-label="搜索上架方案"
                        placeholder="搜索名称、规格、类目或店铺"
                        title="搜索名称、规格、类目或店铺（/ 聚焦）"
                        value={query}
                        disabled={dialogOpen}
                        onChange={(event) => setQuery(event.target.value)}
                        className="h-8 pl-8"
                      />
                    </div>
                    <p className="whitespace-nowrap text-sm text-muted-foreground">
                      <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                        {visible.length}
                      </span>
                      {query.trim() && visible.length !== templates.length ? (
                        <span className="font-mono text-sm tabular-nums">
                          {" "}
                          / {templates.length}
                        </span>
                      ) : null}
                      {" "}个上架方案
                    </p>
                  </>
                }
                secondary={
                  <>
                    {selectedCount > 0 ? (
                      <div
                        role="toolbar"
                        aria-label="批量操作"
                        className="flex items-center gap-0.5 rounded-full border border-border bg-card pr-1 pl-3"
                      >
                        <span className="text-compact font-medium text-muted-foreground tabular-nums">
                          已选 {selectedCount} 个方案
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={dialogOpen || busy || selectedUploading}
                          className="cursor-pointer text-destructive hover:text-destructive"
                          onClick={() => setPendingDeletes(liveSelected)}
                        >
                          删除
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label="清除选择"
                          className="cursor-pointer"
                          onClick={() => setSelectedIds(new Set())}
                        >
                          <X aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={dialogOpen || busy}
                      onClick={onOpenCatalog}
                    >
                      <Plus data-icon="inline-start" />
                      从商库添加
                    </Button>
                  </>
                }
              />
            </div>
            <Table
              className="min-w-[64rem]"
              containerClassName="min-h-0 overflow-auto overscroll-contain"
            >
            <TableCaption className="sr-only">上架方案</TableCaption>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 bg-card">
                  <Checkbox
                    aria-label="选择全部上架方案"
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    disabled={dialogOpen || visibleIds.length === 0}
                    onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                  />
                </TableHead>
                <TableHead className="bg-card">名称</TableHead>
                <TableHead className="bg-card">规格与提示词</TableHead>
                <TableHead className="w-28 bg-card">销售价</TableHead>
                <TableHead className="w-28 bg-card">划线价</TableHead>
                <TableHead className="w-40 bg-card">主题</TableHead>
                <TableHead className="w-44 bg-card">JSON富内容</TableHead>
                <TableHead className="bg-card">类目</TableHead>
                <TableHead className="bg-card">店铺</TableHead>
                <TableHead className="bg-card text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={10}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    没有匹配的上架方案
                  </TableCell>
                </TableRow>
              ) : null}
              {visible.map((form) => {
                const title = savedFormTitle(form)
                const path = categoryPathLabel(
                  form.description_category_id,
                  form.type_id,
                  categoryTree,
                )
                const { leaf, ancestors } = splitCategoryPath(path)
                const uploading = videoUploads[form.draft_id]
                const psdName = form.psd_template_file_name.trim()
                const { spec, prompt } = specPromptLines(form)

                const selected = selectedIds.has(form.draft_id)
                // The library cell's PSD binding. A dead source keeps the
                // disabled picker visible but wraps it in a reason tooltip —
                // a greyed-out button must never be an unexplained dead end.
                const psdPicker = onBindPsd ? (
                  <CardPsdPicker
                    draftId={form.draft_id}
                    fileName={psdName}
                    supplierBound={Boolean(form.supplier_product_id)}
                    disabled={
                      dialogOpen ||
                      busy ||
                      Boolean(form.supplier_unavailable) ||
                      Boolean(uploading)
                    }
                    saving={savingPsdId === form.draft_id}
                    onPick={() => onBindPsd(form)}
                    onClear={onClearPsd ? () => onClearPsd(form) : undefined}
                  />
                ) : null

                return (
                  <TableRow
                    key={form.draft_id}
                    data-listing-card={form.draft_id}
                    data-highlighted={highlightDraftId === form.draft_id ? "true" : undefined}
                    data-state={selected ? "selected" : undefined}
                    className={cn(
                      dialogOpen && "pointer-events-none opacity-60",
                      highlightDraftId === form.draft_id &&
                        "bg-brand/8 ring-1 ring-inset ring-brand/40",
                    )}
                  >
                    <TableCell
                      className="py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        aria-label={`选择 ${title}`}
                        checked={selected}
                        disabled={dialogOpen}
                        onCheckedChange={(checked) =>
                          toggleSelectRow(form.draft_id, checked === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <p className="block min-w-0 max-w-full truncate text-left text-sm font-medium tracking-[-0.01em] text-foreground">
                            {title}
                          </p>
                          {form.supplier_unavailable ? (
                            <Badge variant="destructive">来源不可用</Badge>
                          ) : null}
                        </div>
                        {onBindPsd ? (
                          form.supplier_unavailable ? (
                            <ReasonTooltip
                              reason={SOURCE_UNAVAILABLE_HINT}
                              className="mt-0.5 -ml-1 inline-flex max-w-full"
                            >
                              {psdPicker}
                            </ReasonTooltip>
                          ) : (
                            psdPicker
                          )
                        ) : psdName ? (
                          <p className="mt-0.5 truncate font-mono text-meta text-faint-foreground">
                            {psdName}
                          </p>
                        ) : null}
                        {form.supplier_unavailable ? <p className="mt-0.5 text-xs text-muted-foreground">{SOURCE_UNAVAILABLE_HINT}</p> : null}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div
                        className="min-w-0 max-w-[16rem]"
                        aria-label={specPromptLabel(spec, prompt)}
                      >
                        {spec || prompt ? (
                          <>
                            <span className="block truncate font-mono text-sm tabular-nums text-foreground">
                              {spec || prompt}
                            </span>
                            {spec && prompt ? (
                              <span className="mt-0.5 block truncate font-mono text-meta text-faint-foreground">
                                {prompt}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="whitespace-nowrap text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="w-28 py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <CardSalePriceCell
                        title={title}
                        label="销售价"
                        price={form.price}
                        disabled={dialogOpen || busy || Boolean(form.supplier_unavailable)}
                        saving={savingPriceId === form.draft_id}
                        onSave={(price) => onSavePrice(form, price)}
                      />
                    </TableCell>
                    <TableCell
                      className="w-28 py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <CardSalePriceCell
                        title={title}
                        label="划线价"
                        price={form.old_price}
                        disabled={dialogOpen || busy || Boolean(form.supplier_unavailable)}
                        saving={savingPriceId === form.draft_id}
                        onSave={(price) => onSaveOldPrice(form, price)}
                      />
                    </TableCell>
                    <TableCell
                      className="w-40 py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <CardThemeCell
                        title={title}
                        value={cardThemeText(form)}
                        unsupported={themeSupport[themeCoordinate(form)] === false}
                        disabled={
                          dialogOpen ||
                          busy ||
                          Boolean(form.supplier_unavailable) ||
                          savingDefaultFieldId === form.draft_id ||
                          themeSupport[themeCoordinate(form)] !== true &&
                          themeSupport[themeCoordinate(form)] !== null
                        }
                        onOpen={() => openDefaultEdit(form, "theme")}
                      />
                    </TableCell>
                    <TableCell
                      className="w-44 py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <CardRichContentCell
                        title={title}
                        value={cardRichContentText(form)}
                        disabled={
                          dialogOpen ||
                          busy ||
                          Boolean(form.supplier_unavailable) ||
                          savingDefaultFieldId === form.draft_id
                        }
                        onOpen={() => openDefaultEdit(form, "rich_content")}
                      />
                    </TableCell>
                    <TableCell className="py-2.5">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <div className="min-w-0 max-w-[18rem]" aria-label={path} />
                          }
                        >
                          <span className="block truncate text-sm text-foreground">
                            {leaf}
                          </span>
                          {ancestors ? (
                            <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                              {ancestors}
                            </span>
                          ) : null}
                        </TooltipTrigger>
                        <TooltipContent>{path}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell
                      onClick={(event) => event.stopPropagation()}
                    >
                      {onBindStores ? (
                        <CardStorePicker
                          storeIdString={form.target_store_id}
                          stores={stores}
                          disabled={
                            busy ||
                            dialogOpen ||
                            Boolean(form.supplier_unavailable) ||
                            Boolean(uploading)
                          }
                          onCommit={(storeIds) =>
                            onBindStores(form, storeIds)
                          }
                          onOpenStores={onOpenStores}
                        />
                      ) : (
                        <CardStoreChips
                          storeIdString={form.target_store_id}
                          stores={stores}
                        />
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ListingCardActions
                        title={title}
                        supplierBound={Boolean(form.supplier_product_id)}
                        unavailable={form.supplier_unavailable}
                        busy={busy}
                        uploading={Boolean(uploading)}
                        dimmed={dialogOpen}
                        copying={copyingCardId === form.draft_id}
                        onRun={() => onRun(form)}
                        onCopy={() => void onCopy(form)}
                        onDelete={() => setPendingDeletes([form])}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <Empty className="min-h-0 flex-1 rounded-xl border border-border bg-card p-6 sm:p-10 justify-center overflow-y-auto shadow-2xs">
          <div className="flex flex-col items-center w-full max-w-2xl mx-auto space-y-6 my-auto text-center">
            <EmptyHeader className="max-w-lg gap-2.5">
              <EmptyMedia
                variant="default"
                className="mx-auto mb-1 flex size-12 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20 shadow-2xs"
              >
                <Layers className="size-6" />
              </EmptyMedia>
              <EmptyTitle className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                还没有上架方案
              </EmptyTitle>
              <EmptyDescription className="text-sm/relaxed text-muted-foreground max-w-md mx-auto">
                从商库选择商品加入列表。同一商品只保留一份引用，配置以在线商库为准。
              </EmptyDescription>
            </EmptyHeader>

            <EmptyContent className="max-w-none w-full gap-5">
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full sm:w-auto">
                <Button
                  onClick={onOpenCatalog}
                  size="lg"
                  className="w-full sm:w-auto justify-center gap-2 font-medium shadow-2xs active:scale-[0.99] transition-all px-6 has-data-[icon=inline-start]:pl-6"
                >
                  <PackageOpen data-icon="inline-start" className="size-4" />
                  去平台货源选品
                </Button>
              </div>

              <p className="text-meta text-muted-foreground/80">
                商品配置由商库维护，发送前绑定目标店铺即可。
              </p>
            </EmptyContent>
          </div>
        </Empty>
      )}

      {defaultEdit?.column === "theme" && themeField && defaultSchema ? (
        <DictionaryPickerDialog
          open
          onClose={closeThemeEdit}
          field={themeField}
          schema={defaultSchema}
          targetStoreId={
            defaultEdit.form.target_store_id.split(",")[0]?.trim() ?? ""
          }
          value={themeDraft}
          onChange={setThemeDraft}
        />
      ) : null}
      {defaultEdit?.column === "rich_content" && richContentField ? (
        <CardRichContentDialog
          open
          title={savedFormTitle(defaultEdit.form)}
          value={richDraft}
          onClose={closeDefaultEdit}
          onSave={commitRichContent}
        />
      ) : null}

      <CardBindDialog
        open={composing}
        onOpenChange={(next) => {
          if (!next && !composeSaving) onCancelCompose()
        }}
        title="新建上架方案"
        description="名称、搜索类目与提示词。店铺、PSD 与商品视频可稍后绑定"
        showCloseButton={!composeSaving}
        busy={composeSaving}
        videoPanel={
          <CardVideoPanel
            videos={[]}
            pendingVideos={composePendingVideos}
            poolVideos={composePoolVideos}
            phase={composeVideoPhase}
            disabled={composeBusy}
            onPickVideos={onPickComposeVideos}
            onPickPoolVideo={onPickComposePoolVideo}
            onUploadVideos={onUploadComposeVideos}
            uploadDisabled={!canSaveCompose}
            onRemovePendingVideo={onRemovePendingComposeVideo}
            onRemoveVideo={() => undefined}
          />
        }
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              className="sm:w-24"
              disabled={composeSaving}
              onClick={onCancelCompose}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="compose-form"
              className="sm:min-w-32"
              disabled={!composeLeafChosen || composeBusy || composePendingVideos.length > 0}
            >
              {composeSaving ? (
                <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />
              ) : null}
              {composeSaving ? (composeSavingLabel ?? "正在创建") : "确认"}
            </Button>
          </>
        }
      >
        <CardBindForm
          idPrefix="compose"
          name={composeName}
          tree={categoryTree}
          selection={composeSelection}
          stores={stores}
          storeId={composeStoreId}
          psdFileName={composePsdFileName}
          prompts={composePrompts}
          promptId={composePromptId}
          promptRefreshBusy={composePromptRefreshBusy}
          treeBusy={treeBusy}
          disabled={composeBusy}
          onNameChange={onComposeNameChange}
          onStoreChange={onComposeStoreChange}
          onSelectL1={onSelectL1}
          onSelectL2={onSelectL2}
          onSelectType={onSelectType}
          onRefreshTree={onRefreshCategoryTree}
          onPickPsd={onPickComposePsd}
          onPromptChange={onComposePromptChange}
          onRefreshPrompts={onRefreshComposePrompts}
          onSubmitSave={() => {
            if (composePendingVideos.length > 0) return
            onSaveCompose()
          }}
          onOpenStores={onOpenStores}
        />
      </CardBindDialog>

      <ConfirmDialog
        open={pendingDeletes.length > 0}
        onOpenChange={(next) => {
          if (!next) setPendingDeletes([])
        }}
        title={
          pendingDeletes.length > 1
            ? `删除 ${pendingDeletes.length} 个上架方案？`
            : "删除上架方案？"
        }
        description={
          pendingDeletes.length === 1
            ? `将删除「${savedFormTitle(pendingDeletes[0]!)}」。此操作不可撤销。`
            : `将删除已选的 ${pendingDeletes.length} 个上架方案。此操作不可撤销。`
        }
        confirmText="删除"
        variant="destructive"
        icon={<Trash2 data-icon="inline-start" />}
        busy={busy || composeBusy}
        onConfirm={() => {
          const targets = pendingDeletes
          setPendingDeletes([])
          setSelectedIds(new Set())
          void (async () => {
            for (const target of targets) {
              await onDelete(target)
            }
          })()
        }}
      />
    </div>
  )
}

/** What a blurred price cell does with the text the operator typed. */
export type SalePriceCommitPlan =
  /** Unparseable (0, negative, garbage) → toast + keep the input + aria-invalid. */
  | { kind: "rejected" }
  /** Same as the stored value → nothing to write, clear any stale invalid mark. */
  | { kind: "unchanged" }
  /** Hand to onSave; a `false` result keeps the input and marks it invalid. */
  | { kind: "save"; value: number | null }

export function salePriceCommitPlan(
  price: string | undefined,
  raw: string,
): SalePriceCommitPlan {
  const parsed = parseSalePrice(raw)
  if (parsed === "invalid") return { kind: "rejected" }
  const current = parseSalePrice(price ?? "")
  const currentValue = current === "invalid" ? null : current
  if (parsed === currentValue) return { kind: "unchanged" }
  return { kind: "save", value: parsed }
}

function CardSalePriceCell({
  title,
  label,
  price,
  disabled,
  saving,
  onSave,
}: {
  title: string
  /** 销售价 / 划线价 — which default price field this input owns. */
  label: string
  price?: string
  disabled: boolean
  saving: boolean
  onSave: (price: number | null) => Promise<boolean | undefined>
}) {
  const [draft, setDraft] = useState(price ?? "")
  const [focused, setFocused] = useState(false)
  // A failed commit keeps the operator's text on screen with aria-invalid
  // (the reason rides a toast, never the DOM); Escape or a successful write
  // clears it. Until then the stored price must not overwrite the input.
  const [invalid, setInvalid] = useState(false)
  const skipCommit = useRef(false)

  useEffect(() => {
    if (!focused && !invalid) setDraft(price ?? "")
  }, [price, focused, invalid])

  async function commit(raw: string) {
    const plan = salePriceCommitPlan(price, raw)
    if (plan.kind === "rejected") {
      notifyError(`请输入有效的${label}。`)
      setInvalid(true)
      return
    }
    if (plan.kind === "unchanged") {
      setInvalid(false)
      return
    }
    const saved = await onSave(plan.value)
    setInvalid(saved === false)
  }

  return (
    <Input
      aria-label={`${label} ${title}`}
      aria-invalid={invalid || undefined}
      inputMode="decimal"
      placeholder="—"
      title={`写入上架方案默认字段的${label}`}
      value={focused || invalid ? draft : (price ?? "")}
      disabled={disabled || saving}
      className="h-8 w-full text-right font-mono text-sm tabular-nums"
      onFocus={() => {
        setFocused(true)
        // While invalid, refocusing edits the retained text instead of
        // reseeding from the stored value the save refused.
        if (!invalid) setDraft(price ?? "")
      }}
      onBlur={() => {
        if (skipCommit.current) {
          skipCommit.current = false
          setDraft(price ?? "")
          setInvalid(false)
          setFocused(false)
          return
        }
        // Focus (and the draft's display priority) is held until the save
        // resolves, so a rejection never flashes the stored value first.
        void commit(draft).finally(() => setFocused(false))
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === "Escape") {
          skipCommit.current = true
          setDraft(price ?? "")
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function ListingCardActions({
  title,
  supplierBound = false,
  unavailable = false,
  busy,
  uploading = false,
  dimmed,
  copying,
  onRun,
  onCopy,
  onDelete,
}: {
  title: string
  supplierBound?: boolean
  unavailable?: boolean
  busy: boolean
  /** Background video uploads lock 复制/删除 but leave 上架 usable. */
  uploading?: boolean
  dimmed: boolean
  copying: boolean
  onRun: () => void
  onCopy: () => void
  onDelete: () => void
}) {
  const runDisabled = busy || dimmed
  const disabled = runDisabled || uploading

  return (
    <div className="inline-flex items-center justify-end gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={runDisabled || unavailable}
              aria-label={`上架 ${title}`}
              onClick={onRun}
            />
          }
        >
          <Send data-icon="inline-start" aria-hidden />
          上架
        </TooltipTrigger>
        <TooltipContent>{`上架 ${title}`}</TooltipContent>
      </Tooltip>
      {!supplierBound ? <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              aria-label={copying ? `正在复制 ${title}` : `复制 ${title}`}
              onClick={onCopy}
            />
          }
        >
          {copying ? (
            <Spinner className="size-3.5" role="presentation" aria-hidden="true" />
          ) : (
            <Copy aria-hidden />
          )}
        </TooltipTrigger>
        <TooltipContent>{copying ? "正在复制" : `复制 ${title}`}</TooltipContent>
      </Tooltip> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`删除 ${title}`}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            />
          }
        >
          <Trash2 aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{`删除 ${title}`}</TooltipContent>
      </Tooltip>
    </div>
  )
}
