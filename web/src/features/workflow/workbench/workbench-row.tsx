import { memo } from "react"
import type { CategoryFieldView, WorkflowDraftView } from "@/bindings/commands"
import { SaveStateChip, type SaveState } from "@/components/save-state-chip"
import { Checkbox } from "@/components/ui/checkbox"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { ListingRow } from "../model/listing-row"
import { proseCellSkip } from "../model/listing-row-lifecycle"
import { useSourcePreview } from "../media/rendered-image"
import { ThumbPreview } from "../media/thumb-preview"
import { mediaRetry } from "../prepare/preparation-branches"
import { storeToneStyle, type StoreTone } from "../store-tone"
import {
  fieldDisplayValueAsText,
  readWorkflowValue,
  valueAsText,
} from "../workflow-draft"
import { fieldLocation } from "../workflow-shared"
import { FieldSourceMarker } from "./field-source-marker"
import { sourceFileStem } from "./workbench-model"
import { useInTableView } from "./table-row-visibility"
import {
  PROSE_EDITOR,
  WorkbenchCellPreview,
  WorkbenchPriceCell,
  type WorkbenchEditableColumn,
} from "./workbench-cell-editor"
import { MEDIA_ROLE_COLUMNS } from "./workbench-columns"
import {
  proseCellText,
  type WorkbenchColumnFields,
  type WorkbenchRowActions,
} from "./workbench-contract"
import { colIndexFor, typedCellRawValue } from "./workbench-grid-navigation"
import { MediaRoleCell } from "./workbench-media-cell"
import { PublishStateCell } from "./workbench-publish-state-cell"
import { cellClass } from "./workbench-table-classes"

