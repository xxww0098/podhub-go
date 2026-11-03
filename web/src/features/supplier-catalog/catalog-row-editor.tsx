import { useRef, useState, type FormEvent } from "react"
import { ArrowLeft } from "lucide-react"
import { catalogRowInput, supplierCatalogHttp, type CatalogRow, type CatalogRowInput, type CatalogSource } from "@/bindings/http-supplier-catalog"
import type { SupplierDbPropDef } from "@/bindings/http-supplier-dbs"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError } from "@/lib/notify"
import { EMPTY_ROW_REQUEST } from "@/features/supplier-dbs/supplier-dbs-model"
import { CategoryCellEditor, centsToInput, formatCnyCents, nonNegativeCentsFromYuan, priceCentsFromYuan } from "@/features/supplier-dbs/supplier-prop-editors"
import { CustomPropField, PropRow } from "@/features/supplier-dbs/supplier-row-fields"
import { loadCategoryTree } from "@/features/category-schema/category-tree-load"
import { readCategoryTreeCache } from "@/features/category-schema/category-tree-cache"
import { SupplierRowMedia } from "@/features/supplier-dbs/supplier-row-media"
import type { SupplierDbPresign, SupplierDbConfirm, SupplierDbAbort } from "@/features/supplier-dbs/supplier-db-upload"

const presign: SupplierDbPresign = async (sourceId, input) => ({ ok: true, value: (await supplierCatalogHttp.presign(sourceId, input)).upload })
const confirm: SupplierDbConfirm = async (sourceId, ticket, signal, parts) => {
  const value = await supplierCatalogHttp.confirm(sourceId, ticket, signal, parts)
  return { key: value.key, publicUrl: value.public_url }
}
const abort: SupplierDbAbort = (sourceId, ticket) => { void supplierCatalogHttp.abort(sourceId, ticket).catch(() => {}) }

const TEXT_FIELDS = [["title", "商品名称"], ["platformCode", "商品编号"], ["size", "规格"], ["variantGroup", "款号"], ["material", "材质"], ["craft", "工艺"], ["brand", "品牌"], ["leadTime", "交期"], ["contents", "包装清单"]] as const
const NUMBER_FIELDS = [["grossWeightG", "毛重（g）"], ["packWidthMm", "包装宽（mm）"], ["packHeightMm", "包装高（mm）"], ["packDepthMm", "包装厚（mm）"], ["packWeightG", "包装重量（g）"]] as const
const MONEY_FIELDS = [["costCents", "供货成本（元）"], ["shippingCostCents", "运费（元）"], ["suggestedRetailCents", "建议零售价（元）"], ["suggestedOldPriceCents", "建议划线价（元）"]] as const

