/** Database/row commands normalize payloads, retain CAS and reconcile counts. */
import assert from "node:assert/strict"
import test from "node:test"
import type { SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import { db, row, memoryClient, readyStore } from "./supplier-dbs-screen-fixtures"
import { createSupplierDbsStore } from "./supplier-dbs-store"

test("建库 through the store reaches the client and lands in the list", async () => {
  const { store, calls } = await readyStore()
  const created = await store.createDb({
    name: "  德国厂  ",
    country: "de",
    contact: "ops@factory.invalid",
    internalNote: "旺季产能足",
    listed: true,
    icon: "🏭",
    template: "factory",
    factoryId: " fac-1 ",
  })
  assert.equal(created.ok, true)
  assert.equal(calls.createDb.length, 1)
  assert.equal(calls.createDb[0].name, "德国厂")
  assert.equal(calls.createDb[0].country, "DE")
  assert.equal(calls.createDb[0].template, "factory")
  assert.equal(calls.createDb[0].factoryId, "fac-1")
  assert.equal(store.getState().dbs.length, 1)
  assert.equal(store.getState().dbs[0].name, "德国厂")

  const refused = await store.createDb({ name: " ", country: "", contact: "", internalNote: "", listed: true, icon: "" })
  assert.equal(refused.ok, false)
  assert.equal(calls.createDb.length, 1, "validation happens before the wire")

  // 改库也走同一条规范化：国家码大写、名称裁剪。
  const sourceId = store.getState().dbs[0].sourceId
  const draftWithStaleEmail = { country: "ru", contact: "  x@y.invalid ", accountEmail: "next@example.com" }
  const saved = await store.updateDb(sourceId, draftWithStaleEmail)
  assert.equal(saved.ok, true)
  assert.equal(calls.updateDb[0].country, "RU")
  assert.equal(calls.updateDb[0].contact, "x@y.invalid")
  assert.equal(calls.updateDb[0].name, "德国厂", "untrained fields ride along")
  assert.equal("accountEmail" in calls.updateDb[0], false, "editing factory details must never rebind members")

})


test("建库必须选择已有工厂", async () => {
  const { store, calls } = await readyStore()
  const draft = { name: "商品库", country: "", contact: "", internalNote: "", listed: false, icon: "" }
  assert.equal((await store.createDb(draft)).ok, false)
  assert.equal((await store.createDb({ ...draft, factoryId: "fac-1" })).ok, true)
  assert.equal(calls.createDb[0].factoryId, "fac-1")
  assert.equal(calls.createDb.length, 1)
})

test("删库: 库内有商品也可以删除", async () => {
  const { store, calls } = await readyStore([
    { db: db("src-1", "有行库", { rowCount: 1 }), propDefs: [], rows: [row("p1", "src-1")] },
    { db: db("src-2", "空库"), propDefs: [], rows: [] },
  ])
  await store.loadDetail("src-1")
  assert.equal((await store.deleteDb("src-1")).ok, true)
  assert.ok(!store.getState().dbs.some((item) => item.sourceId === "src-1"))
  assert.equal(store.getState().details["src-1"], undefined)
  assert.equal((await store.deleteDb("src-2")).ok, true)
  assert.deepEqual(calls.deleteDb, ["src-1", "src-2"])
  assert.ok(!store.getState().dbs.some((item) => item.sourceId === "src-2"))
})

test("删库: 关联记录阻止删除时保留库和后端提示", async () => {
  const { client } = memoryClient([{ db: db("src-1", "有关联的库"), propDefs: [], rows: [] }])
  client.supplierDbDelete = async () => { throw { code: "cloud_conflict", message: "该库关联了订单，无法删除" } }
  const store = createSupplierDbsStore(client)
  await store.loadList()
  const result = await store.deleteDb("src-1")
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].message, "该库关联了订单，无法删除")
  assert.equal(store.getState().dbs[0].sourceId, "src-1")
})


