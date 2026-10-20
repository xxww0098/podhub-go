import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  SupplierDb,
  SupplierDbDetail,
  SupplierDbRow,
  UpsertSupplierDbRowRequest,
} from "@/bindings/http-supplier-dbs"

import {
  SupplierRowMedia,
  formatDurationMs,
  moveItem,
  promoteToCover,
  saveRowMedia,
} from "./supplier-row-media"
import {
  createSupplierDbsStore,
  type SupplierDbsClient,
} from "./supplier-dbs-store"
import { toast } from "@/components/ui/toast"

const NOW = Date.now()

function row(over: Partial<SupplierDbRow> = {}): SupplierDbRow {
  return {
    productId: "p1",
    skuId: "p1-sku",
    sourceId: "src-1",
    title: "圣诞帽",
    platformCode: "P001",
    descriptionCategoryId: 11,
    typeId: 101,
    published: false,
    archived: false,
    readiness: {
      category: true,
      prompt: true,
      fixedTags: true,
      platformPrice: true,
      ozonConfig: true,
    },
    costCents: 800,
    shippingCostCents: null,
    platformPriceCents: 1600,
    suggestedRetailCents: null,
    suggestedOldPriceCents: null,
    leadTime: "",
    size: "",
    material: "",
    craft: "",
    grossWeightG: null,
    brand: "",
    packWidthMm: null,
    packHeightMm: null,
    packDepthMm: null,
    packWeightG: null,
    contents: "",
    gallery: [],
    psd: [],
    productVideos: [],
    promptName: "圣诞通用",
    promptFileName: "",
    promptContent: "识别红白配色",
    fixedTags: Array.from({ length: 16 }, (_, i) => `#tag${i}`),
    description: "",
    internalNote: "",
    props: {},
    revision: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    createdBy: "tester",
    ...over,
  }
}

