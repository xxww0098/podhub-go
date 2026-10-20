import { useEffect, useState } from "react"
import { PackageSearch } from "lucide-react"
import type {
  SkuImportCandidate,
  SkuImportPreview,
  SkuImportValue,
} from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { clearLive, notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

export function SkuImportPanel({
  blank,
  disabled,
  onPreview,
  onApply,
}: {
  blank: boolean
  disabled: boolean
  onPreview: (sku: string) => Promise<SkuImportPreview>
  onApply: (candidates: SkuImportCandidate[], sourceSku: number) => void
}) {
  const [sku, setSku] = useState("")
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<SkuImportPreview>()

  useEffect(() => {
    if (preview && !preview.category_matches) {
      notifyError("类目坐标不同，已阻止导入。请换同类目 SKU。", {
        id: "sku-import-category-mismatch",
      })
      return
    }
    clearLive("sku-import-category-mismatch")
  }, [preview])

  async function loadPreview() {
    if (!blank) {
      notifyError("只有类目字段全部空白的草稿才能从 SKU 导入。")
      return
    }
    if (!/^\d+$/.test(sku.trim()) || Number(sku) <= 0) {
      notifyError("请输入正整数 SKU。")
      return
    }
    setLoading(true)
    setPreview(undefined)
    try {
      setPreview(await onPreview(sku.trim()))
    } catch (reason) {
      notifyCommandError(reason, "无法读取这个 SKU，请稍后重试。")
    } finally {
      setLoading(false)
    }
  }

  function applyAll() {
    if (!preview?.category_matches || preview.candidates.length === 0) return
    onApply(preview.candidates, preview.source_sku)
    notifySuccess(`已导入 ${preview.candidates.length} 个可复用参数，正在保存到云端。`)
    setPreview(undefined)
    setSku("")
  }

  return (
    <section className="min-w-0" aria-label="从 SKU 导入类目字段">
      <div className="flex items-center gap-1.5">
        <Input
          className="h-8 min-w-0 flex-1 font-mono text-xs shadow-2xs"
          aria-label="输入来源 Ozon SKU"
          aria-describedby="sku-import-help"
          inputMode="numeric"
          placeholder="输入 Ozon SKU"
          value={sku}
          disabled={loading || disabled || !blank}
          onChange={(event) => {
            setSku(event.target.value)
            setPreview(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void loadPreview()
          }}
        />
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 px-2.5 text-xs font-medium"
          disabled={loading || disabled || !blank}
          onClick={() => void loadPreview()}
        >
          <PackageSearch className="size-3.5" aria-hidden />
          {loading ? "读取中…" : "读取 SKU"}
        </Button>
      </div>
      <p id="sku-import-help" className="mt-1 text-meta leading-4 text-muted-foreground">
        {!blank
          ? "清空类目字段后才能导入"
          : disabled
            ? "批次运行中，暂不能导入"
            : "读取当前店铺；只导入可复用参数，名称等逐行文案仅作参考"}
      </p>

      {preview ? (
        <div className="mt-2.5 rounded-lg border border-border/80 bg-card p-3 shadow-xs space-y-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-meta text-muted-foreground">参考商品名称</p>
              <p className="mt-0.5 truncate text-sm font-medium text-foreground">
                {preview.source_name || `SKU ${preview.source_sku}`}
              </p>
              <p className="mt-0.5 font-mono text-meta text-muted-foreground">
                SKU {preview.source_sku} · Offer {preview.source_offer_id || "—"} · 类目 {preview.source_description_category_id}/{preview.source_type_id}
              </p>
            </div>
            {preview.category_matches ? (
              <span className="inline-flex items-center rounded-sm bg-st-good-soft px-1.5 py-0.5 text-meta font-medium text-st-good-ink">
                类目一致 · 可导入 {preview.candidates.length} 个参数
              </span>
            ) : (
              <span className="inline-flex items-center rounded-sm bg-destructive/10 px-1.5 py-0.5 text-meta font-medium text-destructive">
                类目不一致
              </span>
            )}
          </div>

          {preview.category_matches ? (
            <>
              <p className="text-meta leading-4 text-muted-foreground">
                商品名称只作参考；最终名称由工作台逐行生成或人工修改，不会从这个 SKU 导入。
              </p>
              {preview.candidates.length ? (
                <>
                  <p className="text-meta font-medium text-foreground">将导入的可复用参数</p>
                  <div className="grid gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2 sm:grid-cols-2">
                    {preview.candidates.slice(0, 12).map((candidate) => (
                      <div key={candidate.candidate_id} className="min-w-0">
                        <p className="truncate text-meta text-muted-foreground">{candidate.field_name}</p>
                        <p className="truncate text-xs font-medium text-foreground" title={valueText(candidate.value)}>
                          {valueText(candidate.value)}
                        </p>
                      </div>
                    ))}
                  </div>
                  {preview.candidates.length > 12 ? (
                    <p className="text-meta text-muted-foreground">
                      另有 {preview.candidates.length - 12} 个参数一并导入
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <p className="text-meta text-muted-foreground">
                      导入 {preview.candidates.length} 个参数并保存到云端
                    </p>
                    <Button type="button" size="sm" className="h-7.5 text-xs" disabled={disabled || !blank} onClick={applyAll}>
                      导入可复用参数
                    </Button>
                  </div>
                </>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  这个 SKU 没有可复用参数，不会写入当前方案。
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function valueText(value: SkuImportValue) {
  if (value.kind === "single_select") return value.value.value
  if (value.kind === "multi_select") return value.value.map((item) => item.value).join("、")
  if (Array.isArray(value.value)) return value.value.join("、")
  if (typeof value.value === "boolean") return value.value ? "是" : "否"
  return String(value.value)
}
