/**
 * 「识图提示词」页签 — 管理员独占的识图输入：提示词名称、说明文件（.md）、
 * 六行构建器（SupplierBriefBuilder）与固定 tags。编辑器显示最新修订；
 * 发布才把该修订写回 supplier_ozon_configs，识图作业只读已发布修订。
 */
import { useEffect, useRef, useState } from "react"
import { FileText, Sparkles, Upload, X } from "lucide-react"

import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { pickFiles } from "@/bindings/file-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { bannedTagRejection, refreshBannedTags } from "@/lib/banned-tags"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { FIXED_TAGS_MAX, isValidFixedTag } from "@/lib/fixed-tags"
import { cn } from "@/lib/utils"

import { CommitInput } from "./supplier-prop-editors"
import { PropRow, SheetSection, type PatchFn } from "./supplier-row-fields"
import { FieldNote } from "./supplier-row-media"
import { SupplierBriefBuilder } from "./supplier-brief-builder"
import { SupplierPromptAuthoring } from "./supplier-prompt-authoring"
import { SupplierRowAiOutput } from "./supplier-row-ai-output"
import { briefAdvisories, parseBriefLines } from "./brief-lines"

export function SupplierRowPromptTab({
  row,
  rows,
  onPatch,
  onDirtyChange,
  configEpoch,
  onConfigSaved,
  onPromptPublished,
}: {
  row: SupplierDbRow
  rows: readonly SupplierDbRow[]
  onPatch: PatchFn
  onDirtyChange?: (dirty: boolean) => void
  configEpoch?: number
  onConfigSaved?: () => void
  onPromptPublished?: () => void
}) {
  const [importingPrompt, setImportingPrompt] = useState(false)
  const [briefDirty, setBriefDirty] = useState(false)
  const [tagsDirty, setTagsDirty] = useState(false)
  const [aiDirty, setAiDirty] = useState(false)
  const hasCategory = row.descriptionCategoryId != null && row.typeId != null
  useEffect(() => { onDirtyChange?.(briefDirty || tagsDirty || aiDirty) }, [briefDirty, tagsDirty, aiDirty, onDirtyChange])

  const importPrompt = async (file: File) => {
    if (!/\.(md|markdown)$/i.test(file.name)) {
      notifyError("请选择 Markdown 文档（.md 或 .markdown）")
      return
    }
    if (file.size > 4096) {
      notifyError("提示词正文不能超过 4 KB")
      return
    }
    setImportingPrompt(true)
    try {
      const content = new TextDecoder("utf-8", { fatal: true })
        .decode(await file.arrayBuffer())
        .trim()
      if (!content.trim() || content.includes("\0")) {
        notifyError("Markdown 文档为空或包含无效内容")
        return
      }
      const parsed = parseBriefLines(content)
      if (!parsed) {
        notifyError("说明文件须包含按顺序排列的六行俄文说明")
        return
      }
      const advisories = briefAdvisories(parsed)
      if (advisories.length) {
        notifyError(advisories.map((item) => item.message).join("；"))
        return
      }
      const ok = await onPatch({
        promptFileName: file.name,
        promptContent: content,
        ...(!row.promptName.trim() ? { promptName: file.name.replace(/\.(md|markdown)$/i, "") } : {}),
      })
      if (ok) notifySuccess("已存为草稿")
    } catch (reason) {
      notifyError("读取提示词失败，请选择 UTF-8 编码的 Markdown 文档", { reason })
    } finally {
      setImportingPrompt(false)
    }
  }

  const pickPromptFile = async () => {
    if (importingPrompt) return
    const [file] = await pickFiles(".md,.markdown,text/markdown")
    if (file) await importPrompt(file)
  }

  const published = () => {
    onConfigSaved?.()
    onPromptPublished?.()
  }

  return (
    <div className="flex flex-col gap-5" data-supplier-row-prompt-tab="">
      <SupplierPromptAuthoring
        sourceId={row.sourceId}
        productId={row.productId}
        brief={row.promptContent}
        fixedTags={row.fixedTags}
        draftRevision={row.draftPromptRevision}
        publishedRevision={row.publishedPromptRevision}
        dirty={briefDirty || tagsDirty || aiDirty}
        onPublished={published}
      />
      <SheetSection title="提示词信息" locked columns={2}>
        <PropRow icon={<Sparkles />} name="提示词名称">
          <CommitInput ariaLabel="提示词名称" value={row.promptName}
            onCommit={(next) => onPatch({ promptName: next })} />
        </PropRow>
        <PropRow icon={<FileText />} name="说明文件">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-all font-mono text-meta text-muted-foreground">
              {row.promptFileName || "尚未导入"}
            </span>
            <Button type="button" variant="outline" size="sm"
              disabled={importingPrompt || briefDirty || !hasCategory}
              aria-label="导入 Markdown 说明文件"
              title={briefDirty ? "请先保存正文草稿，再导入说明文件" : !hasCategory ? "选择 Ozon 类目后可导入" : undefined}
              onClick={() => void pickPromptFile()}>
              {importingPrompt ? <Spinner data-icon="inline-start" /> : <Upload aria-hidden />}
              导入 .md
            </Button>
          </div>
        </PropRow>
      </SheetSection>
      <SheetSection title="六行识图说明" locked>
        <SupplierRowAiOutput row={row} configEpoch={configEpoch} onConfigSaved={published} onDirtyChange={setAiDirty} />
        <SupplierBriefBuilder row={row} rows={rows} onPatch={onPatch} onDirtyChange={setBriefDirty} />
      </SheetSection>

      <SheetSection title="固定标签" locked>
        <p className="text-meta text-muted-foreground">用于当前商品规格；识图还会生成图片标签。</p>
        <FixedTagsEditor
          tags={row.fixedTags}
          disabled={!hasCategory}
          onDirtyChange={setTagsDirty}
          onCommit={(next) => onPatch({ fixedTags: next })}
        />
      </SheetSection>
    </div>
  )
}

