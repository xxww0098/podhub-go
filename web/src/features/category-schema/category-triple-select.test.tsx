import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import { CategoryTripleSelect } from "./category-triple-select"
import {
  buildCategorySearchIndex,
  emptyTreeSelection,
  searchCategoryIndex,
  selectionFromLeaf,
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
  node("服装", 1, [
    node("男装", 11, [
      node("T恤", 0, [], 101),
      node("衬衫", 0, [], 102),
    ]),
  ]),
]

function renderPicker(query: string, selection = emptyTreeSelection()) {
  return renderToStaticMarkup(
    <CategoryTripleSelect
      tree={tree}
      selection={selection}
      query={query}
      onSelectL1={() => undefined}
      onSelectL2={() => undefined}
      onSelectType={() => undefined}
    />,
  )
}

test("search filters the tree by name and id", () => {
  const index = buildCategorySearchIndex(tree)
  assert.deepEqual(
    searchCategoryIndex(index, "T恤").map((hit) => hit.typeId),
    [101],
  )
  assert.deepEqual(
    searchCategoryIndex(index, "102").map((hit) => hit.typeId),
    [102],
  )

  const html = renderPicker("T恤")
  assert.match(html, /服装 \/ 男装 \/ T恤/)
  assert.match(html, /data-type-id="101"/)
  assert.doesNotMatch(html, /data-type-id="102"/)
  assert.doesNotMatch(html, /选择一级类目/)
  assert.doesNotMatch(html, /先刷新类目/)
})

test("loading an empty tree shows skeleton bars", () => {
  const html = renderToStaticMarkup(
    <CategoryTripleSelect
      tree={[]}
      selection={emptyTreeSelection()}
      loading
      onSelectL1={() => undefined}
      onSelectL2={() => undefined}
      onSelectType={() => undefined}
    />,
  )
  assert.match(html, /data-category-tree-skeleton/)
  assert.match(html, /正在拉取类目/)
  assert.doesNotMatch(html, /没有匹配类目/)
})

test("picking a leaf sets type_id on the form selection", () => {
  const hit = searchCategoryIndex(buildCategorySearchIndex(tree), "T恤")[0]
  assert.ok(hit)
  const selection = selectionFromLeaf(hit)
  assert.equal(selection.typeId, 101)
  assert.equal(selection.descriptionCategoryId, 11)
  assert.equal(selection.l1Id, 1)

  const html = renderPicker("", selection)
  assert.match(html, /aria-label="已选类目 服装 \/ 男装 \/ T恤"/)
})
