import type { RefObject } from "react"
import { FileUp, Save } from "lucide-react"

import type { SupplierPrompt } from "@/bindings/http-supplier-dbs"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { categoryPathLabel } from "@/features/category-schema/category-tree"
import { notifyCommandError } from "@/lib/notify"
import { FIXED_TAGS_MAX } from "@/lib/fixed-tags"
import { cn } from "@/lib/utils"

export type SupplierPromptDraft = {
  promptName: string
  promptFileName: string
  promptContent: string
  fixedTags: string
}

export function SupplierPromptEditDialog({
  editing,
  draft,
  tree,
  busy,
  fileRef,
  accept,
  tagsInvalid,
  tagCount,
  ready,
  onOpenChange,
  onDraftChange,
  onSave,
  onReadFile,
}: {
  editing: SupplierPrompt | undefined
  draft: SupplierPromptDraft | undefined
  tree: CategoryTreeNodeView[]
  busy: boolean
  fileRef: RefObject<HTMLInputElement | null>
  accept: string
  tagsInvalid: boolean
  tagCount: number
  ready: boolean
  onOpenChange: (open: boolean) => void
  onDraftChange: (draft: SupplierPromptDraft) => void
  onSave: () => void
  onReadFile: (file: File) => Promise<{ fileName: string; content: string }>
}) {
  return (
    <PlatformAdminDialog
      open={Boolean(editing && draft)}
      onOpenChange={onOpenChange}
      title="编辑供应商提示词"
      description="保存后先成为草稿；发布后新建的识图作业才会读到这一版。类目保持不变。"
      width="sm:max-w-2xl"
      footer={<>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button type="button" disabled={busy || !ready} onClick={onSave}>{busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存草稿</Button>
      </>}
    >
      {editing && draft ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="p-5"><FieldGroup className="gap-4">
            <div className="border-b border-border pb-3">
              <p className="text-sm font-medium">{categoryPathLabel(editing.descriptionCategoryId, editing.typeId, tree)}</p>
              <p className="mt-1 text-xs text-muted-foreground">类目由供应商商品管理；此处不可移动。</p>
            </div>
            <Field>
              <FieldLabel>替换提示词文件</FieldLabel>
              <input ref={fileRef} type="file" accept={accept} className="hidden" onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (!file) return
                void onReadFile(file).then(({ fileName, content }) => onDraftChange({
                  ...draft,
                  promptFileName: fileName,
                  promptContent: content,
                  promptName: draft.promptName || fileName.replace(/\.[^.]+$/, ""),
                })).catch((reason) => notifyCommandError(reason, "无法读取提示词文件。"))
              }} />
              <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><FileUp data-icon="inline-start" />{draft.promptFileName || "选择 .md / .txt"}</Button>
            </Field>
            <Field>
              <FieldLabel htmlFor="supplier-prompt-name">名称</FieldLabel>
              <Input id="supplier-prompt-name" value={draft.promptName} disabled={busy} onChange={(event) => onDraftChange({ ...draft, promptName: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="supplier-prompt-content">商品说明（六行俄文）</FieldLabel>
              <Textarea id="supplier-prompt-content" value={draft.promptContent} disabled={busy} onChange={(event) => onDraftChange({ ...draft, promptContent: event.target.value })} className="min-h-40 font-mono" />
            </Field>
            <Field>
              <FieldLabel htmlFor="supplier-prompt-tags">固定标签（每行一个 # 开头的俄语词，1–25 个）</FieldLabel>
              <Textarea id="supplier-prompt-tags" value={draft.fixedTags} disabled={busy} aria-invalid={tagsInvalid || undefined} onChange={(event) => onDraftChange({ ...draft, fixedTags: event.target.value })} className="min-h-24 font-mono" />
              <p className={cn("text-meta", tagsInvalid ? "text-st-bad" : "text-faint-foreground")}>已填写 {tagCount} / {FIXED_TAGS_MAX}</p>
            </Field>
          </FieldGroup></div>
        </div>
      ) : null}
    </PlatformAdminDialog>
  )
}
