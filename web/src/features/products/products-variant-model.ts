/**
 * 「同款规格」的纯逻辑：请求构造、稳定标识符到中文的映射，以及换范围时的作废守卫。
 *
 * 三条硬规则住在这里，因为它们必须被测试直接钉住，而不是靠读 JSX 推断：
 *   1. 执行只认服务端给的预览摘要（buildVariantOperationCommand 的摘要只能来自预览数据）；
 *   2. `task_id` 不证明分组，只有 `applied` 算并入同款（variantItemApplied）；
 *   3. 事实漂移（409）之后重新预览，绝不重试写入（variantRefusalStep）。
 *
 * 服务端的 `code` / `state` 是稳定标识符，页面只渲染这里给出的中文；
 * 未收录的码一律回退到通用文案，绝不把码或错误原文写进 DOM。
 */
import type {
  VariantAction,
  VariantOperationCommand,
  VariantOperationItem,
  VariantPreviewData,
  VariantPreviewRequest,
  VariantProblem,
} from "@/bindings/http-product-variants"
import { formatDateTimeShort } from "@/lib/format"
import type { StateTone } from "@/lib/receipt-state"

import type { StoreProductRow } from "./products-api"
import type { ProductAction } from "./products-mutation"

/** 表格动作词表里的三个分组动作。 */
export const VARIANT_PRODUCT_ACTIONS = ["variant-merge", "variant-split", "variant-move"] as const
export type VariantProductAction = (typeof VARIANT_PRODUCT_ACTIONS)[number]

export function isVariantAction(action: ProductAction): action is VariantProductAction {
  return (VARIANT_PRODUCT_ACTIONS as readonly string[]).includes(action)
}

const VARIANT_ACTION_OF: Record<VariantProductAction, VariantAction> = {
  "variant-merge": "merge",
  "variant-split": "split",
  "variant-move": "move",
}

export function variantActionOf(action: VariantProductAction): VariantAction {
  return VARIANT_ACTION_OF[action]
}

/** 每个动作对身体的一句话说明：操作员要知道整组会怎么变。 */
export const VARIANT_ACTION_NOTE: Record<VariantAction, string> = {
  merge: "选中的商品并入同一个型号；源组里没被选中的成员留在原组。",
  split: "每件选中的商品各自成为一个稳定新型号，不会彼此再合并。",
  move: "选中的商品移入目标型号；源组里没被选中的成员留在原组。",
}

/** 合并/拆出新建分组；移入只接受已核实的既有分组。 */
export type VariantTargetChoice =
  | { kind: "new" }
  | { kind: "verified"; modelId: string }

/** 目标还没定下来时不发预览——服务端不接受没有目标的目标。 */
export function variantTargetReady(target: VariantTargetChoice): boolean {
  if (target.kind === "verified") return parseModelId(target.modelId) !== null
  return true
}

/** Select 保持字符串；只有正十进制安全整数可跨越 JSON 数字边界。 */
function parseModelId(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null
  const modelId = Number(value)
  return Number.isSafeInteger(modelId) && modelId > 0 ? modelId : null
}

/** 「移入已有同款」的候选：列表里已观察到的同款分组，按件数从多到少。 */
export type VariantTargetOption = { storeId: string; modelId: string; label: string }

/**
 * 候选目标只来自镜像已经观察到的分组（`model_id` / `model_count`）——不猜、
 * 不搜全店。件数未知的排在有件数的后面，并如实写「件数未知」。
 * 型号只在店铺内成立，所以去重按 (店铺, 型号)：全部店铺视图不能把两店同号
 * 的型号合成一个候选。
 */
