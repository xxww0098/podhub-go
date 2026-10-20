import assert from "node:assert/strict"
import test from "node:test"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import {
  buildCategorySearchIndex,
  categoryPathLabel,
  promptBackedTree,
  resolveLeaf,
  searchCategoryIndex,
} from "./category-tree"

function node(
  name: string,
  id: number,
  children: CategoryTreeNodeView[] = [],
  typeId = 0,
): CategoryTreeNodeView {
  return {
    description_category_id: typeId > 0 ? 0 : id,
    category_name: typeId > 0 ? "" : name,
    disabled: false,
    type_id: typeId,
    type_name: typeId > 0 ? name : "",
    children,
  }
}

const tree: CategoryTreeNodeView[] = [
  node("装饰", 1, [
    node("墙面装饰", 11, [
      node("海报", 0, [], 101),
      node("油画", 0, [], 102),
    ]),
  ]),
]

test("category search indexes leaves once and matches path or id", () => {
  const index = buildCategorySearchIndex(tree)
  assert.equal(index.length, 2)
  assert.equal(index[0]?.pathLabel, "装饰 / 墙面装饰 / 海报")
  assert.deepEqual(
    searchCategoryIndex(index, "海报").map((hit) => hit.typeId),
    [101],
  )
  assert.deepEqual(
    searchCategoryIndex(index, "102").map((hit) => hit.typeId),
    [102],
  )
  assert.deepEqual(searchCategoryIndex(index, "   "), [])
})

test("category path label is the Chinese L1 / L2 / type path", () => {
  assert.equal(categoryPathLabel(11, 101, tree), "装饰 / 墙面装饰 / 海报")
  assert.equal(categoryPathLabel(11, 102, tree), "装饰 / 墙面装饰 / 油画")
  assert.deepEqual(resolveLeaf(11, 101, tree), {
    descriptionCategoryId: 11,
    typeId: 101,
    pathLabel: "装饰 / 墙面装饰 / 海报",
    l1Id: 1,
    l2Id: 11,
  })
})

test("compose tree keeps only prompt-backed leaves and prunes empty parents", () => {
  const filtered = promptBackedTree(tree, [
    { descriptionCategoryId: 11, typeId: 101 },
  ])
  assert.deepEqual(
    buildCategorySearchIndex(filtered).map((hit) => hit.typeId),
    [101],
  )
  assert.equal(promptBackedTree(tree, []).length, 0)
})

test("category path label still resolves when the type sits under an extra node", () => {
  const nested = [
    node("住宅和花园", 17027488, [
      node("装饰和房间内饰", 17027906, [
        node("画", 17028000, [node("装饰画", 0, [], 91955)]),
      ]),
    ]),
  ]
  assert.equal(
    categoryPathLabel(17027906, 91955, nested),
    "住宅和花园 / 装饰和房间内饰 / 装饰画",
  )
})
