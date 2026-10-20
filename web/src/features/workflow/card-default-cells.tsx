/**
 * 上架方案名册里的两个 tableInput 默认列 —— 主题 / JSON富内容，与两列价格同一套
 * 「写卡默认、再回写行」契约。格子只做展示与取数；落库、回写行与通知由
 * card-library-host 负责（同 saveDefaultPrice）。
 *
 * 主题的字典选择器复用默认字段表单那一个（DictionaryPickerDialog）；富内容用
 * 自己的粘贴弹窗（JSON 是竖着贴的，名册里没有散文格的「填入 N 行」语义）。
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  PROSE_EDITOR,
  ProseDraftValidation,
  WorkbenchCellPreview,
  validateRichContentJson,
} from "./workbench/workbench-cell-editor"
import { cellEditKey } from "./workbench/workbench-cell-edit"

export function CardThemeCell({
  title,
  value,
  disabled,
  unsupported = false,
  onOpen,
}: {
  title: string
  value: string
  disabled: boolean
  unsupported?: boolean
  onOpen: () => void
}) {
  return (
    <WorkbenchCellPreview
      value={unsupported ? "" : value}
      disabled={disabled}
      placeholder={unsupported ? "当前类目无主题属性" : "从 Ozon 字典选择主题"}
      ariaLabel={`主题 ${title}`}
      onOpen={onOpen}
    />
  )
}

export function CardRichContentCell({
  title,
  value,
  disabled,
  onOpen,
}: {
  title: string
  value: string
  disabled: boolean
  onOpen: () => void
}) {
  return (
    <WorkbenchCellPreview
      value={value}
      disabled={disabled}
      placeholder={PROSE_EDITOR.rich_content.placeholder}
      ariaLabel={`JSON富内容 ${title}`}
      onOpen={onOpen}
    />
  )
}

/**
 * 名册的 JSON富内容弹窗：从卡默认起稿，保存即写卡默认（随后回写行）。
 * Escape / 遮罩取消；⌘/Ctrl+Enter 提交。编辑时逐键校验 JSON，非法即阻断
 * 保存（Ozon 到发送才拒绝，这里提前拦）。错误由宿主 notify，不在弹窗里渲染。
 */
export function CardRichContentDialog({
  open,
  title,
  value,
  onClose,
  onSave,
}: {
  open: boolean
  title: string
  value: string
  onClose: () => void
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const spec = PROSE_EDITOR.rich_content

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  /** 空草稿 = 清除默认，合法；非空必须是合法 JSON。 */
  const draftError = validateRichContentJson(draft)
  const blocked = draftError !== null
  const validationId = useId()

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const action = cellEditKey(event.key, {
      multiline: true,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    })
    if (action === "cancel") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (action === "commit") {
      event.preventDefault()
      if (!blocked) onSave(draft)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      {/* 富内容是整份竖排 JSON：弹窗放宽、文本框 field-sizing-content 长到
          max-h-112 就在框内滚动，弹窗整体封顶可滚 —— 保存按钮永远留在视口里。 */}
      <DialogContent className={spec.dialogClassName}>
        <DialogHeader>
          <DialogTitle>JSON富内容</DialogTitle>
          <DialogDescription>
            写入「{title}」的默认字段；该方案新建的商品行继承这份富内容。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={draft}
          placeholder={spec.placeholder}
          aria-label={`JSON富内容 ${title}`}
          aria-invalid={blocked || undefined}
          aria-describedby={draft.trim() ? validationId : undefined}
          rows={spec.rows}
          className={cn(
            "overflow-y-auto text-compact leading-5",
            spec.textareaClassName,
          )}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ProseDraftValidation
          id={validationId}
          filled={draft.trim().length > 0}
          error={draftError}
        />
        <p className="text-meta text-muted-foreground">
          ⌘/Ctrl+Enter 保存 · Esc 取消
        </p>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={blocked}
            onClick={() => onSave(draft)}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