export function variantTargetOptions(rows: readonly StoreProductRow[]): VariantTargetOption[] {
  const groups = new Map<string, { storeId: string; modelId: string; count: number | null }>()
  for (const row of rows) {
    const facts = rowGroupFacts(row)
    if (facts.modelId == null || parseModelId(String(facts.modelId)) === null) continue
    const modelId = String(facts.modelId)
    const key = `${row.store_id}:${modelId}`
    const count = facts.modelCount ?? null
    const previous = groups.get(key)
    if (previous === undefined) groups.set(key, { storeId: row.store_id, modelId, count })
    else if (count !== null && (previous.count === null || count > previous.count)) {
      previous.count = count
    }
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        (right.count ?? -1) - (left.count ?? -1) || left.modelId.localeCompare(right.modelId),
    )
    .map((group) => ({
      storeId: group.storeId,
      modelId: group.modelId,
      label:
        group.count === null
          ? `同款（件数未知）· 型号 ${group.modelId}`
          : `同款 ${group.count} 件 · 型号 ${group.modelId}`,
    }))
}

/** 目标候选只认本店：同一个型号号在两家店是两回事。 */
export function variantTargetsForStore(
  options: readonly VariantTargetOption[],
  storeId: string,
): VariantTargetOption[] {
  return options.filter((option) => option.storeId === storeId)
}

/**
 * 预览请求：只带明确选定的本店商品号与目标；服务端补齐原组未选成员与目标组
 * 现有成员。移入必须带已观察到的目标 ID；型号名不提供可核实的成员范围。
 */
export function buildVariantPreviewRequest(input: {
  storeId: string
  action: VariantAction
  rows: readonly Pick<StoreProductRow, "product_id">[]
  target?: VariantTargetChoice
}): VariantPreviewRequest {
  const scoped: Pick<VariantPreviewRequest, "target_model_id"> = {}
  if (input.action === "move") {
    const modelId = input.target?.kind === "verified" ? parseModelId(input.target.modelId) : null
    if (modelId === null) throw new Error("移入同款必须选择有效的目标型号")
    scoped.target_model_id = modelId
  }
  // 合并和拆出都新建型号，不能夹带已有目标。
  return {
    store_id: input.storeId,
    action: input.action,
    product_ids: input.rows.map((row) => String(row.product_id)),
    ...scoped,
  }
}

/** 执行只用服务端返回的摘要：本地不重算，调用方也无法传进自己拼的摘要。 */
export function buildVariantOperationCommand(
  preview: VariantPreviewData,
  operationId: string,
): VariantOperationCommand {
  return { operation_id: operationId, store_id: preview.storeId, preview_digest: preview.digest }
}

/** 镜像行上的分组观察列（`store_products.model_id` / `model_count`）。 */
export type StoreProductGroupFacts = {
  modelId?: number | null
  modelCount?: number | null
}

/**
 * 读一行的分组事实。两列由列表 / 核实 DTO 直接携带（`StoreProductRow` 的生成
 * 类型里有 `modelId` / `modelCount`）；缺席即未知，列显示「—」，绝不显示 0。
 */
export function rowGroupFacts(row: StoreProductRow): StoreProductGroupFacts {
  return { modelId: row.model_id ?? null, modelCount: row.model_count ?? null }
}

/** 分组列的读数：缺席写「—」，件数未知写「已成组」——都不补零。 */
export function groupCellView(facts: StoreProductGroupFacts): { text: string; hint: string } {
  if (facts.modelId == null) {
    return { text: "—", hint: "镜像没读到这件商品的同款分组；先同步店铺再看" }
  }
  if (facts.modelCount == null) {
    return { text: "已成组", hint: "Ozon 没报告同款件数，件数未知" }
  }
  return { text: `${facts.modelCount} 件同款`, hint: "Ozon 报告的同款成员件数" }
}

/** 逐商品结果的显示词表。只有 applied 是终局成功。 */
export function variantItemStateView(state: string): { label: string; tone: StateTone } {
  switch (state) {
    case "applied":
      return { label: "已并入同款", tone: "good" }
    case "rejected":
      return { label: "Ozon 已拒绝", tone: "bad" }
    case "pending":
      return { label: "等待 Ozon 生效", tone: "flight" }
    case "needs_review":
      return { label: "待人工核实", tone: "unknown" }
    default:
      return { label: "结果未确认", tone: "unknown" }
  }
}

/** 只有 applied 证明已并入同款；task_id 只证明 Ozon 已受理。 */
export function variantItemApplied(state: string): boolean {
  return state === "applied"
}