export function catalogInputFromForm(form: FormData, base: CatalogRowInput): CatalogRowInput {
  const next = { ...base }
  for (const [key] of TEXT_FIELDS) next[key] = String(form.get(key) ?? "").trim()
  if (!next.title || !next.platformCode) throw new Error("请填写商品名称和编号")
  for (const [key, label] of NUMBER_FIELDS) {
    const text = String(form.get(key) ?? "").trim()
    const value = text ? Number(text) : null
    if (value != null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${label}需为正整数`)
    next[key] = value
  }
  for (const [key, label] of MONEY_FIELDS) {
    const text = String(form.get(key) ?? "").trim()
    const value = key === "shippingCostCents" ? nonNegativeCentsFromYuan(text) : priceCentsFromYuan(text)
    if (value === undefined || key === "costCents" && value === null) throw new Error(`${label}需为有效金额`)
    next[key] = value
  }
  next.description = String(form.get("description") ?? "")
  next.internalNote = String(form.get("internalNote") ?? "")
  return next
}

export function CatalogRowEditor({ row, source, propDefs, onSaved, onChanged, onCancel }: {
  row?: CatalogRow
  source: CatalogSource
  propDefs: SupplierDbPropDef[]
  onSaved: (row: CatalogRow) => void
  onChanged?: (row: CatalogRow) => void
  onCancel: () => void
}) {
  const [current, setCurrent] = useState(row)
  const currentRef = useRef(row)
  const mediaWrites = useRef<Promise<boolean>>(Promise.resolve(true))
  const [mediaBusy, setMediaBusy] = useState(false)
  const [props, setProps] = useState(row?.props ?? {})
  const [category, setCategory] = useState({ descriptionCategoryId: row?.descriptionCategoryId ?? null, typeId: row?.typeId ?? null })
  const [tree, setTree] = useState<CategoryTreeNodeView[]>(() => readCategoryTreeCache() ?? [])
  const [treeLoading, setTreeLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const pending = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const base = catalogRowInput(current ?? EMPTY_ROW_REQUEST)
  const close = () => { if (dirty) setDiscarding(true); else onCancel() }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current || mediaBusy) return
    const form = new FormData(event.currentTarget)
    pending.current = true; setBusy(true); setError("")
    try {
      await mediaWrites.current
      const input = catalogInputFromForm(form, { ...catalogRowInput(currentRef.current ?? EMPTY_ROW_REQUEST), props, ...category })
      const saved = row ? await supplierCatalogHttp.update(source.sourceId, row.productId, input) : await supplierCatalogHttp.create(source.sourceId, input)
      onSaved(saved)
    } catch (reason) {
      setError(errorMessage(reason, "商品未确认保存，请保留输入并重试"))
      requestAnimationFrame(() => errorRef.current?.focus())
    } finally { pending.current = false; setBusy(false) }
  }
  const saveMedia = (patch: Partial<Pick<CatalogRowInput, "gallery" | "psd" | "productVideos">>) => {
    const save = mediaWrites.current.then(async () => {
      const latest = currentRef.current
      if (!latest) return false
      try {
        const saved = await supplierCatalogHttp.update(source.sourceId, latest.productId, { ...catalogRowInput(latest), ...patch })
        currentRef.current = saved; setCurrent(saved); onChanged?.(saved)
        return true
      } catch (reason) { notifyCommandError(reason, "素材未保存，请重试"); return false }
    })
    mediaWrites.current = save
    return save
  }
  return <form onSubmit={submit} onChange={() => setDirty(true)} className="flex min-h-0 min-w-0 flex-1 flex-col" data-catalog-row-editor="">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <IconButton icon={ArrowLeft} label="返回获授权商品" disabled={busy} onClick={close} />
      <span className="min-w-0 flex-1 truncate">{source.name} / {row?.title || "新增商品"}</span>
      <Button type="button" variant="outline" disabled={busy} onClick={close}>取消</Button>
      <Button type="submit" variant="brand" disabled={busy || mediaBusy}>{busy ? <Spinner /> : null}{row ? "保存商品" : "创建商品并继续"}</Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {error ? <div ref={errorRef} role="alert" tabIndex={-1} className="mb-4 text-destructive">{error}</div> : null}
      {current ? <div className="mb-5"><SupplierRowMedia row={current} onPatch={saveMedia} presign={presign} confirm={confirm} abort={abort} onBusyChange={setMediaBusy} /></div> : null}
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TEXT_FIELDS.map(([key, label]) => <PropRow key={key} name={label} required={key === "title" || key === "platformCode"}><Input name={key} aria-label={label} required={key === "title" || key === "platformCode"} defaultValue={base[key] ?? ""} /></PropRow>)}
        {MONEY_FIELDS.map(([key, label]) => <PropRow key={key} name={label} required={key === "costCents"}><Input name={key} aria-label={label} inputMode="decimal" required={key === "costCents"} defaultValue={centsToInput(base[key])} /></PropRow>)}
        <PropRow name="平台价"><div className="flex min-h-11 flex-wrap items-center gap-2"><strong>{formatCnyCents(row?.platformPriceCents ?? null)}</strong><span className="text-meta text-muted-foreground">由超级管理员定价</span></div></PropRow>
        <PropRow name="Ozon 类目" note="更换类目后，需要平台重新校验 Ozon 字段。"><CategoryCellEditor ariaLabel="Ozon 类目" value={category} tree={tree} loading={treeLoading} disabled={busy} onEnsureTree={async () => {
          if (treeLoading) return false
          if (tree.length) return true
          setTreeLoading(true)
          try { setTree(await loadCategoryTree()); return true } catch (reason) { setError(errorMessage(reason, "无法读取类目，请重试")); return false } finally { setTreeLoading(false) }
        }} onCommit={async (next) => { setCategory(next); setDirty(true); return true }} /></PropRow>
        {NUMBER_FIELDS.map(([key, label]) => <PropRow key={key} name={label}><Input name={key} aria-label={label} inputMode="numeric" defaultValue={base[key] ?? ""} /></PropRow>)}
        {propDefs.map((def) => <PropRow key={def.propId} name={def.name}><CustomPropField def={def} row={{ props }} onPatch={async (patch) => { if (patch.props) { setProps(patch.props); setDirty(true) } return true }} /></PropRow>)}
        <PropRow name="商品描述"><Textarea name="description" aria-label="商品描述" defaultValue={base.description} /></PropRow>
        <PropRow name="内部备注"><Textarea name="internalNote" aria-label="内部备注" defaultValue={base.internalNote} /></PropRow>
      </fieldset>
    </div>
    <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="放弃未保存的修改" description="本次输入尚未保存。" confirmText="放弃修改" onConfirm={onCancel} />
  </form>
}
