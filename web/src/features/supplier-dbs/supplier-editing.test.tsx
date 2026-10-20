/** Row CAS/pending state, property lifecycle, duplication, archive and price writes. */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SupplierDbDetailView } from "./supplier-db-table"
import { propsPatch } from "./supplier-prop-editors"
import { createSupplierDbsStore, type SupplierDbsClient } from "./supplier-dbs-store"
import { TREE, db, row, propDef, clientWithDetail, storeWithDetail } from "./supplier-editing-fixtures"

test("patchCell 合并 props 补丁进整行 PUT，带 expectedRevision CAS", async () => {
  const { store, state } = await storeWithDetail({
    db: db({ rowCount: 1 }),
    propDefs: [propDef({ propId: "prop-a" })],
    rows: [row("p1", { revision: 5, props: { "prop-a": "旧", "prop-b": "留" } })],
  })
  const saved = await store.patchCell("src-1", "p1", {
    props: propsPatch(state.rows[0].props, "prop-a", "新"),
  })
  assert.equal(saved.ok, true)
  const stored = state.rows[0]
  assert.equal(stored.props["prop-a"], "新")
  assert.equal(stored.props["prop-b"], "留", "别人的键不动")
  assert.equal(stored.revision, 6)
})


test("propsPatch 空值摘键而不是写空串；false 保留", () => {
  const props = { a: "x", b: true, c: "留" }
  assert.deepEqual(propsPatch(props, "a", ""), { b: true, c: "留" })
  assert.deepEqual(propsPatch(props, "a", null), { b: true, c: "留" })
  assert.deepEqual(propsPatch(props, "b", false), { a: "x", b: false, c: "留" })
  assert.deepEqual(propsPatch(props, "d", 3), { a: "x", b: true, c: "留", d: 3 })
})


test("行写期间 pendingRows 置灰，落定后解除；失败也解除", async () => {
  const { client } = clientWithDetail({
    db: db({ rowCount: 1 }),
    propDefs: [],
    rows: [row("p1")],
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const slow: SupplierDbsClient = {
    ...client,
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      await gate
      return client.supplierDbRowUpdate(sourceId, productId, body)
    },
  }
  const store = createSupplierDbsStore(slow)
  await store.loadList()
  await store.loadDetail("src-1")
  const pending = store.patchCell("src-1", "p1", { title: "写中" })
  assert.deepEqual(store.getState().pendingRows, ["p1"])
  release()
  assert.equal((await pending).ok, true)
  assert.deepEqual(store.getState().pendingRows, [])

  const failing: SupplierDbsClient = {
    ...client,
    supplierDbRowUpdate: async () => {
      throw { code: "conflict", message: "revision mismatch" }
    },
  }
  const failStore = createSupplierDbsStore(failing)
  await failStore.loadList()
  await failStore.loadDetail("src-1")
  assert.equal((await failStore.patchCell("src-1", "p1", { title: "x" })).ok, false)
  assert.deepEqual(failStore.getState().pendingRows, [], "失败也解灰")
})


test("属性生命周期：建 → 列在 → 填值 → 改名不掉值 → 删除带 rowsWithValues", async () => {
  const { store, state } = await storeWithDetail({
    db: db({ rowCount: 1 }),
    propDefs: [],
    rows: [row("p1")],
  })
  const created = await store.createProp("src-1", {
    name: "材质",
    type: "select",
    options: [{ value: "cotton", label: "棉" }],
    sellerVisible: true,
  })
  assert.equal(created.ok, true)
  const propId = created.ok ? created.value.propId : ""
  assert.equal(state.propDefs.length, 1, "列出现")
  assert.equal(state.propDefs[0].name, "材质")

  const filled = await store.patchCell("src-1", "p1", {
    props: propsPatch(state.rows[0].props, propId, "cotton"),
  })
  assert.equal(filled.ok, true)
  assert.equal(state.rows[0].props[propId], "cotton")

  const renamed = await store.updateProp("src-1", propId, {
    name: "面料",
    type: "select",
    options: [{ value: "cotton", label: "棉" }],
    sellerVisible: true,
    position: 0,
  })
  assert.equal(renamed.ok, true)
  assert.equal(state.propDefs[0].name, "面料")
  assert.equal(state.rows[0].props[propId], "cotton", "值按 prop_id 键，不掉")

  const deleted = await store.deleteProp("src-1", propId)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.ok ? deleted.value.rowsWithValues : -1, 1)
  assert.equal(state.propDefs.length, 0)
})


