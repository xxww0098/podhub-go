/** 平台货源 HTTP client. Wire types mirror the camelCase DTO; prop_defs is propDefs. */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type {
  SupplierPromptPreview,
  SupplierPromptDiff,
  PublishSupplierPromptResult,
  SupplierDbDetail,
  UpsertSupplierDbRequest,
  UpsertSupplierDbPropRequest,
  UpsertSupplierDbRowRequest,
  PatchSupplierPromptRequest,
  SupplierPromptSync,
  AdjustSupplierDbPriceRequest,
  PresignSupplierDbUploadRequest,
  SupplierDbPropDeleteResult,
  SupplierDbListData,
  SupplierDbMutationData,
  SupplierDbPropMutationData,
  SupplierDbRowMutationData,
  SupplierPromptListData,
  SupplierPromptMutationData,
  SupplierDbOkData,
  SupplierDbRowOkData,
  SupplierDbUploadData
} from "./http-supplier-dbs-types"
export type * from "./http-supplier-dbs-types"

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
const supplierPromptPath = (productId: string) =>
  route("adminSupplierPromptsByProductId", { product_id: productId })

export const supplierDbsHttp = {
  supplierPromptsList: () =>
    api.get<SupplierPromptListData>(route("adminSupplierPrompts")),

  supplierPromptPatch: (productId: string, body: PatchSupplierPromptRequest) =>
    api.patch<SupplierPromptMutationData>(supplierPromptPath(productId), body),

  supplierPromptPreview: (
    sourceId: string,
    productId: string,
    body: { brief: string; fixedTags: string[] },
  ) =>
    api.post<SupplierPromptPreview>(
      route("adminSupplierDbsBySourceIdRowsByProductIdPromptPreview", {
        source_id: sourceId,
        product_id: productId,
      }),
      body,
    ),

  supplierPromptDiff: (sourceId: string, productId: string, revision: number) =>
    api.get<SupplierPromptDiff>(
      `${route("adminSupplierDbsBySourceIdRowsByProductIdPromptDiff", {
        source_id: sourceId,
        product_id: productId,
      })}?revision=${revision}`,
    ),

  supplierPromptPublish: (sourceId: string, productId: string, revision: number) =>
    api.post<PublishSupplierPromptResult>(
      route("adminSupplierDbsBySourceIdRowsByProductIdPromptPublish", {
        source_id: sourceId,
        product_id: productId,
      }),
      { revision },
    ),

  /** 超级管理员：把供应商副本对齐到类目提示词的当前正文（决策 D9）。 */
  supplierPromptsSync: () =>
    api.post<SupplierPromptSync>(route("adminSupplierPromptsSync")),

  supplierDbsList: () =>
    api.get<SupplierDbListData>(route("adminSupplierDbs")),

  supplierDbGet: (sourceId: string) =>
    api.get<SupplierDbDetail>(dbPath(sourceId)),

  supplierDbCreate: (body: UpsertSupplierDbRequest) =>
    api.post<SupplierDbMutationData>(route("adminSupplierDbs"), body),

  supplierDbUpdate: (sourceId: string, body: UpsertSupplierDbRequest) =>
    api.put<SupplierDbMutationData>(dbPath(sourceId), body),

  supplierDbDelete: (sourceId: string) =>
    api.del<SupplierDbOkData>(dbPath(sourceId)),

  supplierDbPropCreate: (sourceId: string, body: UpsertSupplierDbPropRequest) =>
    api.post<SupplierDbPropMutationData>(propsPath(sourceId), body),

  supplierDbPropUpdate: (
    sourceId: string,
    propId: string,
    body: UpsertSupplierDbPropRequest,
  ) => api.put<SupplierDbPropMutationData>(propPath(sourceId, propId), body),

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
  supplierDbUploadPresign: (
    sourceId: string,
    body: PresignSupplierDbUploadRequest,
  ) => api.post<SupplierDbUploadData>(uploadsPath(sourceId), body),
}
