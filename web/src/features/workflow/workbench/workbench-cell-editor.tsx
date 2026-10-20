import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { WorkflowDraftValue } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { refreshBannedTags } from "@/lib/banned-tags"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { ClampedTextTooltip } from "./clamped-text-tooltip"
import { FieldSourceMarker, type FieldLayerView } from "./field-source-marker"
import { parseSalePrice } from "../sale-price"
import {
  cellEditKey,
  displayedCellValue,
  planProseColumnFill,
  proseSkipCopy,
  type ProseScopeRow,
} from "./workbench-cell-edit"
import {
  PROSE_EDITOR,
  ProseDraftValidation,
  type WorkbenchEditableColumn,
} from "./workbench-prose-spec"

export {
  PROSE_EDITOR,
  ProseDraftValidation,
  validateRichContentJson,
  type WorkbenchEditableColumn,
} from "./workbench-prose-spec"

export type WorkbenchProseEdit = {
  draftId: string
  column: WorkbenchEditableColumn
  imageName: string
  value: string
}

export type WorkbenchProseScope = {
  selected: boolean
  rows: ProseScopeRow[]
}

const PREVIEW =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-start rounded-md border border-transparent px-2 py-1 text-left text-compact leading-5 transition-colors hover:border-input hover:bg-card focus-visible:border-ring focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

export function WorkbenchCellPreview({
  value,
  disabled,
  placeholder,
  ariaLabel,
  onOpen,
  sourceLayer,
}: {
  value: string
  disabled?: boolean
  placeholder?: string
  ariaLabel: string
  onOpen: () => void
  /** The layer that built this cell's value, when the row carries evidence. */
  sourceLayer?: FieldLayerView
}) {
  const marker = sourceLayer ? <FieldSourceMarker layer={sourceLayer} /> : null
  if (disabled) {
    return (
      <p
        aria-label={ariaLabel}
        className="flex min-w-0 items-start text-compact leading-5 text-foreground"
      >
        {marker}
        <ClampedTextTooltip text={value}>
          <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">
            {value || <span className="text-muted-foreground/60">{placeholder}</span>}
          </span>
        </ClampedTextTooltip>
      </p>
    )
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={PREVIEW}
      onClick={onOpen}
    >
      {marker}
      <ClampedTextTooltip text={value}>
        <span className={`line-clamp-3 min-w-0 whitespace-pre-wrap break-words ${value ? "wf-fade-in" : ""}`}>
          {value || <span className="text-muted-foreground/60">{placeholder}</span>}
        </span>
      </ClampedTextTooltip>
    </button>
  )
}

