/**
 * 委托订单的 Cloud wire：一个 thunk 对应一条 `/api/seller/delegate/...` 路由。
 *
 * 屏幕 import `delegateHttp` 直接调用；请求/响应 DTO 用 OpenAPI 生成的
 * `components["schemas"]`（`@/api/client` 已拆掉 `{"data": …}` 信封）。两条
 * 例外：
 *
 * - 建单要 `Idempotency-Key` 头（服务端 `require_idempotency_key` 强制），
 *   走 `request` 带头；幂等键由调用方生成（`newIdempotencyKey`）。
 * - 原图只用匿名 direct PUT；Cloud 只颁短期授权并认证确认真实对象。
 */
import { api, request } from "@/api/client"
import { putDirectUpload } from "@/bindings/direct-upload"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type DelegateSource = components["schemas"]["SellerSupplierDbData"]
export type DelegateAssetView = components["schemas"]["DelegateAssetView"]
export type DelegateBinding = components["schemas"]["DelegateBindingData"]
export type DelegatePosting = components["schemas"]["DelegatePostingView"]
export type DelegatePostingsData = components["schemas"]["DelegatePostingsData"]
export type DelegateOrder = components["schemas"]["DelegateOrderView"]
export type DelegateOrderListData = components["schemas"]["DelegateOrderListData"]
export type DelegateAssetUploadTarget = components["schemas"]["DelegateAssetUploadTarget"]

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ""
}

export const delegateHttp = {
  sources: async (): Promise<DelegateSource[]> => {
    const data = await api.get<components["schemas"]["DelegateSourcesData"]>(
      route("sellerDelegateSources"),
    )
    return data.sources
  },

  listBindings: async (storeId: string): Promise<DelegateBinding[]> => {
    const data = await api.get<components["schemas"]["DelegateBindingsData"]>(
      `${route("sellerDelegateBindings")}${query({ storeId })}`,
    )
    return data.bindings
  },

  createBinding: (body: components["schemas"]["CreateDelegateBindingRequest"]) =>
    api
      .post<components["schemas"]["DelegateBindingMutationData"]>(
        route("sellerDelegateBindings"),
        body,
      )
      .then((data) => data.binding),

  patchBinding: (
    bindingId: string,
    body: components["schemas"]["PatchDelegateBindingRequest"],
  ) =>
    api
      .patch<components["schemas"]["DelegateBindingMutationData"]>(
        route("sellerDelegateBindingsByBindingId", { binding_id: bindingId }),
        body,
      )
      .then((data) => data.binding),

  deleteBinding: async (bindingId: string): Promise<boolean> => {
    const data = await api.del<components["schemas"]["DelegateBindingDeleteData"]>(
      route("sellerDelegateBindingsByBindingId", { binding_id: bindingId }),
    )
    return data.deleted
  },

  presignAsset: (
    body: components["schemas"]["DelegateAssetPresignRequest"], signal?: AbortSignal,
  ): Promise<DelegateAssetUploadTarget> =>
    request<components["schemas"]["DelegateAssetPresignData"]>(
      "POST", route("sellerDelegateAssetsPresign"), body, {}, 30_000, undefined,
      { callerSignal: signal, reportOwner: "caller" },
    ).then((data) => data.upload),

  /** Only the S3 grant reaches the anonymous transport; ticket never leaves Cloud. */
  putAssetObject: (
    target: DelegateAssetUploadTarget, file: Blob,
    options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
  ) => putDirectUpload(target.upload, file, { ...options, expectedByteLength: file.size }),

  finalizeAsset: (body: components["schemas"]["CreateDelegateAssetRequest"], signal?: AbortSignal) =>
    request<components["schemas"]["DelegateAssetMutationData"]>(
      "POST", route("sellerDelegateAssets"), body, {}, 65 * 60_000, undefined,
      { callerSignal: signal, reportOwner: "caller" },
    ).then((data) => data.asset),

  deleteAsset: (assetId: string) =>
    api.del<components["schemas"]["DelegateAssetDeleteData"]>(
      route("sellerDelegateAssetsByAssetId", { asset_id: assetId }),
    ),

  listPostings: (body: components["schemas"]["DelegatePostingsRequest"]) =>
    api.post<DelegatePostingsData>(route("sellerDelegatePostings"), body),

  /** 建单：`Idempotency-Key` 头是服务端硬性要求，缺了直接 400。 */
  createOrder: (
    body: components["schemas"]["CreateDelegateOrderRequest"],
    idempotencyKey: string,
  ) =>
    request<components["schemas"]["DelegateOrderData"]>(
      "POST",
      route("sellerDelegateOrders"),
      body,
      { "Idempotency-Key": idempotencyKey },
    ).then((data) => data.order),

  listOrders: (params: {
    storeId?: string
    state?: string
    cursor?: string
    limit?: number
  }) =>
    api
      .get<DelegateOrderListData>(
        `${route("sellerDelegateOrders")}${query({
          storeId: params.storeId,
          state: params.state,
          cursor: params.cursor,
          limit: params.limit,
        })}`,
      )
      .then((data) => data),

  getOrder: (orderId: string) =>
    api
      .get<components["schemas"]["DelegateOrderData"]>(
        route("sellerDelegateOrdersByOrderId", { order_id: orderId }),
      )
      .then((data) => data.order),

  cancelOrder: (orderId: string) =>
    api
      .post<components["schemas"]["DelegateOrderData"]>(
        route("sellerDelegateOrdersByOrderIdCancel", { order_id: orderId }),
      )
      .then((data) => data.order),

  closeOrder: (orderId: string) =>
    api
      .post<components["schemas"]["DelegateOrderData"]>(
        route("sellerDelegateOrdersByOrderIdClose", { order_id: orderId }),
      )
      .then((data) => data.order),

  nudgeOrder: (orderId: string) =>
    api
      .post<components["schemas"]["DelegateOrderData"]>(
        route("sellerDelegateOrdersByOrderIdNudge", { order_id: orderId }),
      )
      .then((data) => data.order),

  /** 发货屏徽标：纯 DB 读；`postingNumbers` 逗号分隔，单批 ≤200。 */
  postingStates: async (storeId: string, postingNumbers: string[]) => {
    if (postingNumbers.length === 0) return []
    const data = await api.get<components["schemas"]["DelegatePostingStatesData"]>(
      `${route("sellerDelegatePostingStates")}${query({
        storeId,
        postingNumbers: postingNumbers.join(","),
      })}`,
    )
    return data.states
  },
}
