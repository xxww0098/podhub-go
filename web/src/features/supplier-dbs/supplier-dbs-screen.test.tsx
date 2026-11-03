/** Global product table and preconfigured factory ownership. */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SupplierDbsScreen } from "./supplier-dbs-screen"
import { SupplierFulfillmentBinding } from "./supplier-fulfillment-binding"
import { createSupplierDbsStore } from "./supplier-dbs-store"
import { db, row, memoryClient, readyStore } from "./supplier-dbs-screen-fixtures"

test("不同工厂商品汇总在一张表，工厂列区分归属，没有左右分栏", async () => {
  const { store } = await readyStore([
    { db: db("src-1", "杭州工厂"), propDefs: [], rows: [row("p1", "src-1", { title: "靠枕" })] },
    { db: db("src-2", "义乌工厂"), propDefs: [], rows: [row("p2", "src-2", { title: "帆布包" })] },
  ])
  await Promise.all([store.loadDetail("src-1"), store.loadDetail("src-2")])
  const html = renderToStaticMarkup(<SupplierDbsScreen role="admin" store={store} />)
  assert.equal(html.match(/<table\b/g)?.length, 1)
  for (const value of ["杭州工厂", "义乌工厂", "靠枕", "帆布包", "共 2 款商品，2 个规格"]) assert.ok(html.includes(value), value)
  assert.doesNotMatch(html, /新增工厂|工厂配置/)
  assert.match(html, /aria-label="按商品库筛选"/)
  assert.match(html, /aria-label="新增商品"/)
  assert.doesNotMatch(html, /data-panel=|data-separator=|搜索平台商品库|新建平台商品库/)
})

test("未绑定工厂时不能新增商品，管理员可绑定已有工厂", async () => {
  const { store } = await readyStore()
  const html = renderToStaticMarkup(<SupplierDbsScreen role="super_admin" store={store} />)
  assert.match(html, /请先绑定已有工厂，再创建商品。/)
  assert.match(html, /绑定工厂/)
  assert.match(html, /<button[^>]*(?:disabled=""[^>]*aria-label="新增商品"|aria-label="新增商品"[^>]*disabled="")/)
  const admin = renderToStaticMarkup(<SupplierDbsScreen role="admin" store={store} />)
  assert.match(admin, /请先绑定已有工厂，再创建商品。/)
  assert.match(admin, /绑定工厂/)
})

test("登录账号不代表履约绑定，普通管理员只能读取绑定状态", () => {
  const render = (fulfillerEmail?: string) => renderToStaticMarkup(<SupplierFulfillmentBinding db={db("src-1", "杭州工厂", { fulfillerEmail })} superAdmin={false} onChanged={async () => {}} />)
  assert.match(render(), /待绑定履约账号/)
  assert.match(render("fulfiller@example.com"), /已绑定：fulfiller@example.com/)
  assert.doesNotMatch(render(), /role="combobox"|<button/)
})

test("工厂商品尚未读取时显示加载态，不把局部数量当成全部数量", async () => {
  const { store } = await readyStore([{ db: db("src-1", "杭州工厂"), propDefs: [], rows: [row("p1", "src-1")] }])
  const html = renderToStaticMarkup(<SupplierDbsScreen role="admin" store={store} />)
  assert.match(html, /正在读取商品库/)
  assert.doesNotMatch(html, /共 0 款商品/)
})

test("普通卖家不能进入管理页面", async () => {
  const { store } = await readyStore()
  const html = renderToStaticMarkup(<SupplierDbsScreen role="user" store={store} />)
  assert.match(html, /data-supplier-dbs="forbidden"/)
  assert.doesNotMatch(html, /aria-label="新增商品"|工厂配置表/)
})

test("读取失败保留重试入口", async () => {
  const { client } = memoryClient()
  client.supplierDbsList = async () => { throw { code: "internal", message: "backend down" } }
  const store = createSupplierDbsStore(client)
  await store.loadList()
  const html = renderToStaticMarkup(<SupplierDbsScreen role="admin" store={store} />)
  assert.match(html, /data-supplier-dbs="error"/)
  assert.match(html, /aria-label="重试"/)
  assert.doesNotMatch(html, /backend down/)
})
