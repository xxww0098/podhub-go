/**
 * 「同款规格」纯逻辑测试：请求形状、稳定码到中文的映射，以及三条硬规则
 * （只认服务端摘要 / task_id 不算分组 / 409 重新预览）。
 */
import assert from "node:assert/strict"
import test from "node:test"

import type {
  VariantOperationItem,
  VariantPreviewData,
} from "@/bindings/http-product-variants"

import type { StoreProductRow } from "./products-api"
import {
  VARIANT_DETAIL_FALLBACK,
  VARIANT_OBSERVE_DEADLINE_MS,
  VARIANT_OBSERVE_PASSES,
  VARIANT_PROBLEM_FALLBACK,
  VariantPreviewGuard,
  buildVariantOperationCommand,
  buildVariantPreviewRequest,
  groupCellView,
  isVariantAction,
  openInScope,
  rowGroupFacts,
  variantActionOf,
  variantCheckedLabel,
  variantItemApplied,
  variantItemDetailCopy,
  variantItemStateView,
  variantObservationExhausted,
  variantOperationCounts,
  variantOutcomeNotice,
  variantProblemCopy,
  variantRefusalStep,
  variantScopeKey,
  variantTargetOptions,
  variantTargetReady,
  variantTargetsForStore,
} from "./products-variant-model"

const STORE = "11111111-2222-3333-4444-555555555555"

/**
 * 镜像行。分组列的 `modelId` / `modelCount` 直接取自生成的列表 DTO——这里不再
 * 用交叉类型补字段，DTO 丢掉这两列时 `row({ modelId })` 会先编译不过。
 */
function row(over: Partial<StoreProductRow> = {}): StoreProductRow {
  return {
    store_id: STORE,
    store_name: "测试店",
    product_id: 101,
    offer_id: "A-1",
    name: "杯垫",
    sku: 7,
    state: "on_sale",
    gone: false,
    ...over,
  }
}

function preview(over: Partial<VariantPreviewData> = {}): VariantPreviewData {
  return {
    digest: "digest-1",
    action: "merge",
    storeId: STORE,
    target: { modelId: "900", modelValue: "杯垫同款", existingMembers: 0 },
    products: [
      { productId: "101", offerId: "A-1", currentModelId: "1", targetModelId: "900" },
    ],
    sourceRemaining: [],
    targetExisting: [],
    problems: [],
    ...over,
  }
}

test("合并 / 拆出 / 移入各自发出预期的预览请求", () => {
  const rows = [row(), row({ product_id: 102, offer_id: "A-2" })]
  assert.deepEqual(buildVariantPreviewRequest({ storeId: "store-1", action: "merge", rows }), {
    store_id: "store-1",
    action: "merge",
    product_ids: ["101", "102"],
  })
  // 移入已核实的目标组：带目标型号，不带型号名。
  assert.deepEqual(
    buildVariantPreviewRequest({
      storeId: "store-1",
      action: "move",
      rows,
      target: { kind: "verified", modelId: "900" },
    }),
    { store_id: "store-1", action: "move", product_ids: ["101", "102"], target_model_id: 900 },
  )
  // 拆出不需要目标：每件商品各得一个新号。
  assert.deepEqual(
    buildVariantPreviewRequest({ storeId: "store-1", action: "split", rows }),
    { store_id: "store-1", action: "split", product_ids: ["101", "102"] },
  )
  // 预览不发送未选成员的属性，也不发送价格 / 库存等无关字段。
  for (const request of [
    buildVariantPreviewRequest({ storeId: "store-1", action: "merge", rows }),
    buildVariantPreviewRequest({ storeId: "store-1", action: "split", rows }),
  ]) {
    assert.equal("corrections" in request, false)
    assert.equal("price" in request, false)
    assert.equal("stock" in request, false)
  }
  // 拆出不带任何目标：既没有已核实型号，也没有自由型号名。
  const split = buildVariantPreviewRequest({
    storeId: "store-1",
    action: "split",
    rows,
    target: { kind: "verified", modelId: "900" },
  })
  assert.equal("target_model_id" in split, false)
  assert.equal("model_value" in split, false)
})

