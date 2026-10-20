/** Independent management regression data; the simulated server enforces creator ownership. */
import type { SupplierDb, SupplierDbDetail, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { EMPTY_ROW_REQUEST, type SupplierDbsClient } from "@/features/supplier-dbs/supplier-dbs-store"

export function managementDb(sourceId: string, createdBy?: string, creatorName?: string): SupplierDb {
  return { sourceId, name: sourceId === "lin" ? "林的印刷厂" : sourceId === "chen" ? "陈的服装厂" : "历史归属库", country: "CN", contact: "", internalNote: "", listed: true, icon: "", viewPrefs: {}, rowCount: 0, publishedCount: 0, createdAtMs: 1, updatedAtMs: 1, createdBy, creatorName }
}
export function managementRow(productId: string, sourceId: string, createdBy = "admin-lin", title = "印花帆布袋"): SupplierDbRow {
  return { ...EMPTY_ROW_REQUEST, archived: false, productId, skuId: `${productId}-sku`, sourceId, title, platformCode: productId.toUpperCase(), published: false,
    readiness: { category: false, prompt: false, fixedTags: false, platformPrice: true, ozonConfig: false }, costCents: 1200, platformPriceCents: 1800, size: "35×40cm", gallery: [{ url: "/site/product-tote.jpg", w: 720, h: 900 }],
    revision: 1, createdAtMs: 1, updatedAtMs: 1, createdBy, creatorName: createdBy === "admin-lin" ? "林管理员" : "陈管理员" }
}
export function managementSeed(): SupplierDbDetail[] {
  return [
    { db: { ...managementDb("lin", "admin-lin", "林管理员"), rowCount: 2 }, propDefs: [], rows: [managementRow("lin-1", "lin"), managementRow("lin-2", "lin", "admin-lin", "棉质手提袋")] },
    { db: { ...managementDb("chen", "admin-chen", "陈管理员"), rowCount: 1 }, propDefs: [], rows: [managementRow("chen-1", "chen", "admin-chen", "印花短袖")] },
    { db: managementDb("legacy"), propDefs: [], rows: [] },
  ]
}

export function managementClient(seed: SupplierDbDetail[], authority: () => { role: string; accountUuid: string } = () => ({ role: "super_admin", accountUuid: "root" })) {
  const details = new Map(seed.map((detail) => [detail.db.sourceId, structuredClone(detail)]))
  const calls: { kind: string; sourceId: string; productId?: string; revision?: number | null }[] = []
  let sequence = 0
  const allowed = (detail: SupplierDbDetail) => authority().role === "super_admin" || detail.db.createdBy === authority().accountUuid
  const visibleRows = (detail: SupplierDbDetail) => detail.rows.filter((row) => authority().role === "super_admin" || row.createdBy === authority().accountUuid)
  const view = (detail: SupplierDbDetail) => {
    const rows = visibleRows(detail)
    return { ...detail, db: { ...detail.db, rowCount: rows.filter((row) => !row.archived).length, publishedCount: rows.filter((row) => !row.archived && row.published).length }, rows }
  }
  const get = (sourceId: string) => {
    const detail = details.get(sourceId)
    if (!detail || !allowed(detail)) throw { code: "cloud_not_found", message: "不存在" }
    return detail
  }
  const changeRow = (sourceId: string, productId: string, kind: string, patch: Partial<SupplierDbRow>) => {
    const detail = get(sourceId)
    const row = detail.rows.find((item) => item.productId === productId)!
    calls.push({ kind, sourceId, productId })
    const next = { ...row, ...patch, revision: row.revision + 1 }
    detail.rows = detail.rows.map((item) => item.productId === productId ? next : item)
    return { row: structuredClone(next) }
  }
  const unsupported = async (): Promise<never> => { throw new Error("Unsupported fixture operation") }
  const client: SupplierDbsClient = {
    supplierDbsList: async () => ({ dbs: [...details.values()].filter(allowed).map((detail) => structuredClone(view(detail).db)) }),
    supplierDbGet: async (sourceId) => structuredClone(view(get(sourceId))),
    supplierDbCreate: async (body) => {
      const sourceId = `created-${++sequence}`
      const db = { ...managementDb(sourceId, authority().accountUuid, "当前管理员"), ...body }
      details.set(sourceId, { db, propDefs: [], rows: [] })
      return { db }
    },
    supplierDbUpdate: async (sourceId, body) => {
      const detail = get(sourceId)
      detail.db = { ...detail.db, ...body }
      calls.push({ kind: "db-update", sourceId })
      return { db: structuredClone(detail.db) }
    },
    supplierDbDelete: async (sourceId) => { get(sourceId); details.delete(sourceId); return { sourceId } },
    supplierDbRowCreate: async (sourceId, body) => {
      const detail = get(sourceId)
      const row = { ...managementRow(`created-row-${++sequence}`, sourceId, authority().accountUuid), ...body, archived: false }
      detail.rows.push(row)
      calls.push({ kind: "create", sourceId })
      return { row: structuredClone(row) }
    },
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      const previous = get(sourceId).rows.find((row) => row.productId === productId)!
      if (body.expectedRevision !== previous.revision) throw { code: "cloud_conflict" }
      calls.push({ kind: "CAS", sourceId, productId, revision: body.expectedRevision })
      return changeRow(sourceId, productId, body.archived ? "archive" : "update", body)
    },
    supplierDbRowDelete: async (sourceId, productId) => {
      const detail = get(sourceId)
      detail.rows = detail.rows.filter((row) => row.productId !== productId)
      calls.push({ kind: "delete", sourceId, productId })
      return { productId }
    },
    supplierDbRowPublish: async (sourceId, productId) => changeRow(sourceId, productId, "publish", { published: true }),
    supplierDbRowUnpublish: async (sourceId, productId) => changeRow(sourceId, productId, "unpublish", { published: false }),
    supplierDbRowAdjustPrice: async (sourceId, productId, body) => changeRow(sourceId, productId, "price", { platformPriceCents: body.priceCents }),
    supplierDbPropCreate: unsupported, supplierDbPropUpdate: unsupported, supplierDbPropDelete: unsupported, supplierDbUploadPresign: unsupported,
  }
  return { client, calls, details }
}
