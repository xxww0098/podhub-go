/** 平台商品库管理 HTTP client. Wire types mirror the camelCase DTO; prop_defs is propDefs. */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type {
  SupplierPromptPreview,
  SupplierDbDetail,
  UpsertSupplierDbRequest,
  UpsertSupplierDbPropRequest,
  UpsertSupplierDbRowRequest,
  AdjustSupplierDbPriceRequest,
  PresignSupplierDbUploadRequest,
  SupplierDbPropDeleteResult,
  SupplierDbListData,
  SupplierDbMutationData,
  SupplierDbPropMutationData,
  SupplierDbRowMutationData,
  SupplierDbOkData,
  SupplierDbRowOkData,
  SupplierDbUploadData
} from "./http-supplier-dbs-types"
export type * from "./http-supplier-dbs-types"

export function supplierUploadData(data: components["schemas"]["SupplierDbUploadPresignResponse"]["data"]): SupplierDbUploadData {
  const target = data.upload
  return { upload: {
    upload: target.upload,
    uploadTicket: target.upload_ticket,
    alreadyPresent: target.already_present,
    multipart: target.multipart ? {
      uploadId: target.multipart.upload_id, partSize: target.multipart.part_size, ticket: target.multipart.ticket,
      parts: target.multipart.parts.map((part) => ({ partNumber: part.part_number, url: part.url, byteLength: part.byte_length, expiresAtMs: part.expires_at_ms })),
    } : undefined,
  } }
}

// ---------- paths ----------
// All endpoints sit under /admin/supplier-dbs in api/routes.ts
// (adminSupplierDbs*); the path literal stays with that authority.

const dbPath = (sourceId: string) =>
  route("adminSupplierDbsBySourceId", { source_id: sourceId })
const propsPath = (sourceId: string) =>
  route("adminSupplierDbsBySourceIdProps", { source_id: sourceId })
const propPath = (sourceId: string, propId: string) =>
  route("adminSupplierDbsBySourceIdPropsByPropId", {
    source_id: sourceId,
    prop_id: propId,
  })
const rowsPath = (sourceId: string) =>
  route("adminSupplierDbsBySourceIdRows", { source_id: sourceId })
const rowPath = (sourceId: string, productId: string) =>
  route("adminSupplierDbsBySourceIdRowsByProductId", {
    source_id: sourceId,
    product_id: productId,
  })
const uploadsPath = (sourceId: string) =>
  route("adminSupplierDbsBySourceIdUploads", { source_id: sourceId })
export const supplierDbsHttp = {
  supplierPromptPreview: (sourceId: string, productId: string, body: { brief: string; fixedTags: string[] }) =>
    api.post<SupplierPromptPreview>(route("adminSupplierDbsBySourceIdRowsByProductIdPromptPreview", {
      source_id: sourceId,
      product_id: productId,
    }), body),

  supplierDbsList: () =>
    api.get<SupplierDbListData>(route("adminSupplierDbs")),

  supplierDbGet: (sourceId: string) =>
    api.get<SupplierDbDetail>(dbPath(sourceId)),

  supplierDbCreate: (body: UpsertSupplierDbRequest) =>
    api.post<SupplierDbMutationData>(route("adminSupplierDbs"), { ...body, template: body.template ?? null, viewPrefs: body.viewPrefs ?? null }),

  supplierDbUpdate: (sourceId: string, body: UpsertSupplierDbRequest) =>
    api.put<SupplierDbMutationData>(dbPath(sourceId), { ...body, template: body.template ?? null, viewPrefs: body.viewPrefs ?? null }),

  supplierDbDelete: (sourceId: string) =>
    api.del<SupplierDbOkData>(dbPath(sourceId)),

  supplierDbPropCreate: (sourceId: string, body: UpsertSupplierDbPropRequest) =>
    api.post<SupplierDbPropMutationData>(propsPath(sourceId), { ...body, position: body.position ?? null }),

  supplierDbPropUpdate: (
    sourceId: string,
    propId: string,
    body: UpsertSupplierDbPropRequest,
  ) => api.put<SupplierDbPropMutationData>(propPath(sourceId, propId), { ...body, position: body.position ?? null }),

  supplierDbPropDelete: (sourceId: string, propId: string) =>
    api.del<SupplierDbPropDeleteResult>(propPath(sourceId, propId)),

  supplierDbRowCreate: (sourceId: string, body: UpsertSupplierDbRowRequest) =>
    api.post<SupplierDbRowMutationData>(rowsPath(sourceId), body),

  supplierDbRowUpdate: (
    sourceId: string,
    productId: string,
    body: UpsertSupplierDbRowRequest,
  ) => api.put<SupplierDbRowMutationData>(rowPath(sourceId, productId), body),

  supplierDbRowDelete: (sourceId: string, productId: string) =>
    api.del<SupplierDbRowOkData>(rowPath(sourceId, productId)),

  // POST …/rows/{product_id}/price — appends a priced version, never rewrites.
  supplierDbRowAdjustPrice: (
    sourceId: string,
    productId: string,
    body: AdjustSupplierDbPriceRequest,
  ) =>
    api.post<SupplierDbRowMutationData>(
      route("adminSupplierDbsBySourceIdRowsByProductIdPrice", {
        source_id: sourceId,
        product_id: productId,
      }),
      body,
    ),

  // POST …/rows/{product_id}/publish and /unpublish — readiness is checked
  // server-side; 400 answers carry a `missing` checklist the UI localizes.
  supplierDbRowPublish: (sourceId: string, productId: string) =>
    api.post<SupplierDbRowMutationData>(
      route("adminSupplierDbsBySourceIdRowsByProductIdPublish", {
        source_id: sourceId,
        product_id: productId,
      }),
    ),

  supplierDbRowUnpublish: (sourceId: string, productId: string) =>
    api.post<SupplierDbRowMutationData>(
      route("adminSupplierDbsBySourceIdRowsByProductIdUnpublish", {
        source_id: sourceId,
        product_id: productId,
      }),
    ),

  // POST …/uploads — presign for the dedicated R2 bucket; the browser PUTs the
  // bytes straight to `putUrl` and the row then stores `publicUrl`.
  supplierDbUploadPresign: async (
    sourceId: string,
    body: PresignSupplierDbUploadRequest,
  ): Promise<SupplierDbUploadData> => {
    const { contentType, ...input } = body
    const data = await api.post<components["schemas"]["SupplierDbUploadPresignResponse"]["data"]>(uploadsPath(sourceId), { ...input, content_type: contentType })
    return supplierUploadData(data)
  },
}