test("表动作词表与分组动作一一对应，目标没定就不发预览", () => {
  assert.equal(isVariantAction("variant-merge"), true)
  assert.equal(isVariantAction("price"), false)
  assert.equal(variantActionOf("variant-merge"), "merge")
  assert.equal(variantActionOf("variant-split"), "split")
  assert.equal(variantActionOf("variant-move"), "move")
  assert.equal(variantTargetReady({ kind: "new" }), true)
  assert.equal(variantTargetReady({ kind: "verified", modelId: "" }), false)
  assert.equal(variantTargetReady({ kind: "verified", modelId: "900" }), true)
})

test("移入拒绝非正整数和会被 JSON 舍入的型号，列表也不提供这些候选", () => {
  for (const modelId of ["", " 900 ", "0", "-1", "1.2", "1e3", "NaN", "9007199254740992"]) {
    const target = { kind: "verified" as const, modelId }
    assert.equal(variantTargetReady(target), false, modelId)
    assert.throws(() => buildVariantPreviewRequest({ storeId: STORE, action: "move", rows: [row()], target }))
  }
  assert.throws(() => buildVariantPreviewRequest({ storeId: STORE, action: "move", rows: [row()] }))
  assert.equal(variantTargetReady({ kind: "verified", modelId: String(Number.MAX_SAFE_INTEGER) }), true)
  assert.deepEqual(variantTargetOptions([
    row({ model_id: Number.MAX_SAFE_INTEGER + 1 }), row({ model_id: -1 }), row({ model_id: 1.5 }),
  ]), [])
})

test("合并和拆出都不夹带已有目标或型号名", () => {
  for (const action of ["merge", "split"] as const) {
    const request = buildVariantPreviewRequest({
      storeId: STORE, action, rows: [row()], target: { kind: "verified", modelId: "900" },
    })
    assert.equal("target_model_id" in request, false)
    assert.equal("model_value" in request, false)
  }
})

test("执行命令只带服务端给的预览摘要", () => {
  const data = preview({ digest: "server-digest", storeId: "store-9" })
  assert.deepEqual(buildVariantOperationCommand(data, "op-1"), {
    operation_id: "op-1",
    store_id: "store-9",
    preview_digest: "server-digest",
  })
  // 摘要换了，命令就换了——重复点击复用同一个 operationId 时不会拿旧事实去写。
  assert.notEqual(
    buildVariantOperationCommand(preview({ digest: "server-digest-2" }), "op-1").preview_digest,
    buildVariantOperationCommand(data, "op-1").preview_digest,
  )
})

test("409 回到预览，其他拒绝只上报", () => {
  assert.equal(variantRefusalStep({ status: 409 }), "repreview")
  assert.equal(variantRefusalStep({ status: 500 }), "report")
  assert.equal(variantRefusalStep({ status: 429, retryAfterMs: 1000 }), "report")
  assert.equal(variantRefusalStep(new Error("网络中断")), "report")
  assert.equal(variantRefusalStep(undefined), "report")
})