export function WorkbenchProseEditor({
  edit,
  scope,
  onClose,
  onCommit,
  onCommitColumn,
}: {
  edit: WorkbenchProseEdit | null
  scope: WorkbenchProseScope
  onClose: () => void
  onCommit: (edit: WorkbenchProseEdit, value: string) => void
  onCommitColumn: (edit: WorkbenchProseEdit, value: string, draftIds: string[]) => void
}) {
  const [draft, setDraft] = useState(edit?.value ?? "")
  const [overwrite, setOverwrite] = useState(false)
  const [rulesTick, setRulesTick] = useState(0)
  const sessionRef = useRef(edit)
  const settledRef = useRef(false)
  sessionRef.current = edit

  useEffect(() => {
    if (!edit) return
    settledRef.current = false
    setDraft(edit.value)
    setOverwrite(false)
  }, [edit])

  useEffect(() => {
    if (edit?.column !== "tags") return
    let cancelled = false
    void refreshBannedTags()
      .then(() => {
        if (!cancelled) setRulesTick((tick) => tick + 1)
      })
      .catch((reason) => {
        if (!cancelled) notifyCommandError(reason, "无法读取受限标签。")
      })
    return () => {
      cancelled = true
    }
  }, [edit?.column, edit?.draftId])

  const spec = edit ? PROSE_EDITOR[edit.column] : PROSE_EDITOR.name
  const shown = displayedCellValue(Boolean(edit), draft, edit?.value ?? "")
  /** 实时格式校验（目前只有 rich_content 配了 validate）：非 null 时阻断提交。 */
  const draftError = useMemo(
    () => (edit ? (PROSE_EDITOR[edit.column].validate?.(draft) ?? null) : null),
    [edit, draft, rulesTick],
  )
  const validationId = useId()
  const blocked = draftError !== null
  const plan = useMemo(
    () =>
      planProseColumnFill({
        selected: scope.selected,
        openedDraftId: edit?.draftId ?? "",
        emptyOnly: !overwrite,
        rows: scope.rows,
      }),
    [edit?.draftId, overwrite, scope],
  )
  const skipLine = proseSkipCopy(plan.skip)
  const emptyBlocked = plan.writeDraftIds.length === 0 && !overwrite
  const showColumnFill = Boolean(edit) && !plan.sameAsOpened

  function finish(commitOpened: boolean) {
    if (settledRef.current) return
    if (commitOpened && blocked) return
    settledRef.current = true
    const session = sessionRef.current
    if (commitOpened && session && draft !== session.value) {
      onCommit(session, draft)
    }
    onClose()
  }

  function fillColumn() {
    if (settledRef.current || plan.writeDraftIds.length === 0 || blocked) return
    settledRef.current = true
    const session = sessionRef.current
    if (session) onCommitColumn(session, draft, plan.writeDraftIds)
    onClose()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    // 单行值里 Enter 就是保存；textarea 里 Enter 换行，⌘/Ctrl+Enter 才提交。
    const action = cellEditKey(event.key, {
      multiline: !spec.singleLine,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    })
    if (action === "cancel") {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
      return
    }
    if (action === "commit") {
      event.preventDefault()
      finish(true)
    }
  }

  return (
    <Dialog
      open={edit !== null}
      onOpenChange={(open) => {
        if (!open) finish(false)
      }}
    >
      {/* 散文列可长可短：弹窗封顶并可整体滚动，文本框 field-sizing-content
          只长到 max-h 就在框内滚动 —— 保存 / 填入按钮永远留在视口里。
          rich_content 的宽弹窗 + 高文本框尺寸在 PROSE_EDITOR 规格里，
          与 card-defaults 弹窗同源；散文默认值必须写死字面量（shadcn 静态检查）。 */}
      <DialogContent
        // 尺寸规格来自 PROSE_EDITOR（rich_content 覆盖），字面量只是散文默认；
        // 类名按设计是规格驱动的，静态检查在此让位。
        className={
          // eslint-disable-next-line shadcn/require-static-classes
          spec.dialogClassName ??
          "max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-xl"
        }
      >
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>
            {edit ? `正在编辑 ${edit.imageName}` : "商品文案"}
          </DialogDescription>
        </DialogHeader>
        {edit && spec.singleLine ? (
          <Input
            autoFocus
            value={shown}
            placeholder={spec.placeholder}
            aria-label={spec.ariaLabel(edit.imageName)}
            aria-invalid={blocked || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : edit ? (
          <Textarea
            autoFocus
            value={shown}
            placeholder={spec.placeholder}
            aria-label={spec.ariaLabel(edit.imageName)}
            aria-invalid={blocked || undefined}
            aria-describedby={
              (edit?.column === "rich_content" && spec.validate && draft.trim()) ||
              (edit?.column === "tags" && draftError)
                ? validationId
                : undefined
            }
            rows={spec.rows}
            // 默认字面量 + PROSE_EDITOR 规格覆盖（rich_content 更高的文本框，
            // 尺寸与 PROSE_EDITOR 同源），动态组合是设计。
            className={cn(
              "min-h-24 max-h-72 overflow-y-auto text-compact leading-5",
              // eslint-disable-next-line shadcn/require-static-classes
              spec.textareaClassName,
            )}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : null}
        {edit?.column === "rich_content" && spec.validate ? (
          <ProseDraftValidation
            id={validationId}
            filled={Boolean(edit) && draft.trim().length > 0}
            error={draftError}
          />
        ) : null}
        {edit?.column === "tags" && draftError ? (
          <p id={validationId} className="text-meta text-destructive">
            {`✗ ${draftError}`}
          </p>
        ) : null}
        {showColumnFill ? (
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="prose-overwrite"
              className="text-compact leading-5 text-foreground"
            >
              覆盖已有内容
            </label>
            <Switch
              id="prose-overwrite"
              size="sm"
              checked={overwrite}
              onCheckedChange={setOverwrite}
              aria-label="覆盖已有内容"
            />
          </div>
        ) : null}
        {skipLine || emptyBlocked ? (
          <p className="text-compact leading-5 text-muted-foreground">
            {emptyBlocked && !skipLine ? "没有可填的空格" : skipLine}
          </p>
        ) : null}
        <p className="text-meta text-muted-foreground">
          {showColumnFill
            ? "⌘/Ctrl+Enter 只改这一格 · Esc 取消"
            : "⌘/Ctrl+Enter 保存 · Esc 取消"}
        </p>
        <DialogFooter className="gap-2 sm:gap-2">
          {showColumnFill ? (
            <Button
              type="button"
              variant="outline"
              disabled={plan.writeDraftIds.length === 0 || blocked}
              aria-label={
                emptyBlocked
                  ? "没有可填的空格"
                  : `填入 ${plan.writeDraftIds.length} 行`
              }
              onClick={fillColumn}
            >
              {emptyBlocked
                ? "没有可填的空格"
                : `填入 ${plan.writeDraftIds.length} 行`}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            disabled={blocked}
            onClick={() => finish(true)}
          >
            {showColumnFill ? "只改这一格" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 销售价 / 划线价的格子。与散文格不同，它在格子里直接改：价格是竖着打的，
 * 同键的默认字段是这一行留空时继承的兜底 —— 兜底值就是灰色的占位文本本身，
 * 不带「默认」前缀；「留空即按方案默认发送」的语义交给 title 提示承担。
 *
 * 无效数字走 notifyError 并回落到已存值；有效值以 decimal 写进这一行的 Draft，
 * 这正是发送时 `handEditedKeys` 让行内价胜过卡默认的依据。
 */
export function WorkbenchPriceCell({
  value,
  fallback,
  disabled,
  label,
  ariaLabel,
  onCommit,
  sourceLayer,
}: {
  /** 本行自己的值（文本）；空 = 沿用默认字段。 */
  value: string
  /** 默认字段里给没打过的行兜底的值。 */
  fallback?: string
  disabled?: boolean
  /** 无效提示里的字段名 —— 销售价 / 划线价。 */
  label: string
  ariaLabel: string
  onCommit: (value: WorkflowDraftValue | undefined) => void
  /** The layer that built this cell's value, when the row carries evidence. */
  sourceLayer?: FieldLayerView
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const revertRef = useRef(false)

  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])

  function commit(raw: string) {
    const parsed = parseSalePrice(raw)
    if (parsed === "invalid") {
      notifyError(`请输入有效的${label}。`)
      setDraft(value)
      return
    }
    const current = parseSalePrice(value)
    if (parsed === (current === "invalid" ? null : current)) return
    onCommit(parsed === null ? undefined : { kind: "decimal", value: parsed })
  }

  return (
    <span className="flex min-w-0 items-center">
      {sourceLayer ? <FieldSourceMarker layer={sourceLayer} /> : null}
      <Input
        aria-label={ariaLabel}
        inputMode="decimal"
        placeholder={fallback ? fallback : "—"}
        title={
          fallback ? `留空将按方案默认${label} ${fallback} 发送` : undefined
        }
        value={focused ? draft : value}
        disabled={disabled}
        className="h-8 w-full min-w-0 flex-1 text-right font-mono text-compact tabular-nums"
      onFocus={() => {
        setFocused(true)
        setDraft(value)
      }}
      onBlur={() => {
        setFocused(false)
        if (revertRef.current) {
          revertRef.current = false
          setDraft(value)
          return
        }
        commit(draft)
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          revertRef.current = true
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
      />
    </span>
  )
}
