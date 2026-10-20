/** Screen and command fixtures retain the original wire payloads and call ledger. */
import type {
  AdjustSupplierDbPriceRequest,
  PresignSupplierDbUploadRequest,
  SupplierDb,
  SupplierDbDetail,
  SupplierDbPropDef,
  SupplierDbRow,
  UpsertSupplierDbPropRequest,
  UpsertSupplierDbRequest,
  UpsertSupplierDbRowRequest,
} from "@/bindings/http-supplier-dbs"

import { createSupplierDbsStore, type SupplierDbsClient } from "./supplier-dbs-store"

const NOW = Date.now()

export function db(sourceId: string, name: string, over: Partial<SupplierDb> = {}): SupplierDb {
  return {
    sourceId,
    name,
    country: "CN",
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

export function row(
  productId: string,
  sourceId: string,
  over: Partial<SupplierDbRow> = {},
): SupplierDbRow {
  return {
    productId,
    skuId: `${productId}-sku`,
    sourceId,
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
    costCents: 800,
    shippingCostCents: null,
    platformPriceCents: 1600,
    suggestedRetailCents: null,
    suggestedOldPriceCents: null,
    leadTime: "3–5 天",
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

export function propDef(
  propId: string,
  sourceId: string,
  over: Partial<SupplierDbPropDef> = {},
): SupplierDbPropDef {
  return {
    propId,
    sourceId,
    name: `属性 ${propId}`,
    type: "text",
    options: [],
    position: 0,
    sellerVisible: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

type ClientCalls = {
  createDb: UpsertSupplierDbRequest[]
  updateDb: UpsertSupplierDbRequest[]
  deleteDb: string[]
  createRow: UpsertSupplierDbRowRequest[]
  updateRow: UpsertSupplierDbRowRequest[]
  deleteRow: string[]
  price: AdjustSupplierDbPriceRequest[]
  publish: string[]
  unpublish: string[]
  uploads: PresignSupplierDbUploadRequest[]
}

export function memoryClient(
  seed: SupplierDbDetail[] = [],
): { client: SupplierDbsClient; calls: ClientCalls } {
  let dbs = seed.map((detail) => ({ ...detail.db }))
  const details = new Map(
    seed.map((detail) => [
      detail.db.sourceId,
      {
        db: { ...detail.db },
        propDefs: detail.propDefs.map((def) => ({ ...def })),
        rows: detail.rows.map((item) => ({ ...item })),
      } satisfies SupplierDbDetail,
    ]),
  )
  let seq = 0
  const calls: ClientCalls = {
    createDb: [],
    updateDb: [],
    deleteDb: [],
    createRow: [],
    updateRow: [],
    deleteRow: [],
    price: [],
    publish: [],
    unpublish: [],
    uploads: [],
  }
  const bump = (sourceId: string, patch: Partial<SupplierDb>) => {
    const detail = details.get(sourceId)
    const nextDb = {
      ...(detail?.db ?? dbs.find((item) => item.sourceId === sourceId)!),
      ...patch,
      updatedAtMs: NOW,
    }
    if (detail) detail.db = nextDb
    dbs = dbs.map((item) => (item.sourceId === sourceId ? nextDb : item))
    return nextDb
  }
  const client: SupplierDbsClient = {
    supplierDbsList: async () => ({ dbs: [...dbs] }),
    supplierDbGet: async (sourceId) => {
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      return {
        db: { ...detail.db },
        propDefs: [...detail.propDefs],
        rows: [...detail.rows],
      }
    },
    supplierDbCreate: async (body) => {
      calls.createDb.push(body)
      const next = db(`src-new-${++seq}`, body.name, {
        country: body.country,
        contact: body.contact,
        internalNote: body.internalNote,
        listed: body.listed,
        icon: body.icon,
      })
      dbs = [...dbs, next]
      details.set(next.sourceId, { db: next, propDefs: [], rows: [] })
      return { db: next }
    },
    supplierDbUpdate: async (sourceId, body) => {
      calls.updateDb.push(body)
      if (!dbs.some((item) => item.sourceId === sourceId)) {
        throw { code: "not_found", message: "库不存在" }
      }
      const next = bump(sourceId, {
        name: body.name,
        country: body.country,
        contact: body.contact,
        internalNote: body.internalNote,
        listed: body.listed,
        icon: body.icon,
        viewPrefs: body.viewPrefs,
        ...(body.accountEmail ? { accountEmail: body.accountEmail } : {}),
      })
      return { db: next }
    },
    supplierDbDelete: async (sourceId) => {
      calls.deleteDb.push(sourceId)
      const detail = details.get(sourceId)
      if (detail && detail.rows.length > 0) {
        // The fetch client namespaces Cloud codes: CONFLICT arrives as
        // `cloud_conflict`, which is what the store branches on.
        throw { code: "cloud_conflict", message: "channel still referenced" }
      }
      dbs = dbs.filter((item) => item.sourceId !== sourceId)
      details.delete(sourceId)
      return { sourceId }
    },
    supplierDbPropCreate: async (sourceId, body: UpsertSupplierDbPropRequest) => {
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      const prop = propDef(`prop-${++seq}`, sourceId, {
        name: body.name,
        type: body.type,
        options: body.options,
        position: body.position ?? detail.propDefs.length,
        sellerVisible: body.sellerVisible,
      })
      detail.propDefs = [...detail.propDefs, prop]
      return { prop }
    },
    supplierDbPropUpdate: async (sourceId, propId, body) => {
      const detail = details.get(sourceId)
      const prev = detail?.propDefs.find((item) => item.propId === propId)
      if (!detail || !prev) throw { code: "not_found", message: "属性不存在" }
      const prop = {
        ...prev,
        ...body,
        propId,
        sourceId,
        position: body.position ?? prev.position,
      }
      detail.propDefs = detail.propDefs.map((item) =>
        item.propId === propId ? prop : item,
      )
      return { prop }
    },
    supplierDbPropDelete: async (sourceId, propId) => {
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      const rowsWithValues = detail.rows.filter(
        (item) => item.props[propId] !== undefined,
      ).length
      detail.propDefs = detail.propDefs.filter((item) => item.propId !== propId)
      return { propId, rowsWithValues }
    },
    supplierDbRowCreate: async (sourceId, body) => {
      calls.createRow.push(body)
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      const next = row(`prod-new-${++seq}`, sourceId, {
        title: body.title,
        platformCode: body.platformCode,
        descriptionCategoryId: body.descriptionCategoryId,
        typeId: body.typeId,
        suggestedRetailCents: body.suggestedRetailCents,
        suggestedOldPriceCents: body.suggestedOldPriceCents,
        costCents: body.costCents,
        shippingCostCents: body.shippingCostCents,
        leadTime: body.leadTime,
        size: body.size,
        material: body.material,
        craft: body.craft,
        grossWeightG: body.grossWeightG,
        brand: body.brand,
        packWidthMm: body.packWidthMm,
        packHeightMm: body.packHeightMm,
        packDepthMm: body.packDepthMm,
        packWeightG: body.packWeightG,
        contents: body.contents,
        promptName: body.promptName,
        promptFileName: body.promptFileName,
        promptContent: body.promptContent,
        fixedTags: body.fixedTags,
        description: body.description,
        internalNote: body.internalNote,
        props: { ...body.props },
      })
      detail.rows = [...detail.rows, next]
      bump(sourceId, { rowCount: detail.rows.length })
      return { row: next }
    },
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      calls.updateRow.push(body)
      const detail = details.get(sourceId)
      const prev = detail?.rows.find((item) => item.productId === productId)
      if (!detail || !prev) throw { code: "not_found", message: "行不存在" }
      if (body.expectedRevision !== prev.revision) {
        throw { code: "conflict", message: "revision mismatch" }
      }
      const next: SupplierDbRow = {
        ...prev,
        title: body.title,
        platformCode: body.platformCode,
        descriptionCategoryId: body.descriptionCategoryId,
        typeId: body.typeId,
        suggestedRetailCents: body.suggestedRetailCents,
        suggestedOldPriceCents: body.suggestedOldPriceCents,
        costCents: body.costCents,
        shippingCostCents: body.shippingCostCents,
        leadTime: body.leadTime,
        size: body.size,
        material: body.material,
        craft: body.craft,
        grossWeightG: body.grossWeightG,
        brand: body.brand,
        packWidthMm: body.packWidthMm,
        packHeightMm: body.packHeightMm,
        packDepthMm: body.packDepthMm,
        packWeightG: body.packWeightG,
        contents: body.contents,
        gallery: body.gallery,
        psd: body.psd,
        productVideos: body.productVideos,
        promptName: body.promptName,
        promptFileName: body.promptFileName,
        promptContent: body.promptContent,
        fixedTags: body.fixedTags,
        description: body.description,
        internalNote: body.internalNote,
        props: body.props,
        // archived rides the row PUT (V4 archiveRow); not on the wire type yet.
        archived:
          (body as { archived?: boolean }).archived ?? prev.archived,
        revision: prev.revision + 1,
        updatedAtMs: NOW,
      }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowDelete: async (sourceId, productId) => {
      calls.deleteRow.push(productId)
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      detail.rows = detail.rows.filter((item) => item.productId !== productId)
      bump(sourceId, { rowCount: detail.rows.length })
      return { productId }
    },
    supplierDbRowAdjustPrice: async (sourceId, productId, body) => {
      calls.price.push(body)
      const detail = details.get(sourceId)
      const prev = detail?.rows.find((item) => item.productId === productId)
      if (!detail || !prev) throw { code: "not_found", message: "行不存在" }
      const next = {
        ...prev,
        platformPriceCents: body.priceCents,
        revision: prev.revision + 1,
        updatedAtMs: NOW,
      }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowPublish: async (sourceId, productId) => {
      calls.publish.push(productId)
      const detail = details.get(sourceId)
      const prev = detail?.rows.find((item) => item.productId === productId)
      if (!detail || !prev) throw { code: "not_found", message: "行不存在" }
      const next = { ...prev, published: true }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      bump(sourceId, { publishedCount: detail.rows.filter((i) => i.published).length })
      return { row: next }
    },
    supplierDbRowUnpublish: async (sourceId, productId) => {
      calls.unpublish.push(productId)
      const detail = details.get(sourceId)
      const prev = detail?.rows.find((item) => item.productId === productId)
      if (!detail || !prev) throw { code: "not_found", message: "行不存在" }
      const next = { ...prev, published: false }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      bump(sourceId, { publishedCount: detail.rows.filter((i) => i.published).length })
      return { row: next }
    },
    supplierDbUploadPresign: async (sourceId, body) => {
      calls.uploads.push(body)
      return {
        upload: {
          upload: { url: `https://bucket.invalid/${sourceId}/${body.filename}`,
            headers: { content_type: body.contentType, if_none_match: "*" }, expires_at_ms: Date.now() + 600000 },
          uploadTicket: `receipt-${sourceId}-${body.sha256}`,
        },
      }
    },
  }
  return { client, calls }
}

export async function readyStore(seed: SupplierDbDetail[] = []) {
  const { client, calls } = memoryClient(seed)
  const store = createSupplierDbsStore(client)
  await store.loadList()
  return { store, calls }
}