/**
 * 固定标签数量复用 FIXED_TAGS_MAX；至少 1 个才满足上架要求。
 * 回车即加即存，移除即存；失败保留草稿并提供重试。
 */
function FixedTagsEditor({
  tags,
  onCommit,
  disabled,
  onDirtyChange,
}: {
  tags: string[]
  onCommit: (next: string[]) => Promise<boolean>
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState(tags)
  const [entry, setEntry] = useState("")
  const [saving, setSaving] = useState(false)
  const committed = useRef(tags)

  useEffect(() => {
    const previous = committed.current
    committed.current = tags
    setDraft((current) => current.join("\n") === previous.join("\n") ? tags : current)
  }, [tags])

  const dirty = draft.join("\n") !== tags.join("\n")
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  useEffect(() => {
    void refreshBannedTags().catch((reason) => {
      notifyCommandError(reason, "无法读取受限标签，保存时仍由服务器拦截。")
    })
  }, [])

  const commit = async (next: string[]) => {
    if (saving || disabled) return
    // 旧超限词表先在本地删减，降到上限内才保存，避免清理过程中提交超限值。
    if (next.length > FIXED_TAGS_MAX) {
      if (next.length < draft.length) setDraft(next)
      notifyError(`固定 tags 最多 ${FIXED_TAGS_MAX} 个`)
      return
    }
    setDraft(next)
    setSaving(true)
    try {
      if (await onCommit(next)) committed.current = next
    } finally {
      setSaving(false)
    }
  }

  const addEntry = () => {
    const value = entry.trim()
    if (!value) return
    // 服务端按补完 `#` 的整 tag 计 2–30 个码点 —— 卡输入长度要在归一化之后。
    const normalized = value.startsWith("#") ? value : `#${value}`
    if ([...normalized].length > 30) {
      notifyError("单个 tag 不能超过 30 个字符（含 #）")
      return
    }
    // 写路径宽松、publish 闸才裁决词身 —— 但在入口就拦下永远过不了闸的
    // tag（如拉丁字母），免得落盘后 readiness 只报「缺」不说哪个坏了。
    if (!isValidFixedTag(normalized)) {
      notifyError("tag 须为俄语词：仅西里尔字母与数字，可用 _ 连词")
      return
    }
    const banned = bannedTagRejection(normalized)
    if (banned) {
      notifyError(banned)
      return
    }
    if (draft.length >= FIXED_TAGS_MAX) {
      notifyError(`固定 tags 最多 ${FIXED_TAGS_MAX} 个`)
      return
    }
    if (draft.some((t) => t.toLowerCase() === normalized.toLowerCase())) {
      setEntry("")
      return
    }
    setEntry("")
    void commit([...draft, normalized])
  }

  const over = draft.length > FIXED_TAGS_MAX
  const hasInvalid = draft.some((tag) => !isValidFixedTag(tag))

  return (
    <div
      className="flex flex-col gap-2"
      data-supplier-row-fixed-tags=""
      aria-invalid={over || hasInvalid || undefined}
      aria-busy={saving || undefined}
    >
      <div className="flex flex-wrap gap-1.5">
        {draft.map((tag, index) => {
          const valid = isValidFixedTag(tag)
          return (
            <Badge
              key={`${tag}-${index}`}
              variant={valid ? "outline" : "destructive"}
              aria-invalid={valid ? undefined : true}
              title={valid ? undefined : "不符合契约：须为 # 开头的俄语词"}
            >
              {tag}
              <button
                type="button"
                aria-label={`移除 ${tag}`}
                disabled={saving || disabled}
                className="cursor-pointer text-faint-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void commit(draft.filter((_, i) => i !== index))}
              >
                <X aria-hidden className="size-3" />
              </button>
            </Badge>
          )
        })}
        {draft.length === 0 ? (
          <span className="text-meta text-faint-foreground">尚未填写</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="添加固定标签"
          value={entry}
          placeholder="输入后回车添加并保存（自动加 #）"
          className="flex-1"
          disabled={saving || disabled}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              addEntry()
            }
          }}
        />
        <span
          className={cn(
            "shrink-0 font-mono text-meta tabular-nums",
            over ? "text-st-bad" : "text-muted-foreground",
          )}
          data-supplier-row-tags-count=""
        >
          {draft.length} / {FIXED_TAGS_MAX}
        </span>
        {saving ? <Spinner className="size-3.5" /> : null}
        {dirty && !saving ? (
          <Button type="button" variant="outline" size="sm" disabled={disabled}
            onClick={() => void commit(draft)}>重试保存</Button>
        ) : null}
        <FieldNote
          text={`最多 ${FIXED_TAGS_MAX} 个、每个为 # 开头的俄语词（可含数字，用 _ 连词）；至少 1 个才能上架`}
        />
      </div>
    </div>
  )
}