function db(over: Partial<SupplierDb> = {}): SupplierDb {
  return {
    sourceId: "src-1",
    name: "美国3C厂",
    country: "US",
    contact: "",
    internalNote: "",
    listed: true,
    icon: "🏭",
    viewPrefs: {},
    rowCount: 1,
    publishedCount: 0,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

const GALLERY = [
  { url: "https://cdn.invalid/a.png", w: 100, h: 80 },
  { url: "https://cdn.invalid/b.png", w: 90, h: 90 },
  { url: "https://cdn.invalid/c.png", w: 120, h: 60 },
]

/** 只实现本测试用到的两端；其余方法一律 throw（真调用了会立刻暴露）。 */
function memoryClient(
  seed: SupplierDbDetail,
): { client: SupplierDbsClient; updates: UpsertSupplierDbRowRequest[] } {
  const detail: SupplierDbDetail = {
    db: { ...seed.db },
    propDefs: [...seed.propDefs],
    rows: seed.rows.map((item) => ({ ...item })),
  }
  const updates: UpsertSupplierDbRowRequest[] = []
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected client call: ${name}`)
  }
  const client: SupplierDbsClient = {
    supplierDbsList: unexpected("list"),
    supplierDbGet: async (sourceId) => {
      assert.equal(sourceId, detail.db.sourceId)
      return {
        db: { ...detail.db },
        propDefs: [...detail.propDefs],
        rows: detail.rows.map((item) => ({ ...item })),
      }
    },
    supplierDbCreate: unexpected("dbCreate"),
    supplierDbUpdate: unexpected("dbUpdate"),
    supplierDbDelete: unexpected("dbDelete"),
    supplierDbPropCreate: unexpected("propCreate"),
    supplierDbPropUpdate: unexpected("propUpdate"),
    supplierDbPropDelete: unexpected("propDelete"),
    supplierDbRowCreate: unexpected("rowCreate"),
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      updates.push(body)
      const prev = detail.rows.find((item) => item.productId === productId)
      assert.ok(prev, "row must exist")
      if (body.expectedRevision !== prev.revision) {
        throw Object.assign(new Error("revision mismatch"), {
          code: "cloud_conflict",
        })
      }
      const next: SupplierDbRow = {
        ...prev,
        gallery: body.gallery,
        psd: body.psd,
        productVideos: body.productVideos,
        revision: prev.revision + 1,
        updatedAtMs: NOW,
      }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowDelete: unexpected("rowDelete"),
    supplierDbRowAdjustPrice: unexpected("price"),
    supplierDbRowPublish: unexpected("publish"),
    supplierDbRowUnpublish: unexpected("unpublish"),
    supplierDbUploadPresign: unexpected("presign"),
  }
  return { client, updates }
}

async function loadedStore(seed: SupplierDbDetail) {
  const { client, updates } = memoryClient(seed)
  const store = createSupplierDbsStore(client)
  await store.loadDetail(seed.db.sourceId)
  return { store, updates }
}

// ---------- 纯函数 ----------

test("moveItem/promoteToCover：数组序即显示序，首图即封面", () => {
  const items = ["a", "b", "c", "d"]
  assert.deepEqual(moveItem(items, 0, 2), ["b", "c", "a", "d"])
  assert.deepEqual(moveItem(items, 3, 0), ["d", "a", "b", "c"])
  assert.deepEqual(moveItem(items, 1, 1), items)
  assert.deepEqual(moveItem(items, -1, 2), items)
  assert.deepEqual(moveItem(items, 2, 9), items)
  assert.deepEqual(promoteToCover(items, 2), ["c", "a", "b", "d"])
})

test("formatDurationMs → m:ss", () => {
  assert.equal(formatDurationMs(0), "0:00")
  assert.equal(formatDurationMs(3000), "0:03")
  assert.equal(formatDurationMs(65_000), "1:05")
  assert.equal(formatDurationMs(-5), "0:00")
})

// ---------- 渲染 ----------

test("媒体区三组：图集网格带封面徽标，PSD 名+大小+下载，视频封面+时长", async () => {
  const media = row({
    gallery: GALLERY,
    psd: [{ url: "https://cdn.invalid/hat.psd", name: "hat.psd", bytes: 12_000_000 }],
    productVideos: [
      {
        url: "https://cdn.invalid/v.mp4",
        coverUrl: "https://cdn.invalid/vc.png",
        durationMs: 5000,
      },
      { url: "https://cdn.invalid/v2.mp4", coverUrl: "", durationMs: 65_000 },
    ],
  })
  const { store } = await loadedStore({ db: db(), propDefs: [], rows: [media] })
  const html = renderToStaticMarkup(
    <SupplierRowMedia row={media} store={store} />,
  )
  // 三组锚点 + 上传入口
  for (const name of ["图集", "PSD", "视频"]) {
    assert.ok(html.includes(`data-supplier-row-media="${name}"`), name)
  }
  assert.match(html, /上传图片/)
  assert.match(html, /上传 PSD/)
  assert.match(html, /上传视频/)
  // 图集：首图封面徽标 + 缩略图
  assert.match(html, /封面/)
  assert.match(html, /src="https:\/\/cdn\.invalid\/a\.png"/)
  assert.match(html, /data-supplier-gallery-item=""/)
  // PSD：文件名 + 大小 + 下载链接
  assert.match(html, /hat\.psd/)
  assert.match(html, /11 MB/)
  assert.match(html, /href="https:\/\/cdn\.invalid\/hat\.psd"/)
  assert.match(html, /下载/)
  // 视频：封面图 + 时长；无封面的走占位图标
  assert.match(html, /src="https:\/\/cdn\.invalid\/vc\.png"/)
  assert.match(html, /0:05/)
  assert.match(html, /1:05/)
  assert.match(html, /设封面/)
  // 纪律：任何失败都不落内联错误块
  assert.doesNotMatch(html, /role="alert"/)
})

test("空态：三个上传入口都在，无内联错误", async () => {
  const empty = row()
  const { store } = await loadedStore({ db: db(), propDefs: [], rows: [empty] })
  const html = renderToStaticMarkup(<SupplierRowMedia row={empty} store={store} />)
  assert.match(html, /未上传/)
  assert.match(html, /20MB/)
  assert.match(html, /500MB/)
  assert.match(html, /200MB/)
  // 上传契约：图集必传，PSD / 视频选传 —— 标记落各自分组头部
  const group = (name: string, next?: string) =>
    html.slice(
      html.indexOf(`data-supplier-row-media="${name}"`),
      next ? html.indexOf(`data-supplier-row-media="${next}"`) : undefined,
    )
  assert.match(group("图集", "PSD"), /必传/)
  assert.match(group("PSD", "视频"), /选传/)
  assert.match(group("视频"), /选传/)
  assert.doesNotMatch(html, /role="alert"/)
})

// ---------- 写行持久化（内存 store） ----------

test("图集重排/封面/删除都经 updateRow 整行 upsert + CAS", async () => {
  const { store, updates } = await loadedStore({
    db: db(),
    propDefs: [],
    rows: [row({ gallery: GALLERY, revision: 7 })],
  })
  // 拖到第 2 位 → 新数组序落行
  const reordered = moveItem(GALLERY, 0, 2)
  assert.equal(
    await saveRowMedia(store, "src-1", "p1", { gallery: reordered }),
    true,
  )
  assert.equal(updates[0].expectedRevision, 7, "CAS 带当前 revision")
  assert.deepEqual(
    updates[0].gallery.map((item) => item.url),
    [GALLERY[1].url, GALLERY[2].url, GALLERY[0].url],
  )
  // untrained 字段随行——整行 upsert 不丢兄弟字段
  assert.equal(updates[0].title, "圣诞帽")
  assert.equal(updates[0].platformCode, "P001")

  // 服务端返回 revision 8；下一次写行带着新 CAS
  const current = store.getState().details["src-1"].detail!.rows[0]
  assert.equal(current.revision, 8)
  const promoted = promoteToCover(current.gallery, 1)
  assert.equal(
    await saveRowMedia(store, "src-1", "p1", { gallery: promoted }),
    true,
  )
  assert.equal(updates[1].expectedRevision, 8)
  assert.equal(
    updates[1].gallery[0].url,
    "https://cdn.invalid/c.png",
    "封面 = 数组首位",
  )

  // 删除 = 从数组摘除后整行写
  const afterDelete = store.getState().details["src-1"].detail!.rows[0].gallery
  assert.equal(
    await saveRowMedia(store, "src-1", "p1", {
      gallery: afterDelete.filter((_, i) => i !== 0),
    }),
    true,
  )
  assert.equal(updates[2].gallery.length, 2)
})

test("写行失败只走 notify，不留内联态", async () => {
  const { client } = memoryClient({
    db: db(),
    propDefs: [],
    rows: [row({ gallery: GALLERY })],
  })
  client.supplierDbRowUpdate = async () => {
    throw Object.assign(new Error("云端拒绝"), { code: "cloud_conflict" })
  }
  const store = createSupplierDbsStore(client)
  await store.loadDetail("src-1")
  const ok = await saveRowMedia(store, "src-1", "p1", { gallery: [] })
  assert.equal(ok, false)
  toast.close()
})