export type VariantOperationCounts = {
  total: number
  applied: number
  rejected: number
  /** 还在等生效或需要人工核实的件数。 */
  open: number
}

export function variantOperationCounts(
  items: readonly VariantOperationItem[],
): VariantOperationCounts {
  let applied = 0
  let rejected = 0
  let open = 0
  for (const item of items) {
    if (variantItemApplied(item.state)) applied += 1
    else if (item.state === "rejected") rejected += 1
    else open += 1
  }
  return { total: items.length, applied, rejected, open }
}

/** 结果通知文案：有未确认项时只说「已受理」，不说完成。 */
export function variantOutcomeNotice(counts: VariantOperationCounts): string {
  if (counts.total === 0) return "Ozon 没有返回可核对的商品"
  if (counts.open > 0) {
    return `已受理 ${counts.total} 件：${counts.applied} 件已生效，${counts.open} 件等待核实`
  }
  if (counts.rejected > 0) {
    return `Ozon 已处理 ${counts.total} 件：${counts.applied} 件成功，${counts.rejected} 件被拒绝`
  }
  return `${counts.applied} 件商品已并入同款`
}

/**
 * 预览拒绝码 → 中文。键是 03a 实际发出的稳定码，逐条对应：
 *
 * - `src/store/grouping/preview.rs` 的 `PROBLEM_*`（路由自己判定的前置事实）；
 * - `rust/crates/listing-core/src/issue_keys.rs` 的 `OzonVariantsCode`（共用分组规则，
 *   经 `validate_group` 原样上报）。
 *
 * `products-variant-codes.test.ts` 直接读这两处源码做集合比对：后端新增一个码而
 * 这里没有文案，测试就红；删掉一个码而这里还留着死文案，同样红。
 */
export const VARIANT_PROBLEM_COPY: Readonly<Record<string, string>> = {
  // 路由自身的前置事实（preview.rs）
  verify_first: "镜像里没有这件商品，请先同步店铺再重新预览",
  too_many_products: "一次最多预览 100 件商品，请减少选择",
  too_many_members: "整组会波及超过 100 件商品，请缩小选择范围",
  mixed_source_groups: "选中的商品分属不同的同款组，请只选同一组的商品",
  target_group_unproven: "目标同款的成员范围无法核实，请改选一个已核实的同款",
  target_model_required: "移入已有同款必须给出目标型号",
  already_in_target: "选中的商品已经全在目标同款里，不需要再移入",
  model_value_not_allowed: "合并或拆出不接受自定义型号名，请改用移入",
  correction_attribute_unknown: "要修正的属性不是这个类目的规格维度",
  category_material_missing: "这个类目的规格材料还没缓存，请先刷新类目再预览",
  seller_read_incomplete: "Ozon 没有读完这次涉及的商品，请稍后重新预览",
  // 共用分组规则（listing_core::variants，见 issue_keys.rs）
  variant_metadata_unknown: "类目规格元数据不完整，请刷新类目后重新预览",
  variant_model_field_absent: "这个类目没有型号字段，无法分组",
  variant_model_field_complex: "型号字段在复杂属性组里，这个版本无法分组",
  variant_dimension_complex: "规格维度是复杂属性组的成员，这个版本无法处理",
  variant_category_mismatch: "同组商品的类目或类型不一致，请重新选择",
  variant_brand_mismatch: "同组商品的品牌不一致，请重新选择",
  variant_no_distinguishing_dimension: "这个类目没有能区分成员的规格维度，无法分组",
  variant_combination_duplicate: "两件商品的规格组合完全相同，请调整规格值",
  variant_write_member_unknown: "这次写入的成员不在已核实的整组成员里，请重新预览",
}

export const VARIANT_PROBLEM_FALLBACK = "服务端拒绝了这次预览；请先核实店铺数据，再重新预览"

export function variantProblemCopy(problem: VariantProblem): string {
  return VARIANT_PROBLEM_COPY[problem.code] ?? VARIANT_PROBLEM_FALLBACK
}

