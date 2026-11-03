import assert from "node:assert/strict"
import test from "node:test"
import { row } from "./supplier-dbs-screen-fixtures"
import { productNeedsCompletion, productOzonReady, supplierProductGroups } from "./supplier-product-groups"

test("同款按来源分组，空款号保持独立，归档规格不参与统计", () => {
  const groups = supplierProductGroups([
    row("a", "s1", { variantGroup: "g" }), row("b", "s1", { variantGroup: "g" }),
    row("c", "s2", { variantGroup: "g" }), row("d", "s1"), row("e", "s1"),
    row("f", "s1", { variantGroup: "g", archived: true }),
  ])
  assert.deepEqual(groups.map((group) => group.rows.map((item) => item.productId)), [["a", "b"], ["c"], ["d"], ["e"]])
})

test("一件商品有任一待补规格或类目不一致时，商品仍待完善", () => {
  const ready = { category: true, prompt: true, fixedTags: true, platformPrice: true, ozonConfig: true }
  const a = row("a", "s", { variantGroup: "g", descriptionCategoryId: 1, typeId: 2, fixedTags: ["#тег"], readiness: ready })
  const b = row("b", "s", { ...a, productId: "b", readiness: { ...ready, prompt: false } })
  const group = supplierProductGroups([a, b])[0]
  assert.equal(productOzonReady(group), true)
  assert.equal(productNeedsCompletion(group), true)
  const changed = supplierProductGroups([a, { ...a, productId: "c", typeId: 3 }])[0]
  assert.equal(productOzonReady(changed), false)
  assert.equal(productNeedsCompletion(changed), true)
})
