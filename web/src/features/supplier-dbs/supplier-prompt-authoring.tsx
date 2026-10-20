/**
 * 管理员在已保存的草稿上预览拼装结果，并对照已发布版本后发布。
 * 预览只调用 compose，不发起识图、不写 ai_requests。
 */
import { useState } from "react"

import {
  supplierDbsHttp,
  type PublishSupplierPromptResult,
  type SupplierPromptDiff,
} from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

import { BRIEF_LINES } from "./brief-lines"

type AiPolicy = { title: boolean; description: boolean; tags: boolean }

export function SupplierPromptAuthoring({
  sourceId,
  productId,
  brief,
  fixedTags,
  draftRevision,
  publishedRevision,
  dirty,
  onPublished,
}: {
  sourceId: string
  productId: string
  brief: string
  fixedTags: string[]
  draftRevision?: number | null
  publishedRevision?: number | null
  dirty: boolean
  onPublished?: (published: PublishSupplierPromptResult) => void
}) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [diff, setDiff] = useState<SupplierPromptDiff | null>(null)
  const unpublished = draftRevision != null
    && publishedRevision != null
    && draftRevision > publishedRevision
  const canPreview = Boolean(brief.trim()) && !dirty && !busy

  const openPreview = async () => {
    if (!canPreview) return
    setBusy(true)
    try {
      const data = await supplierDbsHttp.supplierPromptPreview(sourceId, productId, { brief, fixedTags })
      setPreview(data.text)
    } catch (reason) {
      notifyCommandError(reason, "无法预览识图全文")
    } finally {
      setBusy(false)
    }
  }

  const openPublish = async () => {
    if (!unpublished || dirty || busy || draftRevision == null) return
    setBusy(true)
    try {
      setDiff(await supplierDbsHttp.supplierPromptDiff(sourceId, productId, draftRevision))
    } catch (reason) {
      notifyCommandError(reason, "无法读取与已发布版本的差异")
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (draftRevision == null || busy) return
    setBusy(true)
    try {
      const published = await supplierDbsHttp.supplierPromptPublish(sourceId, productId, draftRevision)
      setDiff(null)
      notifySuccess("提示词已发布", { description: "之后新建的识图作业会读这一版。" })
      onPublished?.(published)
    } catch (reason) {
      notifyCommandError(reason, "无法发布提示词")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-supplier-prompt-authoring="">
      {unpublished ? <Badge variant="brand" data-prompt-draft-badge="">未发布草稿</Badge> : null}
      <Button type="button" variant="outline" size="sm" disabled={!canPreview} data-prompt-preview=""
        onClick={() => void openPreview()}>
        {busy && preview === null && diff === null ? <Spinner data-icon="inline-start" /> : null}
        预览全文
      </Button>
      <Button type="button" size="sm" disabled={!unpublished || dirty || busy} data-prompt-publish=""
        onClick={() => void openPublish()}>
        发布
      </Button>
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>模型将收到的全文</DialogTitle>
            <DialogDescription>只拼装当前模板，不调用模型，也不计费。</DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{preview}</pre>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={diff !== null} onOpenChange={(open) => { if (!open) setDiff(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布此草稿</DialogTitle>
            <DialogDescription>对照当前已发布版本。确认后，新建的识图作业才会读到这一版。</DialogDescription>
          </DialogHeader>
          {diff ? <DiffBody diff={diff} /> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDiff(null)}>取消</Button>
            <Button type="button" disabled={busy} data-prompt-publish-confirm="" onClick={() => void publish()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              确认发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DiffBody({ diff }: { diff: SupplierPromptDiff }) {
  return (
    <div className="flex max-h-96 flex-col gap-3 overflow-auto">
      {diff.lines.map((line) => (
        <div key={line.label} className={line.changed ? "rounded-md bg-muted px-3 py-2" : "px-3 py-2"}
          data-prompt-diff-line={line.label} data-changed={line.changed || undefined}>
          <p className="text-meta text-muted-foreground">{lineTitle(line.label)}</p>
          {line.changed ? (
            <div className="mt-1 flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">{line.published || "（空）"}</p>
              <p>{line.draft || "（空）"}</p>
            </div>
          ) : (
            <p className="mt-1 text-sm">{line.draft}</p>
          )}
        </div>
      ))}
      {diff.fixedTagsChanged ? (
        <p className="px-3 text-sm">固定标签：{diff.publishedFixedTags.join(" ") || "（无）"} → {diff.draftFixedTags.join(" ") || "（无）"}</p>
      ) : null}
      {diff.aiOutputChanged ? (
        <p className="px-3 text-sm">识图生成：{outputLabel(diff.publishedAiOutput)} → {outputLabel(diff.draftAiOutput)}</p>
      ) : null}
    </div>
  )
}

function lineTitle(label: string): string {
  return BRIEF_LINES.find((line) => line.label === label)?.zh ?? label
}

function outputLabel(policy: AiPolicy): string {
  const bit = (on: boolean, name: string) => `${name}${on ? "开" : "关"}`
  return [bit(policy.title, "标题"), bit(policy.description, "描述"), bit(policy.tags, "标签")].join("、")
}
