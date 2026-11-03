/** One current confirmed configuration; artwork uses one shared model prompt. */
import { useEffect, useRef, useState } from "react"
import { Copy, RotateCcw, X } from "lucide-react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { FieldMeta } from "@/components/field-meta"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { bannedTagRejection, refreshBannedTags } from "@/lib/banned-tags"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { FIXED_TAGS_MAX, isValidFixedTag } from "@/lib/fixed-tags"
import { cn } from "@/lib/utils"
import { SheetSection, type PatchFn } from "./supplier-row-fields"
import { SupplierOcrImageTest } from "./supplier-ocr-image-test"
import { SupplierOcrPreview } from "./supplier-ocr-preview"
import { EMPTY_PROFILE, ProductProfileFields, readProductProfile } from "./product-profile-fields"

export function SupplierRowCopyFields({ row, onPatch, onDirtyChange, saveRef, siblings = [] }: {
  row: SupplierDbRow
  onPatch: PatchFn
  onDirtyChange?: (dirty: boolean) => void
  saveRef?: React.RefObject<(() => Promise<boolean>) | null>
  siblings?: readonly SupplierDbRow[]
}) {
  const [profile, setProfile] = useState(() => readProductProfile(row.promptContent) ?? EMPTY_PROFILE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [copyNote, setCopyNote] = useState("")
  const errorRef = useRef<HTMLParagraphElement>(null)
  const [tagsDirty, setTagsDirty] = useState(false)
  const raw = JSON.stringify(profile)
  const saved = readProductProfile(row.promptContent)
  const dirty = raw !== JSON.stringify(saved ?? EMPTY_PROFILE)
  const committed = useRef(row.promptContent)
  useEffect(() => {
    const previous = readProductProfile(committed.current) ?? EMPTY_PROFILE
    committed.current = row.promptContent
    setProfile(current => JSON.stringify(current) === JSON.stringify(previous) ? readProductProfile(row.promptContent) ?? EMPTY_PROFILE : current)
  }, [row.promptContent])
  useEffect(() => { onDirtyChange?.(dirty || tagsDirty) }, [dirty, tagsDirty, onDirtyChange])
  const hasCategory = row.descriptionCategoryId != null && row.typeId != null
  const save = async () => {
    if (saving || !hasCategory) return false
    setSaving(true)
    setError("")
    try {
      if (!await onPatch({ promptContent: raw, promptName: row.promptName || row.title })) {
        setError("保存失败，输入已保留。请按错误提示修改后重试。")
        requestAnimationFrame(() => errorRef.current?.focus())
        return false
      } else {
        setProfile({ product_type_ru:profile.product_type_ru.trim(), facts_ru:profile.facts_ru.trim() })
        return true
      }
    } catch (reason) {
      notifyCommandError(reason,"保存商品事实失败")
      setError("保存失败，输入已保留。请重试。")
      requestAnimationFrame(() => errorRef.current?.focus())
      return false
    } finally { setSaving(false) }
  }
  useEffect(() => {
    if (!saveRef) return
    const flush = async () => {
      if (tagsDirty) { setError("标签尚未保存，请先重试保存。"); return false }
      return dirty ? await save() : true
    }
    saveRef.current = flush
    return () => { if (saveRef.current === flush) saveRef.current = null }
  })
  return <div className="supplier-ai-layout min-w-0" data-supplier-row-copy-fields="">
    <div className="min-w-0 space-y-4">
    <SheetSection title="商品事实" action={siblings.some((item) => item.productId !== row.productId && readProductProfile(item.promptContent)) ? <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={saving} />}><Copy aria-hidden />复制其他规格事实</DropdownMenuTrigger>
      <DropdownMenuContent align="end">{siblings.filter((item) => item.productId !== row.productId && item.sourceId === row.sourceId && readProductProfile(item.promptContent)).map((item) => <DropdownMenuItem key={item.productId} onClick={() => {
        const candidate = readProductProfile(item.promptContent)
        if (candidate) { setProfile({ ...candidate }); setCopyNote(`已复制“${item.size || item.platformCode}”的商品事实，请核对当前规格的尺寸等信息后保存。`) }
      }}>{item.size || item.platformCode}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu> : null}>
      {copyNote ? <p role="status" className="text-meta text-muted-foreground">{copyNote}</p> : null}
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-meta leading-5 text-muted-foreground">标题公式：商品类型＋确认属性＋"画面主题"</p>
      {row.promptContent && !saved ? <p role="status" className="text-compact text-muted-foreground">旧说明需要重新填写为商品事实后保存。</p> : null}
      <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void save() }} aria-busy={saving || undefined}>
        <ProductProfileFields value={profile} onChange={next => { setProfile(next); setError("") }} disabled={saving || !hasCategory} />
        {error ? <p ref={errorRef} role="alert" tabIndex={-1} className="text-compact text-destructive">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-3">
          <Button type="submit" size="sm" disabled={saving || !hasCategory || !dirty}>{saving ? <Spinner /> : null}保存配置</Button>
          {!hasCategory ? <span className="text-meta text-muted-foreground">先选择 Ozon 类目</span> : null}
        </div>
      </form>
    </SheetSection>
    <FixedTagsEditor tags={row.fixedTags} disabled={!hasCategory || saving} onDirtyChange={setTagsDirty} onCommit={next => onPatch({ fixedTags: next })} />
    </div>
    <div className="min-w-0 space-y-4">
    <SupplierOcrPreview sourceId={row.sourceId} productId={row.productId} profile={profile} fixedTags={row.fixedTags} disabled={saving || tagsDirty || !hasCategory} />
    <SupplierOcrImageTest sourceId={row.sourceId} productId={row.productId} profile={profile} fixedTags={row.fixedTags} disabled={saving || tagsDirty || !hasCategory} />
    </div>
  </div>
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
      notifyCommandError(reason, "无法读取全局受限标签，保存时仍由服务器拦截。")
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
    <SheetSection title={<><span>固定标签</span><FieldMeta name="固定标签" required description={`最多 ${FIXED_TAGS_MAX} 个，每个为 # 开头的俄语词，可含数字、用 _ 连词；至少 1 个才能上架。`} /></>}>
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
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-faint-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 max-md:size-11"
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
          onBlur={addEntry}
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
          <IconButton icon={RotateCcw} label="重试保存" variant="outline" size="icon-sm" disabled={disabled}
            onClick={() => void commit(draft)} />
        ) : null}
      </div>
    </div>
    </SheetSection>
  )
}
