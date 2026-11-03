import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "@/components/ui/tooltip"
import { catalogRowInput, type CatalogRow } from "@/bindings/http-supplier-catalog"
import { EMPTY_ROW_REQUEST } from "@/features/supplier-dbs/supplier-dbs-model"
import { CatalogRowEditor, catalogInputFromForm } from "./catalog-row-editor"

const base = catalogRowInput({ ...EMPTY_ROW_REQUEST, title: "Cup", platformCode: "CUP", costCents: 1000, revision: 4 })
const form = () => {
  const input = new FormData()
  input.set("title", "Changed"); input.set("platformCode", "CUP"); input.set("costCents", "12.34"); input.set("shippingCostCents", "0"); input.set("packWidthMm", "120")
  return input
}

test("catalogue edits preserve CAS and media while validating money and packaging", () => {
  const media = [{ url: "https://cdn.example/cup.jpg", w: 10, h: 20 }]
  const next = catalogInputFromForm(form(), { ...base, gallery: media, props: { color: "red" } })
  assert.equal(next.title, "Changed"); assert.equal(next.costCents, 1234); assert.equal(next.shippingCostCents, 0)
  assert.equal(next.packWidthMm, 120); assert.equal(next.revision, 4); assert.deepEqual(next.gallery, media); assert.deepEqual(next.props, { color: "red" })
  const invalid = form(); invalid.set("packWidthMm", "1.5")
  assert.throws(() => catalogInputFromForm(invalid, base), /正整数/)
  invalid.set("packWidthMm", "120"); invalid.set("costCents", "-1")
  assert.throws(() => catalogInputFromForm(invalid, base), /有效金额/)
})

test("catalogue editor exposes writable facts and keeps platform-only operations out", () => {
  const html = renderToStaticMarkup(<TooltipProvider><CatalogRowEditor row={{ ...base, productId: "p1", platformPriceCents: 2000 } as CatalogRow} source={{ sourceId: "src", name: "Factory" } as never} propDefs={[]} onSaved={() => {}} onCancel={() => {}} /></TooltipProvider>)
  assert.match(html, /保存商品/); assert.match(html, /aria-label="供货成本（元）"/); assert.match(html, /由超级管理员定价/)
  assert.match(html, /aria-label="上传图片"/); assert.match(html, /aria-label="上传 PSD"/)
  assert.doesNotMatch(html, /调价|添加商品负责人|整库公开|AI 识图/)
})
