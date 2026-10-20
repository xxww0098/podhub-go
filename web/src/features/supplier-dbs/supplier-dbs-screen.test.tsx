/** Library navigation, forms, permissions and screen/wire contracts. */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import { SupplierDbsScreen } from "./supplier-dbs-screen"
import { createSupplierDbsStore, type SupplierDbsClient } from "./supplier-dbs-store"
import { db, row, propDef, memoryClient, readyStore } from "./supplier-dbs-screen-fixtures"

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8")

const screenSource = read("./supplier-dbs-screen.tsx") + read("./supplier-issued-password.tsx")
const tableSource = read("./supplier-db-table.tsx") + read("./supplier-db-header.tsx")
const panelSource = read("./supplier-row-panel.tsx")
const listSource = read("./supplier-db-list.tsx")
const bindingsSource = read("../../bindings/http-supplier-dbs.ts")


test("库侧栏 renders one card per database, counts, and a single 新建入口", async () => {
  const { store } = await readyStore([
    { db: db("src-1", "美国3C厂", { country: "US", rowCount: 126, publishedCount: 86 }), propDefs: [], rows: [] },
    { db: db("src-2", "美东厂", { rowCount: 40, publishedCount: 40 }), propDefs: [], rows: [] },
  ])
  const html = renderToStaticMarkup(
    <SupplierDbsScreen role="admin" store={store} />,
  )
  assert.match(html, /data-supplier-dbs="manage"/)
  assert.match(html, /data-supplier-dbs="list"/)
  assert.match(html, /aria-label="平台货源"/)
  assert.match(html, /美国3C厂/)
  assert.match(html, /美东厂/)
  // 商品数与公开态是侧栏卡片的第二行。
  assert.match(html, />126</)
  assert.match(html, / · 公开</)
  assert.match(html, /data-supplier-db-row="src-1"/)
  // master-detail：没有 openId 时回落首库——右栏直接挂加载态。
  assert.match(html, /data-supplier-dbs="detail-loading"/)
  assert.match(html, /新建平台货源/)
  assert.equal(html.match(/新建平台货源/g)?.length, 1, "只有一个建库入口")
  // 侧栏不做行级操作钮：搜索在，勾选/行内开关/行尾编辑与删除都收进库页「库设置」。
  // 双击卡片是同一张改库对话框的捷径，标题提示即可发现。
  assert.match(html, /title="双击编辑库信息"/)
  assert.match(html, /aria-label="搜索平台货源"/)
  assert.doesNotMatch(html, /aria-label="选择全部库"/)
  assert.doesNotMatch(html, /aria-label="美国3C厂：对卖家可见"/)
  assert.doesNotMatch(html, /aria-label="编辑 美国3C厂"/)
  assert.doesNotMatch(html, /aria-label="删除 美国3C厂"/)
  // super_admin is staff too, so the staff gate admits it.
  const superAdmin = renderToStaticMarkup(
    <SupplierDbsScreen role="super_admin" store={store} />,
  )
  assert.match(superAdmin, /data-supplier-dbs="list"/)
})


