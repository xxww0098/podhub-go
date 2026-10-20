/** Editing fixtures preserve empty field defaults and property lifecycle state. */
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDb, SupplierDbDetail, SupplierDbPropDef, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { createSupplierDbsStore, type SupplierDbsClient } from "./supplier-dbs-store"

const NOW = Date.now()

export function db(over: Partial<SupplierDb> = {}): SupplierDb {
  return {
    sourceId: "src-1",
    name: "美国3C厂",
    country: "US",
    contact: "",
    internalNote: "",
    listed: true,
    icon: "🏭",
    viewPrefs: {},
    rowCount: 0,
    publishedCount: 0,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

export function row(productId: string, over: Partial<SupplierDbRow> = {}): SupplierDbRow {
  return {
    productId,
    skuId: `${productId}-sku`,
    sourceId: "src-1",
    title: `行 ${productId}`,
    platformCode: `P-${productId}`,
    descriptionCategoryId: null,
    typeId: null,
    published: false,
    archived: false,
    readiness: {
      category: false,
      prompt: false,
      fixedTags: false,
      platformPrice: false,
      ozonConfig: false,
    },
    costCents: null,
    shippingCostCents: null,
    platformPriceCents: null,
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
    promptName: "",
    promptFileName: "",
    promptContent: "",
    fixedTags: [],
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

export function propDef(over: Partial<SupplierDbPropDef> = {}): SupplierDbPropDef {
  return {
    propId: "prop-x",
    sourceId: "src-1",
    name: "材质",
    type: "text",
    options: [],
    position: 0,
    sellerVisible: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

/** 类目树样例：服饰 / 节日 / 帽子。 */
export const TREE: CategoryTreeNodeView[] = [
  {
    description_category_id: 1,
    category_name: "服饰",
    type_id: 0,
    type_name: "",
    disabled: false,
    children: [
      {
        description_category_id: 11,
        category_name: "节日",
        type_id: 0,
        type_name: "",
        disabled: false,
        children: [
          {
            description_category_id: 0,
            category_name: "",
            type_id: 101,
            type_name: "帽子",
            disabled: false,
            children: [],
          },
          {
            description_category_id: 0,
            category_name: "",
            type_id: 102,
            type_name: "围巾",
            disabled: false,
            children: [],
          },
        ],
      },
    ],
  },
]

type PropCall = { propId: string; body: Record<string, unknown> }

export function clientWithDetail(detail: SupplierDbDetail) {
  let seq = 0
  const state: SupplierDbDetail = {
    db: { ...detail.db },
    propDefs: detail.propDefs.map((item) => ({ ...item })),
    rows: detail.rows.map((item) => ({ ...item })),
  }
  const propUpdates: PropCall[] = []
  const client: SupplierDbsClient = {
    supplierDbsList: async () => ({ dbs: [state.db] }),
    supplierDbGet: async () => ({
      db: state.db,
      propDefs: state.propDefs,
      rows: state.rows,
    }),
    supplierDbCreate: async () => {
      throw new Error("unused")
    },
    supplierDbUpdate: async (sourceId, body) => {
      state.db = { ...state.db, ...body }
      return { db: state.db }
    },
    supplierDbDelete: async (sourceId) => ({ sourceId }),
    supplierDbPropCreate: async (sourceId, body) => {
      const prop: SupplierDbPropDef = {
        propId: `prop-new-${++seq}`,
        sourceId,
        name: body.name,
        type: body.type,
        options: body.options,
        position: body.position ?? state.propDefs.length,
        sellerVisible: body.sellerVisible,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      }
      state.propDefs = [...state.propDefs, prop]
      return { prop }
    },
    supplierDbPropUpdate: async (sourceId, propId, body) => {
      propUpdates.push({ propId, body: body as unknown as Record<string, unknown> })
      const prev = state.propDefs.find((item) => item.propId === propId)
      if (!prev) throw { code: "not_found", message: "属性不存在" }
      const prop = {
        ...prev,
        ...body,
        propId,
        position: body.position ?? prev.position,
        updatedAtMs: NOW,
      }
      state.propDefs = state.propDefs.map((item) =>
        item.propId === propId ? prop : item,
      )
      return { prop }
    },
    supplierDbPropDelete: async (sourceId, propId) => {
      const rowsWithValues = state.rows.filter(
        (item) => item.props[propId] !== undefined,
      ).length
      state.propDefs = state.propDefs.filter((item) => item.propId !== propId)
      return { propId, rowsWithValues }
    },
    supplierDbRowCreate: async (sourceId, body) => {
      const next = row(`prod-new-${++seq}`, {
        title: body.title,
        platformCode: body.platformCode,
        props: { ...body.props },
        costCents: body.costCents,
      })
      state.rows = [...state.rows, next]
      return { row: next }
    },
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      const prev = state.rows.find((item) => item.productId === productId)
      if (!prev) throw { code: "not_found", message: "行不存在" }
      if (body.expectedRevision !== prev.revision) {
        throw { code: "conflict", message: "revision mismatch" }
      }
      const next: SupplierDbRow = {
        ...prev,
        ...body,
        archived: (body as { archived?: boolean }).archived ?? prev.archived,
        revision: prev.revision + 1,
      }
      state.rows = state.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowDelete: async (sourceId, productId) => {
      state.rows = state.rows.filter((item) => item.productId !== productId)
      return { productId }
    },
    supplierDbRowAdjustPrice: async (sourceId, productId, body) => {
      const prev = state.rows.find((item) => item.productId === productId)
      if (!prev) throw { code: "not_found", message: "行不存在" }
      const next = { ...prev, platformPriceCents: body.priceCents }
      state.rows = state.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowPublish: async (sourceId, productId) => {
      const prev = state.rows.find((item) => item.productId === productId)
      if (!prev) throw { code: "not_found", message: "行不存在" }
      const next = { ...prev, published: true }
      state.rows = state.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowUnpublish: async (sourceId, productId) => {
      const prev = state.rows.find((item) => item.productId === productId)
      if (!prev) throw { code: "not_found", message: "行不存在" }
      const next = { ...prev, published: false }
      state.rows = state.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbUploadPresign: async () => {
      throw new Error("unused")
    },
  }
  return { client, state, propUpdates }
}

export async function storeWithDetail(detail: SupplierDbDetail) {
  const { client, state, propUpdates } = clientWithDetail(detail)
  const store = createSupplierDbsStore(client)
  await store.loadList()
  await store.loadDetail("src-1")
  return { store, state, propUpdates }
}