/**
 * 逐商品结果的原因码 → 中文。键是 03a 实际发出的稳定码，逐条对应：
 *
 * - `src/ops/product_variants/operations.rs` 的 `ozon_rejected`（同步派发被拒）；
 * - `src/store/grouping/observe_decide.rs` 与 `observe.rs` 的 `DETAIL_*`
 *   （有界观察的结论）。
 */
export const VARIANT_DETAIL_COPY: Readonly<Record<string, string>> = {
  ozon_rejected: "Ozon 拒绝了这次属性更新",
  ozon_task_rejected: "Ozon 的任务把这次更新标为失败",
  seller_read_incomplete: "这次回读没覆盖到这件商品，等下一次核实",
  source_group_joined: "原组里没被选中的成员也被并了进来，请人工核实",
  target_group_drifted: "目标组的成员已经变了，请人工核实",
  seller_account_changed: "店铺凭据已换成另一个账号，无法继续自动核实",
  observation_budget_exhausted: "观察轮次或时限已用尽，请人工核实",
}

export const VARIANT_DETAIL_FALLBACK = "Ozon 没给出可核实的原因，请先核实再重试"

export function variantItemDetailCopy(detailCode: string | null | undefined): string | null {
  if (!detailCode) return null
  return VARIANT_DETAIL_COPY[detailCode] ?? VARIANT_DETAIL_FALLBACK
}

function statusOf(reason: unknown): number | null {
  if (typeof reason !== "object" || reason === null || !("status" in reason)) return null
  const status = (reason as { status?: unknown }).status
  return typeof status === "number" ? status : null
}

/** 预览之后事实变了（属性被外部改过、凭据轮换、权限撤销）——Cloud 用 409 回答执行。 */
export function variantFactsDrifted(reason: unknown): boolean {
  return statusOf(reason) === 409
}

export type VariantRefusalStep = "repreview" | "report"

/** 写回被拒后的下一步。漂移只能重新预览：重试写入会拿旧摘要再打一次 Seller。 */
export function variantRefusalStep(reason: unknown): VariantRefusalStep {
  return variantFactsDrifted(reason) ? "repreview" : "report"
}

/** 结果区的「最后核实」。没核实过就是 null，页面不写时间。 */
export function variantCheckedLabel(lastCheckedAtMs: number | null | undefined): string | null {
  return lastCheckedAtMs == null ? null : `最后核实 ${formatDateTimeShort(lastCheckedAtMs)}`
}

/**
 * 打开状态的归属范围：工作空间 + 店铺。换范围后上一范围的预览与详情不再渲染，
 * 页面重挂载本身也会把内存状态清空。
 */
export function variantScopeKey(workspaceId: number | undefined, storeId: string | null): string {
  return `${workspaceId ?? "none"}:${storeId ?? "none"}`
}

/** 换范围后，属于上一个范围的打开状态一律作废。 */
export function openInScope<T extends { scope: string }>(open: T | null, scope: string): T | null {
  return open !== null && open.scope === scope ? open : null
}

/**
 * 一次预览读取的守卫：换范围、关窗或重新读取都让在途回包作废，
 * 晚到的回包不能重填已经清掉的预览。
 */
export class VariantPreviewGuard {
  private token = 0

  begin(): number {
    this.token += 1
    return this.token
  }

  clear(): void {
    this.token += 1
  }

  accepts(token: number): boolean {
    return token === this.token
  }
}

/**
 * 观察预算：最多 10 轮、每轮 5 秒、30 分钟到点。到点只是停止自动读取并转人工
 * 核实——读不到不等于完成，也不解除占用。
 */
export const VARIANT_OBSERVE_PASSES = 10
export const VARIANT_OBSERVE_INTERVAL_MS = 5_000
export const VARIANT_OBSERVE_DEADLINE_MS = 30 * 60_000

export function variantObservationExhausted(
  passes: number,
  startedAtMs: number,
  nowMs: number,
): boolean {
  return passes > VARIANT_OBSERVE_PASSES || nowMs - startedAtMs >= VARIANT_OBSERVE_DEADLINE_MS
}