test("改库走库页「库设置」；侧栏双击打开同一张编辑表单", async () => {
  // SSR/Portal 拿不到弹窗正文——钉住静态契约：库页头部暴露「库设置」，
  // 编辑走屏级 SupplierDbFormDialog；侧栏没有行级操作钮，双击复用 openEdit。
  assert.match(tableSource, /库设置/)
  assert.match(tableSource, /onEditDb/)
  assert.match(listSource, /export function SupplierDbRail/)
  const railView = listSource.slice(
    listSource.indexOf("export function SupplierDbRail"),
    listSource.indexOf("export function SupplierDbEmptyState"),
  )
  assert.doesNotMatch(railView, /aria-label=\{`编辑/)
  assert.doesNotMatch(railView, /aria-label=\{`删除/)
  assert.match(railView, /onDoubleClick=\{\(\) => onEdit\(db\.sourceId\)\}/)
  // 屏把编辑回调接进库页，并把同一 openEdit 交给侧栏双击。
  assert.match(screenSource, /onEditDb=\{/)
  assert.match(screenSource, /onEdit=\{openEdit\}/)
  const { store } = await readyStore([
    {
      db: db("src-1", "美国3C厂", { country: "US", rowCount: 2, publishedCount: 1 }),
      propDefs: [],
      rows: [row("p1", "src-1", { title: "圣诞帽", platformCode: "P001" })],
    },
  ])
  await store.loadDetail("src-1")
  const detailHtml = renderToStaticMarkup(
    <SupplierDbsScreen role="admin" store={store} initialSourceId="src-1" />,
  )
  assert.match(detailHtml, /data-supplier-dbs="detail"/)
  assert.match(detailHtml, /库设置/)
})


test("建库与改库是同一张表单：字段一致，建库多厂家邮箱和「套用厂家模板」", () => {
  // 弹窗挂在 Portal 上，SSR 拿不到正文——按源码钉住字段归属；
  // 真实交互在 tests/supplier-dbs-interactions.browser.tsx 里跑。
  const form = read("./supplier-db-form-dialog.tsx")
  for (const field of [
    "supplier-db-name",
    "supplier-db-icon",
    "supplier-db-country",
    "supplier-db-contact",
    "supplier-db-note",
    "supplier-db-listed",
    "supplier-db-accepts-delegate",
  ]) {
    assert.match(form, new RegExp(field), `form missing ${field}`)
  }
  assert.match(form, /supplier-db-account-email/)
  assert.match(form, /\{creating\s*\?\s*toggle\(\s*"supplier-db-template"/)
})


test("刷新停在库页：地址里的 ?open= 就是打开态（没有别的导航态可丢）", async () => {
  // 复现用户路径：点库行进库后地址带 ?open=，刷新（= 只有地址的重新挂载）
  // 必须还画同一个库页，而不是跳回货源管理列表。
  const detail: SupplierDbDetail = {
    db: db("src-1", "数字画厂家", { rowCount: 1 }),
    propDefs: [],
    rows: [row("p1", "src-1", { title: "数字油画", platformCode: "xw-000002" })],
  }
  const { store } = await readyStore([detail])
  await store.loadDetail("src-1")
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = {
    location: new URL("http://localhost/?screen=supplier-dbs&open=src-1"),
    history: { replaceState() {} },
  }
  try {
    const html = renderToStaticMarkup(
      <SupplierDbsScreen role="admin" store={store} />,
    )
    assert.match(html, /data-supplier-dbs="manage"/)
    assert.match(html, /data-supplier-dbs="detail"/)
    // master-detail：侧栏常驻，库表在右栏。
    assert.match(html, /data-supplier-dbs="list"/)
    assert.match(html, /数字油画/)
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
})


test("list→detail transition: selected db renders the product table pane", async () => {
  const detail: SupplierDbDetail = {
    db: db("src-1", "美国3C厂", { country: "US", rowCount: 2, publishedCount: 1 }),
    propDefs: [propDef("prop-color", "src-1", { name: "颜色", type: "select", options: [{ value: "red", label: "红" }] })],
    rows: [
      row("p1", "src-1", { title: "圣诞帽", platformCode: "P001", published: true }),
      row("p2", "src-1", { title: "围巾", platformCode: "P002" }),
    ],
  }
  const { store } = await readyStore([detail])
  await store.loadDetail("src-1")
  const html = renderToStaticMarkup(
    <SupplierDbsScreen role="admin" store={store} initialSourceId="src-1" />,
  )
  assert.match(html, /data-supplier-dbs="manage"/)
  assert.match(html, /data-supplier-dbs="detail"/)
  // master-detail：侧栏常驻在左，库表在右。
  assert.match(html, /data-supplier-dbs="list"/)
  // 库名上头部标题 + 数据表 aria-label。
  assert.match(html, /美国3C厂/)
  assert.match(html, /aria-label="美国3C厂 商品表"/)
  assert.match(html, /圣诞帽/)
  assert.match(html, /P001/)
  // 统计页签 = 筛选预设：全部商品 / 已上架 / 待完善。
  assert.match(html, /data-stat="all"/)
  assert.match(html, /data-stat="published"/)
  assert.match(html, /data-stat="incomplete"/)
  assert.match(html, /全部商品/)
  assert.match(html, /待完善/)
  assert.match(html, /共 2 条/)
  assert.match(html, /新建商品/)
  // 自定义属性不再是表格列——进「库设置 → 自定义属性」。
  assert.doesNotMatch(html, /data-supplier-db-prop="prop-color"/)
  assert.match(html, /库设置/)
  // 勾选列 + 分页脚。
  assert.match(html, /aria-label="选择本页全部行"/)
  assert.match(html, /aria-label="每页条数"/)
  assert.doesNotMatch(html, /role="alert"/)
})


test("non-staff roles see the gate, not the surface", async () => {
  const { store } = await readyStore()
  const html = renderToStaticMarkup(
    <SupplierDbsScreen role="user" store={store} />,
  )
  assert.match(html, /data-supplier-dbs="forbidden"/)
  assert.match(html, /仅平台管理员/)
  assert.doesNotMatch(html, /新建平台货源/)
  assert.doesNotMatch(html, /data-supplier-dbs="list"/)
})


test("a failed list read shows icon + retry, never an inline error", async () => {
  const { client } = memoryClient()
  const failing: SupplierDbsClient = {
    ...client,
    supplierDbsList: async () => {
      throw { code: "internal", message: "backend down" }
    },
  }
  const store = createSupplierDbsStore(failing)
  await store.loadList()
  assert.equal(store.getState().status, "error")
  const html = renderToStaticMarkup(
    <SupplierDbsScreen role="admin" store={store} />,
  )
  assert.match(html, /data-supplier-dbs="error"/)
  assert.match(html, /读不到平台货源/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /backend down/, "host copy stays out of the DOM")
  assert.doesNotMatch(html, /role="alert"/)
})


test("wire contract: bindings keep DTO keys camelCase and resolve generated route keys", () => {
  // Post-regen: paths live in `ROUTES`; the binding fills `route(...)` keys —
  // never a literal — and maps the frozen wire's `prop_defs` back to the
  // app-facing `propDefs`.
  const codeLines = bindingsSource
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return (
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("/*")
      )
    })
    .join("\n")
  assert.doesNotMatch(codeLines, /["'`]\/api\//)
  assert.match(bindingsSource, /route\("adminSupplierDbs"/)
  assert.match(bindingsSource, /adminSupplierDbsBySourceIdUploads/)
  assert.match(bindingsSource, /adminSupplierDbsBySourceIdRowsByProductIdPrice/)
  assert.match(bindingsSource, /adminSupplierDbsBySourceIdRowsByProductIdPublish/)
  assert.match(bindingsSource, /prop_defs/)
  // Nonmodal Sheet owns Escape/focus; parent restores the triggering row.
  assert.match(panelSource, /data-supplier-row-panel=""/)
  assert.match(panelSource, /modal=\{false\}/)
  assert.match(panelSource, /showOverlay=\{false\}/)
  assert.match(panelSource, /initialFocus=\{closeRef\}/)
  assert.match(tableSource, /requestAnimationFrame\(\(\) => trigger\.focus\(\)\)/)
  assert.match(listSource, /新建平台货源/)
  assert.match(read("./supplier-db-form-dialog.tsx"), /厂家模板/)
  assert.match(read("./supplier-db-form-dialog.tsx"), /换绑并保存/)
  assert.match(screenSource, /复制邮箱和密码/)
  assert.match(screenSource, /showCloseButton=\{false\}/)
  // The screen stays open to platform staff. Rebind is the super-admin exception.
  assert.match(screenSource, /isPlatformStaffRole/)
  assert.match(screenSource, /canRebind=\{isPlatformSuperAdminRole/)
})