test("逐项结果：task_id 只算受理，只有 applied 是已并入同款", () => {
  const items: VariantOperationItem[] = [
    { productId: "101", offerId: "A-1", state: "applied", taskId: "t-1" },
    { productId: "102", offerId: "A-2", state: "pending", taskId: "t-1" },
    { productId: "103", offerId: "A-3", state: "rejected", detailCode: "ozon_rejected" },
    { productId: "104", offerId: "A-4", state: "needs_review", detailCode: "observation_budget_exhausted" },
  ]
  // 有任务号但没有 model 分组事实：不能显示成已归组。
  assert.equal(variantItemApplied("pending"), false)
  assert.equal(variantOperationCounts(items).applied, 1)
  assert.deepEqual(variantOperationCounts(items), { total: 4, applied: 1, rejected: 1, open: 2 })
  assert.equal(variantOutcomeNotice(variantOperationCounts(items)), "已受理 4 件：1 件已生效，2 件等待核实")
  assert.equal(
    variantOutcomeNotice({ total: 1, applied: 1, rejected: 0, open: 0 }),
    "1 件商品已并入同款",
  )
  assert.equal(
    variantOutcomeNotice({ total: 2, applied: 1, rejected: 1, open: 0 }),
    "Ozon 已处理 2 件：1 件成功，1 件被拒绝",
  )
  assert.equal(variantOutcomeNotice({ total: 0, applied: 0, rejected: 0, open: 0 }), "Ozon 没有返回可核对的商品")
  assert.deepEqual(variantItemStateView("applied"), { label: "已并入同款", tone: "good" })
  assert.deepEqual(variantItemStateView("rejected"), { label: "Ozon 已拒绝", tone: "bad" })
  assert.deepEqual(variantItemStateView("pending"), { label: "等待 Ozon 生效", tone: "flight" })
  assert.deepEqual(variantItemStateView("needs_review"), { label: "待人工核实", tone: "unknown" })
  // 认不出的状态既不猜成功，也不显示原始字符串。
  assert.deepEqual(variantItemStateView("weird_state"), { label: "结果未确认", tone: "unknown" })
  assert.equal(variantItemStateView("weird_state").label.includes("weird_state"), false)
})

test("全部拒绝或成功/拒绝混合都已终态，不再占自动观察预算", () => {
  for (const states of [["rejected"], ["applied", "rejected"], ["applied"]]) {
    const items = states.map((state, index) => ({ productId: String(index), offerId: String(index), state }))
    assert.equal(variantOperationCounts(items).open, 0)
    assert.doesNotMatch(variantOutcomeNotice(variantOperationCounts(items)), /等待核实|已受理/)
  }
  assert.equal(variantOperationCounts([{ productId: "1", offerId: "1", state: "pending" }]).open, 1)
})

test("稳定码换中文：未知码回退到通用文案，码本身不进页面", () => {
  // 真码取自 03a（对照表与源码集合的机械对账在 products-variant-codes.test.ts）。
  assert.equal(variantProblemCopy({ code: "verify_first" }), "镜像里没有这件商品，请先同步店铺再重新预览")
  assert.equal(
    variantProblemCopy({ code: "variant_combination_duplicate" }),
    "两件商品的规格组合完全相同，请调整规格值",
  )
  assert.equal(variantProblemCopy({ code: "unknown_code_xyz" }), VARIANT_PROBLEM_FALLBACK)
  assert.equal(VARIANT_PROBLEM_FALLBACK.includes("unknown_code_xyz"), false)
  assert.equal(variantItemDetailCopy("ozon_rejected"), "Ozon 拒绝了这次属性更新")
  assert.equal(variantItemDetailCopy("unknown_code_xyz"), VARIANT_DETAIL_FALLBACK)
  assert.equal(VARIANT_DETAIL_FALLBACK.includes("unknown_code_xyz"), false)
  assert.equal(variantItemDetailCopy(null), null)
  assert.equal(variantItemDetailCopy(undefined), null)
})

test("换范围或关窗后，晚到的预览回包不能重填", () => {
  const guard = new VariantPreviewGuard()
  const first = guard.begin()
  assert.equal(guard.accepts(first), true)
  // 换店铺 / 重新读取：在途的那次作废。
  guard.clear()
  assert.equal(guard.accepts(first), false)
  const second = guard.begin()
  assert.equal(guard.accepts(first), false)
  assert.equal(guard.accepts(second), true)
  // 关窗（组件卸载）同样作废。
  guard.clear()
  assert.equal(guard.accepts(second), false)
})

