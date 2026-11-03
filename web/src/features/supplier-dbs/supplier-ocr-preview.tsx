import { useId, useState } from "react"
import { supplierDbsHttp } from "@/bindings/http-supplier-dbs"
import { sharedListingCore } from "@/listing-core/client"
import type { ParsedOcrAnswer, ProductProfile } from "@/listing-core/types"
import { filterBannedTags, refreshBannedTags } from "@/lib/banned-tags"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { FieldMeta } from "@/components/field-meta"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SheetSection } from "./supplier-row-fields"

export function SupplierOcrPreview({ sourceId, productId, profile, fixedTags, disabled }: {
  sourceId: string
  productId: string
  profile: ProductProfile
  fixedTags: string[]
  disabled: boolean
}) {
  const id = useId()
  const [theme, setTheme] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ input: string; message: string }>()
  const [result, setResult] = useState<{ input: string; answer: ParsedOcrAnswer }>()
  const input = JSON.stringify({ profile, fixedTags, theme })
  const answer = result?.input === input ? result.answer : undefined
  const error = failure?.input === input ? failure.message : undefined

  async function preview() {
    if (busy || disabled) return
    setBusy(true)
    setFailure(undefined)
    try {
      await supplierDbsHttp.supplierPromptPreview(sourceId, productId, { brief: JSON.stringify(profile), fixedTags })
      await refreshBannedTags()
      const normalized = { product_type_ru: profile.product_type_ru.trim(), facts_ru: profile.facts_ru.trim() }
      const answer = await sharedListingCore().parseOcrAnswer({ profile: normalized, fixed_tags: fixedTags, preview_theme: theme.trim() })
      answer.tags = filterBannedTags([...fixedTags, ...answer.tags])
      setResult({ input, answer })
    } catch (reason) {
      setFailure({ input, message: reason instanceof Error ? reason.message : "无法预览，请检查商品事实、主题和标签。" })
      setResult(undefined)
    } finally { setBusy(false) }
  }

  return <SheetSection title="公式测试">
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void preview() }}>
      <Field>
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          <FieldLabel htmlFor={id}>示例画面主题（俄文，留空表示无图案）</FieldLabel>
          <FieldMeta name="示例画面主题" description="仅预览标题公式与固定标签，不调用模型、不扣费；画面描述和 5 个主题标签由真实识图生成。" />
        </div>
        <Input id={id} value={theme} placeholder="Кот с чашкой" disabled={busy}
          onChange={event => setTheme(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={busy || disabled}>{busy ? <Spinner /> : null}预览标题与固定标签</Button>
        <span className="text-meta text-muted-foreground">不调用模型，不扣费；使用当前事实与已保存固定标签。</span>
      </div>
      {error ? <p role="alert" className="text-compact text-destructive">{error}</p> : null}
      {answer ? <dl className="flex flex-col gap-3 rounded-md border border-border p-3 text-compact" aria-live="polite" data-ocr-preview-result="">
        <div><dt className="text-muted-foreground">标题</dt><dd className="mt-1 break-words select-text">{answer.ru}</dd></div>
        <div><dt className="text-muted-foreground">Tags</dt><dd className="mt-1 break-words select-text">{answer.tags.join(" ")}</dd></div>
      </dl> : null}
    </form>
  </SheetSection>
}
