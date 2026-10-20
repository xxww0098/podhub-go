import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SupplierDbsScreen } from "./supplier-dbs-screen"
import { supplierDbsHttp, type SupplierDbPropDef } from "@/bindings/http-supplier-dbs"
import { rememberAccountOverview, peekAccountOverview, invalidateAccountOverview } from "@/features/account/account-overview-cache"
import { overview as accountOverviewFixture } from "../../../tests/account-fixtures"
import { createSupplierDbsStore, supplierDbs } from "./supplier-dbs-store"
import { supplierDbCreatorOptions, supplierDbsInScope } from "./supplier-db-scope"
import { managementClient, managementSeed } from "../../../tests/supplier-dbs-management.fixtures"

async function ready(role: string, accountUuid: string) {
  const { client } = managementClient(managementSeed(), () => ({ role, accountUuid }))
  const store = createSupplierDbsStore(client)
  await store.loadList()
  for (const db of store.getState().dbs) await store.loadDetail(db.sourceId)
  return store
}

test("普通管理员展示服务端自己的库，超级管理员展示创建人和历史库，维护能力保留", async () => {
  for (const [accountUuid, visible, hidden] of [["admin-lin", "林的印刷厂", "陈的服装厂"], ["admin-chen", "陈的服装厂", "林的印刷厂"]]) {
    const store = await ready("admin", accountUuid)
    const html = renderToStaticMarkup(<SupplierDbsScreen role="admin" accountUuid={accountUuid} store={store} />)
    assert.match(html, /仅我创建/)
    assert.ok(html.includes(visible))
    assert.ok(!html.includes(hidden))
    assert.doesNotMatch(html, /历史归属库|按库创建人筛选|<th[^>]*>创建人<\/th>/)
  }
  const store = await ready("super_admin", "root")
  const html = renderToStaticMarkup(<SupplierDbsScreen role="super_admin" accountUuid="root" store={store} />)
  for (const text of ["林的印刷厂", "陈的服装厂", "历史归属库", "全部管理员", "创建人", "库设置", "新建商品", "编辑"]) assert.ok(html.includes(text), text)
  assert.match(html, /35×40cm/)
  assert.match(html, /¥18\.00/)
  assert.match(html, /data-readiness-summary=""[^>]*>缺 类目、提示词、固定 tags、Ozon 配置未校验/)
})

test("超级管理员范围按公开账号 UUID 分组，同名不会合并，未知历史可单独选择", () => {
  const dbs = managementSeed().map((detail) => detail.db)
  dbs[1] = { ...dbs[1], creatorName: "林管理员" }
  assert.deepEqual(supplierDbCreatorOptions(dbs).map((option) => option.value), ["all", "admin-lin", "admin-chen", "unknown"])
  assert.equal(supplierDbCreatorOptions(dbs)[1]?.label, "林管理员 · admin-li创建")
  assert.equal(supplierDbCreatorOptions(dbs)[2]?.label, "林管理员 · admin-ch创建")
  assert.deepEqual(supplierDbsInScope(dbs, "admin-chen").map((db) => db.sourceId), ["chen"])
  assert.deepEqual(supplierDbsInScope(dbs, "unknown").map((db) => db.sourceId), ["legacy"])
})

test("身份重置清空旧详情，迟到列表和详情不能重新提交旧管理员数据", async () => {
  const { client } = managementClient(managementSeed())
  const staleDetail = managementSeed()[0]
  let resolveDetail!: (value: typeof staleDetail) => void
  let resolveList!: (value: Awaited<ReturnType<typeof client.supplierDbsList>>) => void
  const store = createSupplierDbsStore({ ...client, supplierDbsList: () => new Promise((resolve) => { resolveList = resolve }), supplierDbGet: () => new Promise((resolve) => { resolveDetail = resolve }) })
  const list = store.loadList()
  const detail = store.loadDetail("lin")
  store.reset()
  resolveList({ dbs: [staleDetail.db] })
  resolveDetail(staleDetail)
  await Promise.all([list, detail])
  assert.equal(store.getState().status, "idle")
  assert.deepEqual(store.getState().dbs, [])
  assert.deepEqual(store.getState().details, {})
})