test("范围键把工作空间与店铺分开，换范围的打开状态一律作废", () => {
  assert.notEqual(variantScopeKey(1, "store-a"), variantScopeKey(1, "store-b"))
  assert.notEqual(variantScopeKey(1, "store-a"), variantScopeKey(2, "store-a"))
  assert.notEqual(variantScopeKey(undefined, "store-a"), variantScopeKey(1, "store-a"))
  assert.equal(
    variantScopeKey(1, "store-a"),
    variantScopeKey(1, "store-a"),
  )
  const opened = { scope: variantScopeKey(1, "store-a"), action: "variant-merge" }
  assert.equal(openInScope(opened, variantScopeKey(1, "store-a")), opened)
  assert.equal(openInScope(opened, variantScopeKey(1, "store-b")), null)
  assert.equal(openInScope(null, variantScopeKey(1, "store-a")), null)
})

test("分组列读数：缺席写「—」，件数未知不补零", () => {
  assert.deepEqual(rowGroupFacts(row()), { modelId: null, modelCount: null })
  assert.deepEqual(rowGroupFacts(row({ model_id: 900, model_count: 4 })), {
    modelId: 900,
    modelCount: 4,
  })
  assert.equal(groupCellView({ modelId: null, modelCount: null }).text, "—")
  assert.equal(groupCellView({ modelId: 900, modelCount: null }).text, "已成组")
  assert.equal(groupCellView({ modelId: 900, modelCount: 4 }).text, "4 件同款")
  for (const facts of [
    { modelId: null, modelCount: null },
    { modelId: 900, modelCount: null },
    { modelId: 900, modelCount: 4 },
  ]) {
    assert.doesNotMatch(groupCellView(facts).text, /^0/)
  }
})

test("移入的候选来自列表里已观察到的分组，按件数排序", () => {
  const options = variantTargetOptions([
    row({ product_id: 1, offer_id: "A-1", model_id: 900, model_count: 2 }),
    row({ product_id: 2, offer_id: "A-2", model_id: 901, model_count: 5 }),
    row({ product_id: 3, offer_id: "A-3", model_id: 900, model_count: 3 }),
    row({ product_id: 4, offer_id: "A-4", model_id: null }),
  ])
  assert.deepEqual(options, [
    { storeId: STORE, modelId: "901", label: "同款 5 件 · 型号 901" },
    { storeId: STORE, modelId: "900", label: "同款 3 件 · 型号 900" },
  ])
  assert.deepEqual(variantTargetOptions([row()]), [])
})

test("候选按店铺分开：两店同号型号不是一个目标", () => {
  const options = variantTargetOptions([
    row({ product_id: 1, offer_id: "A-1", model_id: 900, model_count: 2 }),
    row({
      product_id: 2,
      offer_id: "B-1",
      store_id: "22222222-3333-4444-5555-666666666666",
      model_id: 900,
      model_count: 4,
    }),
  ])
  assert.equal(options.length, 2)
  // 全部店铺视图里只把本店的候选交给弹窗。
  const mine = variantTargetsForStore(options, STORE)
  assert.deepEqual(mine, [{ storeId: STORE, modelId: "900", label: "同款 2 件 · 型号 900" }])
  assert.deepEqual(variantTargetsForStore(options, "another-store"), [])
})

test("观察预算有界：到点数或到时限都停", () => {
  const startedAt = 1_000
  assert.equal(variantObservationExhausted(1, startedAt, startedAt + 1), false)
  assert.equal(variantObservationExhausted(VARIANT_OBSERVE_PASSES, startedAt, startedAt + 1), false)
  assert.equal(variantObservationExhausted(VARIANT_OBSERVE_PASSES + 1, startedAt, startedAt + 1), true)
  assert.equal(
    variantObservationExhausted(1, startedAt, startedAt + VARIANT_OBSERVE_DEADLINE_MS),
    true,
  )
})

test("最后核实时间缺失时不写时间", () => {
  assert.equal(variantCheckedLabel(null), null)
  assert.equal(variantCheckedLabel(undefined), null)
  assert.match(variantCheckedLabel(1_700_000_000_000)!, /^最后核实 /)
})