export const WorkbenchRow = memo(function WorkbenchRow({
  row,
  index,
  selected,
  product,
  saveState,
  fields,
  actions,
  brandRepairable,
  rowStoreLabel,
  storeTone,
  cardPrice,
  cardOldPrice,
  cardTheme,
  cardRichContent,
  activeColIndex,
  ripplingCells,
}: {
  row: ListingRow
  index: number
  selected: boolean
  product?: WorkflowDraftView
  saveState: SaveState
  fields: WorkbenchColumnFields
  actions: WorkbenchRowActions
  brandRepairable: boolean
  rowStoreLabel?: string
  storeTone?: StoreTone
  /** 卡默认字段里的两个价格：本行留空时继承的兜底，只作占位提示。 */
  cardPrice: string
  cardOldPrice: string
  /** 卡默认里的 主题 / JSON富内容 —— 与两列价格同一套 tableInput 兜底。 */
  cardTheme: string
  cardRichContent: string
  activeColIndex: number | null
  ripplingCells: ReadonlySet<string>
}) {
  const lifecycle = product?.lifecycle
  const draft = product?.draft
  const editable = proseCellSkip(row, product) === null
  const tags = proseCellText("tags", product, fields)
  const priceField = fields.price
  const oldPriceField = fields.oldPrice
  const stickyTint = storeTone
    ? "store-assignment-cell"
    : selected
      ? "bg-brand-soft"
      : "bg-card group-hover:bg-muted"

  const { rowRef, inView } = useInTableView()
  const sourcePreview = useSourcePreview(row.source?.handle, inView)
  const sourceUrl = row.previewUrl ?? sourcePreview

  const readCell = (field: CategoryFieldView | undefined) => {
    if (!draft || !field) return ""
    return valueAsText(readWorkflowValue(draft, field.key, fieldLocation(field)))
  }
  /**
   * `seed_gaps` bakes card defaults into a row at creation; those copies are
   * not the operator's own answer. A 逐行输入 cell therefore shows the typed
   * value only for keys `handEditedKeys` marks — untouched rows render the
   * current card default as the fallback placeholder, so a card-side edit is
   * what the table shows the moment the card changes. A cleared key stays
   * empty and loses the fallback: the send overlay keeps it cleared.
   */
  const cleared = draft?.cleared
  const cellCleared = (field: CategoryFieldView | undefined) =>
    Boolean(field && cleared?.includes(field.key))
  /** 本行手改过的值 —— 未手改或已清空返回 undefined，与四个 tableInput 格子同一口径。 */
  const typedCellValue = (field: CategoryFieldView | undefined) =>
    product && field ? typedCellRawValue(product, field) : undefined
  const typedCell = (field: CategoryFieldView | undefined) =>
    valueAsText(typedCellValue(field))
  const offerId = draft ? valueAsText(draft.values.offer_id) : ""
  const openProse = (column: WorkbenchEditableColumn, value: string) =>
    actions.openProse({
      draftId: row.draftId,
      column,
      imageName: row.imageName,
      value,
    })

  return (
    <TableRow
      ref={rowRef}
      data-row-index={index}
      data-state={selected ? "selected" : undefined}
      style={storeToneStyle(storeTone)}
      // Sticky cells need an opaque fill so scrolled values never show through.
      // Selection strengthens the same Store tone instead of replacing its identity.
      className={cn(
        "group h-20 cursor-pointer align-top",
        storeTone
          ? "store-assignment-row"
          : "hover:bg-muted/45 data-[state=selected]:bg-brand-soft/45",
      )}
    >
      <TableCell
        className={cellClass("select", stickyTint, activeColIndex === 0, ripplingCells.has(`${row.draftId}:select`))}
        onClick={() => actions.focusCell(index, 0)}
        onPointerDownCapture={(event) => actions.armShift(event.shiftKey)}
        onKeyDownCapture={(event) => actions.armShift(event.shiftKey)}
      >
        <Checkbox
          aria-label={`选择 ${row.imageName}`}
          checked={selected}
          onCheckedChange={(checked) => actions.toggle(index, checked === true)}
        />
      </TableCell>
      <TableCell
        className={cellClass("source", stickyTint, activeColIndex === 1, ripplingCells.has(`${row.draftId}:source`))}
        onClick={() => actions.focusCell(index, 1)}
      >
        {sourceUrl ? (
          <ThumbPreview src={sourceUrl} alt={row.imageName} />
        ) : (
          <span className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-muted text-meta text-muted-foreground">
            图
          </span>
        )}
      </TableCell>
      <TableCell
        className={cellClass("publish_state", stickyTint, activeColIndex === 2, ripplingCells.has(`${row.draftId}:publish_state`))}
        onClick={() => actions.focusCell(index, 2)}
      >
        <PublishStateCell
          row={row}
          inView={inView}
          lifecycle={lifecycle}
          rowStoreLabel={rowStoreLabel}
          storeTone={storeTone}
          onCancelIntent={() => actions.cancelIntent(row.draftId)}
          onReviewCandidates={() => actions.reviewCandidates(row)}
          onRetryStage={(verb) => actions.retryStage(row.id, verb)}
          onRepairBrand={brandRepairable ? () => actions.repairBrand(row.id) : undefined}
        />
      </TableCell>
      <TableCell
        className={cellClass("name", undefined, activeColIndex === 3, ripplingCells.has(`${row.draftId}:name`))}
        onClick={() => actions.focusCell(index, 3)}
      >
        <WorkbenchCellPreview
          value={readCell(fields.name)}
          disabled={!editable}
          placeholder={
            lifecycle?.ai === "running"
              ? "AI 正在生成商品名称…"
              : lifecycle?.ai === "ready"
                ? PROSE_EDITOR.name.placeholder
                : "等待 AI 识别…"
          }
          ariaLabel={PROSE_EDITOR.name.ariaLabel(row.imageName)}
          onOpen={() => openProse("name", readCell(fields.name))}
          sourceLayer={fields.name ? row.sourceLayers?.[fields.name.key] : undefined}
        />
        {saveState !== "idle" ? (
          <span className="mt-1 flex">
            <SaveStateChip
              state={saveState}
              onRetry={() => actions.retrySave(row.draftId)}
            />
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className={cellClass("offer_id", undefined, activeColIndex === 4, ripplingCells.has(`${row.draftId}:offer_id`))}
        onClick={() => actions.focusCell(index, 4)}
      >
        {/* 货号 is the definite instance identity, and Rust re-injects the
            source file stem into it before every publish — typing over it here
            would be a lie. 型号 is the operator's own answer and has its own
            cell next door. */}
        <span
          aria-label={`货号 ${row.imageName}`}
          className="flex min-w-0 items-start"
        >
          {row.sourceLayers?.offer_id ? <FieldSourceMarker layer={row.sourceLayers.offer_id} /> : null}
          <span className="min-w-0 break-all font-mono text-compact">
            {offerId || sourceFileStem(row.imageName)}
          </span>
        </span>
      </TableCell>
      <TableCell
        className={cellClass("model", undefined, activeColIndex === colIndexFor("model"), ripplingCells.has(`${row.draftId}:model`))}
        onClick={() => actions.focusCell(index, colIndexFor("model"))}
      >
        {fields.model ? (
          <WorkbenchCellPreview
            value={readCell(fields.model)}
            disabled={!editable}
            // The pipeline fills a blank 型号 from the source file name, so an
            // untouched row shows that stem as its fallback — the same value
            // the build would send, in the muted tone of every inherited cell.
            placeholder={sourceFileStem(row.imageName) || PROSE_EDITOR.model.placeholder}
            ariaLabel={PROSE_EDITOR.model.ariaLabel(row.imageName)}
            onOpen={() => openProse("model", readCell(fields.model))}
            sourceLayer={row.sourceLayers?.[fields.model.key]}
          />
        ) : (
          <span className="text-compact text-muted-foreground/60">当前类目无型号属性</span>
        )}
      </TableCell>
      <TableCell
        className={cellClass("price", undefined, activeColIndex === colIndexFor("price"), ripplingCells.has(`${row.draftId}:price`))}
        onClick={() => actions.focusCell(index, colIndexFor("price"))}
      >
        {priceField ? (
          <WorkbenchPriceCell
            value={typedCell(priceField)}
            fallback={cellCleared(priceField) ? undefined : cardPrice}
            disabled={!editable}
            label="销售价"
            ariaLabel={`销售价 ${row.imageName}`}
            onCommit={(value) =>
              actions.editField(row.draftId, priceField.key, value, fieldLocation(priceField))
            }
            sourceLayer={row.sourceLayers?.[priceField.key]}
          />
        ) : (
          <span className="text-compact text-muted-foreground/60">当前类目无销售价</span>
        )}
      </TableCell>
      <TableCell
        className={cellClass("old_price", undefined, activeColIndex === colIndexFor("old_price"), ripplingCells.has(`${row.draftId}:old_price`))}
        onClick={() => actions.focusCell(index, colIndexFor("old_price"))}
      >
        {oldPriceField ? (
          <WorkbenchPriceCell
            value={typedCell(oldPriceField)}
            fallback={cellCleared(oldPriceField) ? undefined : cardOldPrice}
            disabled={!editable}
            label="划线价"
            ariaLabel={`划线价 ${row.imageName}`}
            onCommit={(value) =>
              actions.editField(row.draftId, oldPriceField.key, value, fieldLocation(oldPriceField))
            }
            sourceLayer={row.sourceLayers?.[oldPriceField.key]}
          />
        ) : (
          <span className="text-compact text-muted-foreground/60">当前类目无划线价</span>
        )}
      </TableCell>
      <TableCell
        className={cellClass("description", undefined, activeColIndex === colIndexFor("description"), ripplingCells.has(`${row.draftId}:description`))}
        onClick={() => actions.focusCell(index, colIndexFor("description"))}
      >
        {fields.description ? (
          <WorkbenchCellPreview
            value={readCell(fields.description)}
            disabled={!editable}
            placeholder={PROSE_EDITOR.description.placeholder}
            ariaLabel={PROSE_EDITOR.description.ariaLabel(row.imageName)}
            onOpen={() => openProse("description", readCell(fields.description))}
            sourceLayer={row.sourceLayers?.[fields.description.key]}
          />
        ) : (
          <span className="text-compact text-muted-foreground/60">当前类目无简介属性</span>
        )}
      </TableCell>
      <TableCell
        className={cellClass("tags", undefined, activeColIndex === colIndexFor("tags"), ripplingCells.has(`${row.draftId}:tags`))}
        onClick={() => actions.focusCell(index, colIndexFor("tags"))}
      >
        <WorkbenchCellPreview
          value={tags}
          disabled={!editable}
          placeholder={PROSE_EDITOR.tags.placeholder}
          ariaLabel={PROSE_EDITOR.tags.ariaLabel(row.imageName)}
          onOpen={() => openProse("tags", tags)}
          sourceLayer={fields.tags ? row.sourceLayers?.[fields.tags.key] : undefined}
        />
      </TableCell>
      <TableCell
        className={cellClass("theme", undefined, activeColIndex === colIndexFor("theme"), ripplingCells.has(`${row.draftId}:theme`))}
        onClick={() => actions.focusCell(index, colIndexFor("theme"))}
      >
        {fields.theme ? (
          <WorkbenchCellPreview
            value={fieldDisplayValueAsText(fields.theme, typedCellValue(fields.theme))
              .split("\n")
              .filter(Boolean)
              .join("、")}
            disabled={!editable}
            placeholder={
              cellCleared(fields.theme)
                ? "从 Ozon 字典选择主题"
                : cardTheme || "从 Ozon 字典选择主题"
            }
            ariaLabel={`主题 ${row.imageName}`}
            onOpen={() => actions.openTheme({ draftId: row.draftId })}
            sourceLayer={row.sourceLayers?.[fields.theme.key]}
          />
        ) : (
          <WorkbenchCellPreview
            value=""
            disabled
            placeholder="当前类目无主题属性"
            ariaLabel={`主题 ${row.imageName}`}
            onOpen={() => {}}
          />
        )}
      </TableCell>
      <TableCell
        className={cellClass("rich_content", undefined, activeColIndex === colIndexFor("rich_content"), ripplingCells.has(`${row.draftId}:rich_content`))}
        onClick={() => actions.focusCell(index, colIndexFor("rich_content"))}
      >
        {fields.richContent ? (
          <WorkbenchCellPreview
            value={typedCell(fields.richContent)}
            disabled={!editable}
            placeholder={
              cellCleared(fields.richContent)
                ? PROSE_EDITOR.rich_content.placeholder
                : cardRichContent || PROSE_EDITOR.rich_content.placeholder
            }
            ariaLabel={PROSE_EDITOR.rich_content.ariaLabel(row.imageName)}
            onOpen={() =>
              openProse("rich_content", typedCell(fields.richContent))
            }
            sourceLayer={row.sourceLayers?.[fields.richContent.key]}
          />
        ) : (
          <span className="text-compact text-muted-foreground/60">
            当前类目无 JSON富内容属性
          </span>
        )}
      </TableCell>
      {MEDIA_ROLE_COLUMNS.map((role) => {
        const colIdx = colIndexFor(role)
        return (
          <TableCell
            key={role}
            className={cellClass(role, undefined, activeColIndex === colIdx, ripplingCells.has(`${row.draftId}:${role}`))}
            onClick={() => actions.focusCell(index, colIdx)}
          >
            <MediaRoleCell
              draftId={row.draftId}
              role={role}
              lifecycle={lifecycle}
              sourceLayer={row.sourceLayers?.[role]}
              onRetryMedia={() => actions.retryStage(row.id, mediaRetry(row.render, row.upload)?.verb ?? "deliver")}
            />
          </TableCell>
        )
      })}
    </TableRow>
  )
})
