import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { FIXED_TAGS_MAX } from "@/lib/fixed-tags"
import { SupplierBriefBuilder } from "./supplier-brief-builder"
import { SupplierRowPromptTab } from "./supplier-row-prompt-tab"

const brief = readFileSync(new URL("../../../../fixtures/ocr/brief-minimal.txt", import.meta.url), "utf8")
const row = {
  productId: "product-one", title: "测试商品", size: "40×50", promptName: "", promptFileName: "",
  promptContent: "", fixedTags: ["#рисунок"], descriptionCategoryId: 1, typeId: 2,
} as SupplierDbRow

test("empty prompt opens six accessible fields and one explicit save action", () => {
  const html = renderToStaticMarkup(<SupplierBriefBuilder row={row} rows={[]} onPatch={async () => true} />)
  assert.equal((html.match(/data-brief-line=/g) ?? []).length, 6)
  assert.equal((html.match(/<textarea/g) ?? []).length, 6)
  assert.equal((html.match(/data-brief-save=/g) ?? []).length, 1)
  for (const label of ["商品事实", "图像主题", "标题规则", "禁用表述", "描述规则", "禁止编造"]) assert.ok(html.includes(label))
  assert.match(html, /更多/)
  assert.doesNotMatch(html, /从同款规格复制|插入骨架句|role="alert"/)
})

test("valid saved brief opens all six fields while legacy raw text remains editable", () => {
  const valid = renderToStaticMarkup(<SupplierBriefBuilder row={{ ...row, promptContent: brief }} rows={[]} onPatch={async () => true} />)
  assert.equal((valid.match(/<textarea/g) ?? []).length, 6)
  const legacy = renderToStaticMarkup(<SupplierBriefBuilder row={{ ...row, promptContent: "旧版完整正文" }} rows={[]} onPatch={async () => true} />)
  assert.equal((legacy.match(/<textarea/g) ?? []).length, 1)
  assert.match(legacy, /旧版完整正文/)
  assert.match(legacy, /data-brief-save=/)
})

test("prompt metadata and fixed tags remain separate and use the current tag limit", () => {
  const html = renderToStaticMarkup(<SupplierRowPromptTab row={row} rows={[]} onPatch={async () => true} />)
  assert.match(html, /提示词信息/)
  assert.match(html, /六行识图说明/)
  assert.match(html, /固定标签/)
  assert.match(html, new RegExp(`1 / ${FIXED_TAGS_MAX}`))
  assert.match(html, /始终绑定当前商品规格/)
  assert.doesNotMatch(html, /type="checkbox"|role="alert"/)
})
