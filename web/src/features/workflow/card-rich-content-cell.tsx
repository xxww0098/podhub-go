import { useId, useRef, useState } from "react"
import type { CategoryFieldView, CategorySchemaView, ListingCardSummary, WorkflowDraftValue } from "@/bindings/commands"
import { draftAttributeValue } from "@/bindings/listing-projection"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { WorkbenchCellPreview } from "./workbench/workbench-cell-editor"
import { valueAsText } from "./workflow-draft"
import { commandError, fieldByAttributeId, RICH_CONTENT_ATTRIBUTE_ID, savedFormTitle } from "./workflow-shared"

export function richContentError(raw: string): string | null {
  if (!raw.trim()) return null
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? null
      : "富内容必须是 JSON 对象。"
  } catch {
    return "JSON 格式无效，请检查引号、逗号和括号。"
  }
}

export function CardRichContentCell({ form, disabled, onLoadSchema, onSave }: {
  form: ListingCardSummary
  disabled: boolean
  onLoadSchema: (form: ListingCardSummary) => Promise<CategorySchemaView>
  onSave: (form: ListingCardSummary, fieldKey: string, value: WorkflowDraftValue | undefined) => Promise<boolean | undefined>
}) {
  const title = savedFormTitle(form)
  const current = valueAsText(draftAttributeValue(form.defaults, RICH_CONTENT_ATTRIBUTE_ID, "rich_content"))
  const [field, setField] = useState<CategoryFieldView>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState("")
  const [initial, setInitial] = useState("")
  const [saveError, setSaveError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const errorId = useId()
  const validation = richContentError(draft)
  const error = validation ?? saveError

  async function open() {
    setLoading(true)
    try {
      const schema = await onLoadSchema(form)
      const found = fieldByAttributeId(schema, RICH_CONTENT_ATTRIBUTE_ID)
      if (!found) {
        notifyError("当前类目无 JSON 富内容属性。")
        return
      }
      const value = valueAsText(form.defaults?.values[found.key])
      setDraft(value)
      setInitial(value)
      setSaveError(null)
      setField(found)
    } catch (reason) {
      notifyCommandError(reason, "无法读取类目字段，请重试。")
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!field || validation || disabled || savingRef.current) return
    const value = draft.trim()
    if (value === initial.trim()) {
      setField(undefined)
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await onSave(form, field.key, value ? { kind: "text", value } : undefined)
      if (saved === true) setField(undefined)
      else setSaveError(saved === false ? "保存失败，请重试。" : "方案正在处理其他操作，请稍后重试。")
    } catch (reason) {
      setSaveError(commandError(reason, "无法保存 JSON 富内容，请重试。"))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <>
    <WorkbenchCellPreview
      value={loading ? "正在读取…" : current.trim() ? "已填写" : ""}
      disabled={disabled || loading}
      placeholder="粘贴 JSON 富内容"
      ariaLabel={`JSON富内容 ${title}`}
      onOpen={() => void open()}
    />
    <Dialog open={Boolean(field)} onOpenChange={(next) => { if (!next && !savingRef.current) setField(undefined) }}>
      <DialogContent layout="panel" className="sm:max-w-3xl" showCloseButton={!saving} aria-busy={saving || undefined}>
        <DialogHeader variant="panel">
          <DialogTitle>JSON富内容</DialogTitle>
          <DialogDescription className="break-words">写入「{title}」的默认字段，新建商品继承此内容。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Textarea
            aria-label="JSON富内容"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder="粘贴 JSON 富内容"
            value={draft}
            disabled={saving}
            spellCheck={false}
            rows={14}
            className="min-h-48 max-h-[55dvh] resize-y"
            onChange={(event) => { setDraft(event.target.value); setSaveError(null) }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void save()
              }
            }}
          />
          {error ? <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p> : null}
          <p className="text-xs text-muted-foreground">⌘/Ctrl+Enter 保存 · Esc 取消</p>
        </DialogBody>
        <DialogFooter variant="panel">
          <Button type="button" variant="outline" disabled={saving} onClick={() => setField(undefined)}>取消</Button>
          <Button type="button" disabled={saving || disabled || Boolean(validation)} onClick={() => void save()}>
            {saving ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            {saving ? "正在保存" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
