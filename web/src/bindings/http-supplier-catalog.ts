import { api, request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { supplierUploadData, type PresignSupplierDbUploadRequest } from "./http-supplier-dbs"
import type { PartEtag } from "./multipart-upload"
import type { SupplierDb, SupplierDbPropDef, SupplierDbRow, UpsertSupplierDbRowRequest } from "./http-supplier-dbs"

export type CatalogSource = Pick<SupplierDb, "sourceId" | "name" | "country" | "contact" | "internalNote" | "listed" | "icon" | "rowCount" | "publishedCount" | "createdAtMs" | "updatedAtMs">
export type CatalogRowInput = Omit<UpsertSupplierDbRowRequest, "promptName" | "promptFileName" | "promptContent" | "fixedTags" | "expectedRevision"> & { revision?: number }
export type CatalogRow = CatalogRowInput & Pick<SupplierDbRow, "productId" | "skuId" | "sourceId" | "published" | "readiness" | "platformPriceCents" | "revision" | "createdAtMs" | "updatedAtMs">
export type CatalogSourceDetail = { source: CatalogSource; propDefs: SupplierDbPropDef[]; rows: CatalogRow[] }

// This surface returns the DTO directly, without the admin API's data envelope.
const send = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  request<T>(method, path, body, {}, undefined, undefined, { responseBody: "json" })
const rowPath = (sourceId: string, productId: string) => route("supplierCatalogSourcesBySourceIdRowsByProductId", { source_id: sourceId, product_id: productId })

export function catalogRowInput(row: CatalogRowInput): CatalogRowInput {
  const { title, platformCode, descriptionCategoryId, typeId, suggestedRetailCents, suggestedOldPriceCents,
    costCents, shippingCostCents, leadTime, size, variantGroup, material, craft, grossWeightG, brand,
    packWidthMm, packHeightMm, packDepthMm, packWeightG, contents, gallery, psd, productVideos,
    description, internalNote, props, revision, archived } = row
  return { title, platformCode, descriptionCategoryId, typeId, suggestedRetailCents, suggestedOldPriceCents,
    costCents, shippingCostCents, leadTime, size, variantGroup, material, craft, grossWeightG, brand,
    packWidthMm, packHeightMm, packDepthMm, packWeightG, contents, gallery, psd, productVideos,
    description, internalNote, props, revision, archived }
}

export const supplierCatalogHttp = {
  presign: async (sourceId: string, body: PresignSupplierDbUploadRequest) => {
    const { contentType, ...input } = body
    return supplierUploadData(await api.post<components["schemas"]["SupplierDbUploadPresignResponse"]["data"]>(route("supplierCatalogSourcesBySourceIdUploads", { source_id: sourceId }), { ...input, content_type: contentType }))
  },
  confirm: (sourceId: string, uploadTicket: string, signal?: AbortSignal, parts?: PartEtag[]) =>
    request<{ key: string; public_url: string }>("POST", route("supplierCatalogSourcesBySourceIdUploadsConfirm", { source_id: sourceId }),
      { upload_ticket: uploadTicket, ...(parts ? { parts: parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })) } : {}) }, {}, parts ? 60_000 : 65 * 60 * 1000, undefined, { callerSignal: signal, reportOwner: "caller" }),
  abort: (sourceId: string, uploadTicket: string) => api.post<void>(route("supplierCatalogSourcesBySourceIdUploadsAbort", { source_id: sourceId }), { upload_ticket: uploadTicket }, 30_000),
  sources: () => send<{ sources: CatalogSource[] }>("GET", route("supplierCatalogSources")),
  detail: (sourceId: string) => send<CatalogSourceDetail>("GET", route("supplierCatalogSourcesBySourceId", { source_id: sourceId })),
  create: (sourceId: string, input: CatalogRowInput) => send<CatalogRow>("POST", route("supplierCatalogSourcesBySourceIdRows", { source_id: sourceId }), input),
  update: (sourceId: string, productId: string, input: CatalogRowInput) => send<CatalogRow>("PUT", rowPath(sourceId, productId), input),
  publish: (sourceId: string, productId: string, on: boolean) => send<CatalogRow>("POST", route(on ? "supplierCatalogSourcesBySourceIdRowsByProductIdPublish" : "supplierCatalogSourcesBySourceIdRowsByProductIdUnpublish", { source_id: sourceId, product_id: productId })),
  archive: (sourceId: string, productId: string) => send<void>("DELETE", rowPath(sourceId, productId)),
}