test("身份重置取消尚未发出的队列写，旧写响应不污染新会话的 pending 或详情", async () => {
  const { client, calls } = managementClient(managementSeed())
  let resolveWrite!: (value: Awaited<ReturnType<typeof client.supplierDbRowUpdate>>) => void
  const store = createSupplierDbsStore({ ...client, supplierDbRowUpdate: () => new Promise((resolve) => { resolveWrite = resolve }) })
  await store.loadList()
  await store.loadDetail("lin")
  const first = store.patchCell("lin", "lin-1", { title: "旧会话保存" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const queued = store.publishRow("lin", "lin-1")
  store.reset()
  resolveWrite({ row: { ...managementSeed()[0].rows[0], revision: 2 } })
  await first
  assert.equal((await queued).ok, false)
  assert.deepEqual(calls, [])
  assert.deepEqual(store.getState().pendingRows, [])
  assert.deepEqual(store.getState().details, {})
})


test("超级管理员在普通管理员的库新建产品：普通管理员仅见自己的产品及计数", async () => {
  let authority = { role: "super_admin", accountUuid: "root" }
  const { client } = managementClient(managementSeed(), () => authority)
  const superStore = createSupplierDbsStore(client)
  await superStore.loadList()
  await superStore.loadDetail("lin")
  const created = await superStore.createRow("lin", { title: "超管创建的规格" })
  assert.equal(created.ok, true)
  assert.equal(superStore.getState().details.lin.detail?.db.rowCount, 3)
  authority = { role: "admin", accountUuid: "admin-lin" }
  const adminStore = createSupplierDbsStore(client)
  await adminStore.loadList()
  await adminStore.loadDetail("lin")
  const html = renderToStaticMarkup(<SupplierDbsScreen role="admin" accountUuid="admin-lin" store={adminStore} />)
  assert.doesNotMatch(html, /超管创建的规格/)
  assert.equal(adminStore.getState().dbs[0]?.rowCount, 2)
  assert.equal(adminStore.getState().details.lin.detail?.rows.length, 2)
})


test("全局 supplierDbs 在页面未挂载时也跟随账号/角色，清全部旧缓存并挡迟到 root 回包", async () => {
  const originalHttp = { ...supplierDbsHttp }
  const previousOverview = peekAccountOverview()
  let authority = { role: "super_admin", accountUuid: "admin-lin" }
  const { client } = managementClient(managementSeed(), () => authority)
  let delayList = false
  let delayDetail = false
  let resolveList!: (data: Awaited<ReturnType<typeof client.supplierDbsList>>) => void
  let resolveDetail!: (data: Awaited<ReturnType<typeof client.supplierDbGet>>) => void
  Object.assign(supplierDbsHttp, client, {
    supplierDbsList: () => {
      if (!delayList) return client.supplierDbsList()
      delayList = false
      return new Promise((resolve) => { resolveList = resolve })
    },
    supplierDbGet: (sourceId: string) => {
      if (!delayDetail) return client.supplierDbGet(sourceId)
      delayDetail = false
      return new Promise((resolve) => { resolveDetail = resolve })
    },
  })
  const commitAuthority = (role: string, accountUuid: string) => {
    authority = { role, accountUuid }
    rememberAccountOverview({ ...accountOverviewFixture,
      session: { ...accountOverviewFixture.session, role },
      accounts: [{ uuid: accountUuid, name: "同名管理员", email: "fixture@example.invalid", active: true }],
    })
  }
  try {
    supplierDbs.reset()
    commitAuthority("super_admin", "admin-lin")
    await supplierDbs.loadList()
    await supplierDbs.loadDetail("lin")
    await supplierDbs.loadDetail("chen")
    assert.equal(supplierDbs.getState().dbs.length, 3)
    const rootSnapshot = supplierDbs.getState().dbs
    delayList = true
    delayDetail = true
    const lateList = supplierDbs.loadList()
    const lateDetail = supplierDbs.loadDetail("chen", { force: true })
    commitAuthority("admin", "admin-lin")
    assert.deepEqual(supplierDbs.getState().dbs, [])
    assert.deepEqual(supplierDbs.getState().details, {})
    assert.deepEqual(supplierDbs.getState().pendingRows, [])
    await supplierDbs.loadList()
    await supplierDbs.loadDetail("lin")
    assert.deepEqual(supplierDbs.getState().dbs.map((db) => db.sourceId), ["lin"])
    assert.equal(supplierDbs.getState().dbs[0].rowCount, 2)
    commitAuthority("admin", "admin-chen")
    assert.deepEqual(supplierDbs.getState().details, {})
    await supplierDbs.loadList()
    await supplierDbs.loadDetail("chen")
    resolveList({ dbs: rootSnapshot })
    resolveDetail(managementSeed()[1])
    await Promise.all([lateList, lateDetail])
    assert.deepEqual(supplierDbs.getState().dbs.map((db) => db.sourceId), ["chen"])
    assert.deepEqual(Object.keys(supplierDbs.getState().details), ["chen"])
    assert.equal(supplierDbs.getState().dbs[0].rowCount, 1)
    assert.equal(supplierDbs.getState().details.chen.detail?.rows[0].createdBy, "admin-chen")
    commitAuthority("user", "admin-chen")
    assert.equal(supplierDbs.getState().status, "idle")
    assert.deepEqual(supplierDbs.getState().dbs, [])
    assert.deepEqual(supplierDbs.getState().details, {})
  } finally {
    Object.assign(supplierDbsHttp, originalHttp)
    supplierDbs.reset()
    if (previousOverview) rememberAccountOverview(previousOverview)
    else invalidateAccountOverview()
  }
})


test("旧属性排序会话在身份变化后停止发送后续写", async () => {
  const seed = managementSeed()
  const defs: SupplierDbPropDef[] = [1, 0].map((position, i) => ({ propId: `prop-${i}`, sourceId: "lin", name: `属性 ${i}`, type: "text", options: [], position, sellerVisible: true, createdAtMs: 1, updatedAtMs: 1 }))
  seed[0].propDefs = defs
  const { client } = managementClient(seed)
  const calls: string[] = []
  let resolveUpdate!: (data: { prop: SupplierDbPropDef }) => void
  const store = createSupplierDbsStore({ ...client, supplierDbPropUpdate: async (_sourceId, propId) => {
    calls.push(propId)
    return new Promise((resolve) => { resolveUpdate = resolve })
  } })
  await store.loadList()
  await store.loadDetail("lin")
  const reorder = store.reorderProps("lin", ["prop-0", "prop-1"])
  store.reset()
  resolveUpdate({ prop: { ...defs[0], position: 0 } })
  assert.equal((await reorder).ok, false)
  assert.deepEqual(calls, ["prop-0"])
  assert.deepEqual(store.getState().details, {})
})
