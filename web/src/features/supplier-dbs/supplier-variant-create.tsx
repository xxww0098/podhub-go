import { useState } from "react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError } from "@/lib/notify"
import { commandFailure } from "./supplier-dbs-errors"
import type { SupplierDbsStore } from "./supplier-dbs-store"

export function SupplierVariantCreate({ row, rows, store, onBack, onCreated }: {
  row: SupplierDbRow
  rows: SupplierDbRow[]
  store: SupplierDbsStore
  onBack: () => void
  onCreated: (productId: string) => void
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const siblings = rows.filter((item) => !item.archived && item.sourceId === row.sourceId && (item.productId === row.productId || Boolean(row.variantGroup?.trim()) && item.variantGroup?.trim() === row.variantGroup?.trim()))
  const save = async () => {
    if (busy) return
    if (!name.trim()) { setError("请填写规格名称"); return }
    setError("")
    setBusy(true)
    try {
      let productId = createdId
      if (!productId) {
        const result = await store.createVariant(row.sourceId, row.productId, { size: name.trim() })
        if (!result.ok) {
          setError(result.issues.map((issue) => issue.message).join("；") || "新增规格失败，请重试")
          notifyCommandError(commandFailure(result), "新增规格失败")
          return
        }
        productId = result.value.row.productId
        setCreatedId(productId)
        if (result.value.configCopyError) notifyCommandError(result.value.configCopyError, "规格已创建，Ozon 字段未继承，请在表单中补充配置")
      }
      await store.loadDetail(row.sourceId, { force: true })
      if (store.getState().details[row.sourceId]?.status !== "ready") {
        setError("规格已创建，资料读取失败，请重试读取后继续填写。")
        return
      }
      onCreated(productId)
    } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onBack() }}>
    <DialogContent data-supplier-variant-create="">
      <DialogHeader><DialogTitle>新增规格</DialogTitle><DialogDescription>{row.title || "未命名商品"}：先命名，再填写商品信息、Ozon 字段和 AI 识图。</DialogDescription></DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); void save() }} className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground"><span>已有规格</span>{siblings.map((item) => <span key={item.productId} className="rounded-md bg-muted px-2 py-1">{item.size || "尚未命名"}</span>)}</div>
        {!row.size.trim() ? <p role="alert" className="text-compact text-destructive">请先在平台商品信息中填写原规格名称。</p> : null}
        <Field><FieldLabel htmlFor="supplier-new-variant-name">规格名称</FieldLabel><Input id="supplier-new-variant-name" name="size" autoFocus required value={name} placeholder="如 40×50 cm" disabled={busy || createdId !== null} aria-invalid={Boolean(error) && createdId === null || undefined} aria-describedby={error ? "supplier-new-variant-error" : undefined} onChange={(event) => { setName(event.target.value); setError("") }} /></Field>
        {error ? <p id="supplier-new-variant-error" role="alert" className="text-compact text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onBack}>取消</Button><Button type="submit" variant="brand" disabled={busy || !row.size.trim() || !name.trim()}>{busy ? <Spinner /> : null}{createdId ? "重新读取并继续" : "创建并填写"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