test("insertPropAt 左插/右插落到属性区序位，position 被归一", async () => {
  const { store, state, propUpdates } = await storeWithDetail({
    db: db({ rowCount: 0 }),
    propDefs: [
      propDef({ propId: "prop-a", name: "A", position: 0 }),
      propDef({ propId: "prop-b", name: "B", position: 1 }),
    ],
    rows: [],
  })
  const inserted = await store.insertPropAt(
    "src-1",
    { name: "C", type: "text", options: [], sellerVisible: true },
    1,
  )
  assert.equal(inserted.ok, true)
  const order = [...state.propDefs]
    .sort((a, b) => a.position - b.position)
    .map((item) => item.name)
  assert.deepEqual(order, ["A", "C", "B"], "新列落在 A 右 / B 左")
  // B 被推到 position 2 — reorderProps 写了一次归一 PUT。
  assert.equal(propUpdates.length, 1)
  assert.equal(propUpdates[0].propId, "prop-b")
  assert.equal(propUpdates[0].body.position, 2)
})


test("复制行：title 接「副本」、编号加后缀、不带 expectedRevision", async () => {
  const { store, state } = await storeWithDetail({
    db: db({ rowCount: 1 }),
    propDefs: [],
    rows: [
      row("p1", {
        title: "圣诞帽",
        platformCode: "P001",
        props: { "prop-a": "棉" },
        costCents: 800,
      }),
    ],
  })
  const copied = await store.duplicateRow("src-1", "p1")
  assert.equal(copied.ok, true)
  assert.equal(state.rows.length, 2)
  const dup = state.rows[1]
  assert.equal(dup.title, "圣诞帽 副本")
  assert.equal(dup.platformCode, "P001-副本", "编号全库唯一，加后缀避让")
  assert.equal(dup.props["prop-a"], "棉", "props 一并复制")
  assert.equal(dup.costCents, 800)
  assert.equal(dup.revision, 1, "新行新 revision")
})


test("归档行：archived 置真，行从默认表格的 visibleRows 出局", async () => {
  const { store, state } = await storeWithDetail({
    db: db({ rowCount: 2 }),
    propDefs: [],
    rows: [row("p1"), row("p2")],
  })
  const archived = await store.archiveRow("src-1", "p1")
  assert.equal(archived.ok, true)
  assert.equal(state.rows.find((item) => item.productId === "p1")?.archived, true)
  const html = renderToStaticMarkup(
    <SupplierDbDetailView
      store={store}
      detail={{
        db: state.db,
        propDefs: state.propDefs,
        rows: state.rows,
      }}
      onExit={() => {}}
      onEditDb={() => {}}
      onOpenAccounts={() => {}}
      loadCategoryTree={async () => TREE}
    />,
  )
  assert.match(html, /共 1 条/, "归档行不进商品表")
  assert.doesNotMatch(html, /data-supplier-db-open="p1"/)
  assert.match(html, /data-supplier-db-open="p2"/)
})


test("调价 seam：adjustPrice POST 新价，行上 platformPriceCents 回填", async () => {
  const { store, state } = await storeWithDetail({
    db: db({ rowCount: 1 }),
    propDefs: [],
    rows: [row("p1", { platformPriceCents: 1600 })],
  })
  const saved = await store.adjustPrice("src-1", "p1", 2100, "涨价")
  assert.equal(saved.ok, true)
  assert.equal(state.rows[0].platformPriceCents, 2100)
})
