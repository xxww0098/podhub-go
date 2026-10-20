/**
 * 店铺商品「同款规格」的三条 Ops 路由：预览、执行、按操作号回读。
 *
 * Wire 形状只取生成的 OpenAPI 契约，响应在这里转换成独立视图模型。预览对明确选定的本店
 * 商品定向读取并返回完整成员事实与摘要；执行只接受 `operationId` + 预览摘要；
 * 回读只读数据库。所有 `code` / `state` 都是稳定标识符，中文文案在
 * `features/products/products-variant-model.ts` 映射。
 *
 * 路径全部来自生成物 `@/api/routes`（03a 已把这三条 wire 写进 `schema.d.ts`，
 * `routes.ts` 是唯一路径权威）。契约本身由
 * `web/tests/product-variants-wire.test.ts` 钉住：那里的字面量与这里的路由键
 * 互相印证，生成物被改错时两边一起红。
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { refuse } from "./refusal"

type Schema = components["schemas"]

/** 三个分组动作。拆出每件商品各得一个稳定新型号；移入必须给出目标。 */
export type VariantAction = Schema["ProductGroupingAction"]

/** 一条真实规格值（尺寸 / 颜色…）。`label` 是服务端给的字段中文名。 */
export type VariantAttributeValue = {
  attributeId: string
  label: string
  value: string
  dictionaryValueId?: string | null
}

/**
 * 一件商品在预览里的事实。选中商品、留在源组的未选成员、目标组现有成员
 * 共用这个形状——明细永远展示整组成员，而不是只有勾选的那几件。
 * 除 identity 外全部可缺席：缺席即未知，页面不补零也不猜。
 */
export type VariantMemberFacts = {
  productId: string
  offerId: string
  name?: string | null
  thumbnailUrl?: string | null
  currentModelId?: string | null
  targetModelId?: string | null
  variantValues?: VariantAttributeValue[]
  /** 规格组合键：同组内不重复，用来指出复制规格冲突。 */
  combinationKey?: string | null
}

/** 请求类型来自生成契约：型号、属性和字典值 ID 在 wire 上都是整数。 */
export type VariantPreviewRequest = Schema["ProductVariantPreviewRequest"]

export type VariantProblem = {
  code: string
  productId?: string | null
  attributeId?: string | null
}

export type VariantPreviewTarget = {
  modelId: string
  modelValue: string
  /** 目标组已有的成员件数；成员名单在 `targetExisting` 里。 */
  existingMembers: number
}

export type VariantPreviewData = {
  digest: string
  action: VariantAction
  storeId: string
  target: VariantPreviewTarget
  /** 本次要改的商品。 */
  products: VariantMemberFacts[]
  /** 原组里没被选中、继续留在原组的成员。 */
  sourceRemaining: VariantMemberFacts[]
  /** 目标组现有成员；新分组时为空。 */
  targetExisting: VariantMemberFacts[]
  problems: VariantProblem[]
}

/**
 * 逐商品结果。`applied` 是唯一证明已并入同款的取值；`task_id` 只证明已受理，
 * 观察轴与运输轴分开（见 slice 03 最小持久模型第 3 条）。
 */
export type VariantOperationItem = {
  productId: string
  offerId: string
  state: string
  taskId?: string | null
  detailCode?: string | null
}

export type VariantOperationCommand = Schema["ProductVariantOperationRequest"]

export type VariantOperationData = {
  operationId?: string
  accepted?: boolean
  state?: string
  items: VariantOperationItem[]
  lastCheckedAtMs?: number | null
}

/** 明确转换两种成员 DTO；未选成员的 modelId 不是 currentModelId。 */
function memberFacts(member: Schema["ProductVariantMemberView"]): VariantMemberFacts {
  return {
    productId: member.product_id,
    offerId: member.offer_id,
    name: member.name,
    currentModelId: member.model_id == null ? null : String(member.model_id),
  }
}

function previewData(data: Schema["ProductVariantPreviewData"]): VariantPreviewData {
  return {
    digest: data.digest,
    action: data.action,
    storeId: data.store_id,
    target: {
      modelId: data.target.model_id == null ? "" : String(data.target.model_id),
      modelValue: data.target.model_value ?? "",
      // 生成契约允许省略默认空数组；数量从协议给出的成员名单推导。
      existingMembers: (data.target.existing_members ?? []).length,
    },
    products: data.products.map((product) => ({
      productId: product.product_id,
      offerId: product.offer_id,
      name: product.name,
      thumbnailUrl: product.thumbnail_url ?? null,
      currentModelId: product.current_model_id == null ? null : String(product.current_model_id),
      targetModelId: product.target_model_id == null ? null : String(product.target_model_id),
      variantValues: product.variant_values.map((value) => ({
        attributeId: String(value.attribute_id),
        label: value.label,
        value: value.value,
        dictionaryValueId: value.dictionary_value_id == null ? null : String(value.dictionary_value_id),
      })),
    })),
    sourceRemaining: (data.source_remaining ?? []).map(memberFacts),
    targetExisting: (data.target_existing ?? []).map(memberFacts),
    problems: (data.problems ?? []).map((problem) => ({
      code: problem.code,
      productId: problem.product_id ?? null,
      attributeId: problem.attribute_id == null ? null : String(problem.attribute_id),
    })),
  }
}

function operationData(
  data: Schema["ProductVariantOperationData"] | Schema["ProductVariantOperationStatusData"],
): VariantOperationData {
  return {
    operationId: data.operation_id,
    accepted: "accepted" in data ? data.accepted : undefined,
    state: data.state ?? undefined,
    lastCheckedAtMs: data.last_checked_at_ms,
    items: (data.items ?? []).map((item) => ({
      productId: item.product_id,
      offerId: item.offer_id,
      state: item.state,
      taskId: item.task_id == null ? null : String(item.task_id),
      detailCode: item.detail_code ?? null,
    })),
  }
}

export const productVariantsHttp = {
  preview: async (request: VariantPreviewRequest): Promise<VariantPreviewData> => {
    if (request.target_model_id != null &&
      (!Number.isSafeInteger(request.target_model_id) || request.target_model_id <= 0)) {
      throw refuse("variant_target_invalid", "目标型号无效，请重新选择已核实的同款。")
    }
    return previewData(await api.post<Schema["ProductVariantPreviewData"]>(
      route("workspaceOpsProductVariantsPreviews"), request,
    ))
  },
  operate: async (command: VariantOperationCommand): Promise<VariantOperationData> =>
    operationData(await api.post<Schema["ProductVariantOperationData"]>(
      route("workspaceOpsProductVariantsOperations"), command,
    )),
  /** 只读数据库的复核；不写账本，也不触发任何 Seller 请求。 */
  operation: async (operationId: string): Promise<VariantOperationData> =>
    operationData(await api.get<Schema["ProductVariantOperationStatusData"]>(
      route("workspaceOpsProductVariantsOperationsByOperationId", { operation_id: operationId }),
    )),
}
