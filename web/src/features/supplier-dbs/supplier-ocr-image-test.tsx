import { useEffect, useId, useRef, useState } from "react"
import { hashUploadBody, putDirectUpload } from "@/bindings/direct-upload"
import { supplierOcrTestsHttp as io, type SupplierOcrTestInput, type SupplierOcrTestResult } from "@/bindings/http-supplier-ocr-tests"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { FieldMeta } from "@/components/field-meta"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { peekAccountOverview, useAccountOverview } from "@/features/account/account-overview-cache"
import { invalidateWallet } from "@/features/usage/wallet-cache"
import { prepareOcrImage } from "@/features/workflow/prepare/ocr-upload"
import { errorMessage } from "@/lib/error-message"
import type { ProductProfile } from "@/listing-core/types"
import { renderClient } from "@/render/client"
import { SheetSection } from "./supplier-row-fields"

type FrozenTest = { id: string; input: SupplierOcrTestInput; bytes: Uint8Array }
const STATUS = { running: "处理中", succeeded: "已生成", rejected: "结果需人工处理", failed: "调用失败", unknown: "结果未知" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function storedId(key: string): string {
  try { const value = localStorage.getItem(key) ?? ""; return UUID.test(value) ? value : "" } catch { return "" }
}

export function SupplierOcrImageTest({ sourceId, productId, profile, fixedTags, disabled }: {
  sourceId: string
  productId: string
  profile: ProductProfile
  fixedTags: string[]
  disabled: boolean
}) {
  const overview = useAccountOverview()
  const scope = `${overview?.session.email ?? ""}:${overview?.active_workspace?.id ?? ""}`
  const key = `podhub.ocr-test:${scope}:${sourceId}:${productId}`
  const contextKey = useRef(key)
  contextKey.current = key
  const fieldId = useId()
  const [file, setFile] = useState<File>()
  const [imageUrl, setImageUrl] = useState("")
  const [latestId, setLatestId] = useState(() => storedId(key))
  const [result, setResult] = useState<SupplierOcrTestResult>()
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const active = useRef(false)
  const alive = useRef(true)
  const frozen = useRef<FrozenTest | undefined>(undefined)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    frozen.current = undefined
    setLatestId(storedId(key)); setResult(undefined); setError(""); setFile(undefined)
  }, [key])
  useEffect(() => {
    if (!file) { setImageUrl(""); return }
    const url = URL.createObjectURL(file)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const currentProfile = { product_type_ru: profile.product_type_ru.trim(), facts_ru: profile.facts_ru.trim() }
  const resultMatches = !result || (JSON.stringify(result.input.profile) === JSON.stringify(currentProfile) && result.input.fixed_tags.join(" ") === fixedTags.join(" "))
  const terminal = result != null && result.state !== "running"
  const unresolved = Boolean(latestId && !terminal)
  const cannotChangeImage = Boolean(busy || (unresolved && frozen.current) || result?.state === "running")

  async function perform(start: boolean) {
    if (active.current) return
    active.current = true
    const operationKey = key
    const assertCurrent = () => {
      const now = peekAccountOverview()
      const currentScope = `${now?.session.email ?? ""}:${now?.active_workspace?.id ?? ""}`
      if (!alive.current || contextKey.current !== operationKey || currentScope !== scope) throw new Error("工作空间已切换，请返回原工作空间读取本次测试结果。")
    }
    setError(""); setBusy(start ? "准备测试" : "读取测试结果")
    try {
      let id = latestId
      if (id && (!start || unresolved)) {
        try {
          const prior = await io.get(id)
          assertCurrent(); setResult(prior); return
        } catch (reason) {
          if (!start || (reason as { status?: number }).status !== 404) throw reason
        }
      }
      if (!start) return
      if (!unresolved) {
        id = crypto.randomUUID()
        frozen.current = undefined
      }
      if (!id) id = crypto.randomUUID()
      localStorage.setItem(operationKey, id)
      setLatestId(id); setResult(undefined)
      let current = frozen.current
      if (!current || current.id !== id) {
        if (!file) throw new Error("请选择测试图片。")
        if (file.size > 20 * 1024 * 1024) throw new Error("测试图片不能超过 20 MB。")
        const profileSnapshot = structuredClone(profile)
        const tags = [...fixedTags]
        setBusy("正在处理图片")
        const batch = renderClient.createBatch()
        let bytes: Uint8Array
        try { bytes = await batch.prepareAiImage(new Uint8Array(await file.arrayBuffer())) } finally { batch.dispose() }
        assertCurrent()
        const prepared = prepareOcrImage(bytes)
        const sha256 = await hashUploadBody(bytes)
        assertCurrent()
        current = { id, bytes, input: { source_id: sourceId, product_id: productId, profile: profileSnapshot, fixed_tags: tags,
          image: { bytes: bytes.byteLength, sha256, content_type: prepared.mimeType } } }
        frozen.current = current
      }
      setBusy("正在上传私有图片")
      const grant = await io.upload(id, current.input)
      assertCurrent()
      current.input = grant.input
      const upload = grant.target.upload
      if (!upload) throw new Error("私有图片上传授权不可用，请重试本次测试。")
      try { await putDirectUpload(upload, current.bytes, { expectedByteLength: current.bytes.byteLength }) }
      catch (reason) {
        try { await io.confirm(id, current.input, grant.target.upload_ticket) } catch { throw reason }
      }
      assertCurrent()
      await io.confirm(id, current.input, grant.target.upload_ticket)
      assertCurrent(); setBusy("正在识图，按实际用量计费")
      const next = await io.run(id, current.input, grant.target.upload_ticket)
      assertCurrent(); setResult(next)
    } catch (reason) {
      if (alive.current && contextKey.current === operationKey) setError(errorMessage(reason, "测试未完成。请读取本次结果，或使用相同测试记录重试。"))
    } finally {
      active.current = false
      if (alive.current) setBusy("")
      invalidateWallet()
    }
  }

  return <SheetSection title="真实图片测试">
    <div className="flex min-w-0 flex-col gap-3" data-supplier-ocr-image-test="">
      <Field>
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          <FieldLabel htmlFor={fieldId}>测试图片</FieldLabel>
          <FieldMeta name="测试图片" required={!unresolved} description="开始新测试前选择 JPG、PNG 或 WebP 图片，最大 20 MB；继续已有测试无需重传。" />
        </div>
        <Input id={fieldId} type="file" accept="image/jpeg,image/png,image/webp" aria-label="测试图片" disabled={cannotChangeImage}
          onChange={event => {
            setFile(event.currentTarget.files?.[0]); setError("")
            if (terminal) { frozen.current = undefined; setLatestId(""); setResult(undefined); localStorage.removeItem(key) }
          }} />
      </Field>
      {imageUrl ? <img src={imageUrl} alt="本次测试图片" className="max-h-40 max-w-full self-start rounded-md object-contain" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" data-ocr-image-start="" disabled={disabled || !!busy || (!file && !unresolved) || fixedTags.length === 0}
          onClick={() => void perform(true)}>{busy ? <Spinner /> : null}{unresolved ? "读取 / 继续本次测试" : terminal ? "重新识图（重新计费）" : "开始识图测试"}</Button>
        {latestId ? <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void perform(false)}>读取本次结果</Button> : null}
      </div>
      <p className="text-meta text-muted-foreground">使用当前事实与已保存固定标签，按实际用量扣工作空间钱包。</p>
      {busy ? <p role="status" className="text-compact text-muted-foreground">{busy}</p> : null}
      {error ? <p role="alert" className="text-compact text-destructive">{error}</p> : null}
      {result ? <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3" data-ocr-image-result="" aria-live="polite">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-compact">
          <span>{STATUS[result.state]}</span>
          {result.billing.status === "settled" ? <span>实际扣费 ¥{(result.billing.charged_microfen / 100_000_000).toFixed(8)}</span> : null}
        </div>
        {!resultMatches ? <p role="status" className="text-meta text-muted-foreground">配置已修改，本次结果仅对应测试时输入：{result.input.profile.product_type_ru} {result.input.profile.facts_ru}</p> : null}
        {result.error ? <p role="status" className="text-compact text-destructive">{result.error}</p> : null}
        {result.answer ? <dl className="flex min-w-0 flex-col gap-3 text-compact">
          <div><dt className="text-muted-foreground">标题</dt><dd className="mt-1 break-words select-text">{result.answer.ru}</dd></div>
          <div><dt className="text-muted-foreground">描述</dt><dd className="mt-1 break-words select-text">{result.answer.description}</dd></div>
          <div><dt className="text-muted-foreground">Tags</dt><dd className="mt-1 break-words select-text">{result.answer.tags.join(" ")}</dd></div>
        </dl> : null}
      </div> : null}
    </div>
  </SheetSection>
}