test("行文本字段 update carries expectedRevision (CAS)", async () => {
  const detail: SupplierDbDetail = {
    db: db("src-1", "美国3C厂"),
    propDefs: [],
    rows: [row("p1", "src-1", { title: "圣诞帽", revision: 7 })],
  }
  const { store, calls } = await readyStore([detail])
  await store.loadDetail("src-1")
  const saved = await store.updateRow("src-1", "p1", { title: "圣诞帽 Pro" })
  assert.equal(saved.ok, true)
  assert.equal(calls.updateRow[0].expectedRevision, 7)
  assert.equal(calls.updateRow[0].title, "圣诞帽 Pro")
  // untrained fields survive the round trip — the upsert is the whole row
  assert.equal(calls.updateRow[0].platformCode, "P-p1")
  const stored = store.getState().details["src-1"].detail!.rows[0]
  assert.equal(stored.title, "圣诞帽 Pro")
  assert.equal(stored.revision, 8)
})


test("patchCell carries 规格/毛重/运费 through the whole-row upsert", async () => {
  const detail: SupplierDbDetail = {
    db: db("src-1", "美国3C厂"),
    propDefs: [],
    rows: [
      row("p1", "src-1", {
        size: "40×50cm",
        material: "纯棉",
        craft: "数码直喷",
        grossWeightG: 350,
        shippingCostCents: 200,
        revision: 3,
      }),
    ],
  }
  const { store, calls } = await readyStore([detail])
  await store.loadDetail("src-1")
  const saved = await store.patchCell("src-1", "p1", { size: "45×60cm" })
  assert.equal(saved.ok, true)
  // The untrained siblings ride the same upsert — a 规格 commit must not
  // drop the offer's 运费 or the product's 毛重.
  assert.equal(calls.updateRow[0].size, "45×60cm")
  assert.equal(calls.updateRow[0].material, "纯棉")
  assert.equal(calls.updateRow[0].craft, "数码直喷")
  assert.equal(calls.updateRow[0].grossWeightG, 350)
  assert.equal(calls.updateRow[0].shippingCostCents, 200)
  const stored = store.getState().details["src-1"].detail!.rows[0]
  assert.equal(stored.size, "45×60cm")
  assert.equal(stored.shippingCostCents, 200)
})


test("publish/unpublish/price seams hit their endpoints and reconcile counts", async () => {
  const detail: SupplierDbDetail = {
    db: db("src-1", "美国3C厂", { rowCount: 1, publishedCount: 0 }),
    propDefs: [],
    rows: [row("p1", "src-1")],
  }
  const { store, calls } = await readyStore([detail])
  await store.loadDetail("src-1")
  assert.equal((await store.publishRow("src-1", "p1")).ok, true)
  assert.equal(calls.publish[0], "p1")
  assert.equal(store.getState().details["src-1"].detail!.db.publishedCount, 1)
  assert.equal((await store.unpublishRow("src-1", "p1")).ok, true)
  assert.equal(store.getState().details["src-1"].detail!.db.publishedCount, 0)
  assert.equal((await store.adjustPrice("src-1", "p1", 2100, "涨价")).ok, true)
  assert.deepEqual(calls.price, [{ priceCents: 2100, note: "涨价" }])
  assert.equal(
    store.getState().details["src-1"].detail!.rows[0].platformPriceCents,
    2100,
  )
})


test("新增规格保留款号与类目，提示词正文留空待独立配置", async () => {
  const { store, calls } = await readyStore([{
    db: db("src-1", "画材厂"), propDefs: [], rows: [],
  }])
  const created = await store.createRow("src-1", {
    title: "数字油画", variantGroup: "PAINT-01", size: "50×70cm",
    descriptionCategoryId: 12, typeId: 34,
  })
  assert.equal(created.ok, true)
  assert.equal(calls.createRow.length, 1)
  const body = calls.createRow[0]
  assert.equal(body.variantGroup, "PAINT-01")
  assert.equal(body.size, "50×70cm")
  assert.equal(body.promptContent, "")
  assert.equal(body.promptName, "")
})
