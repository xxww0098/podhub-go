/**
 * 预览 → 确认 → 逐项结果的渲染与编排契约。
 *
 * 渲染部分钉住「每件商品的真实结果」：四种状态各有中文标签，任务号不冒充分组。
 * 编排部分是源码契约（交互无法在 node:test 里模拟）：复用 ConfirmDialog、
 * 只发服务端摘要、409 走重新预览、观察有界、没有往 DOM 里写错误原文。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import type { VariantOperationItem } from "@/bindings/http-product-variants"

import { LIVE_VARIANT_OPEN, VariantOperationResults } from "./products-variant-dialog"

const SOURCE = readFileSync(
  fileURLToPath(new URL("./products-variant-dialog.tsx", import.meta.url)),
  "utf8",
)

function results(items: VariantOperationItem[], over: Partial<{ verifying: boolean }> = {}) {
  return renderToStaticMarkup(
    <VariantOperationResults
      items={items}
      checkedLabel="最后核实 2026/10/14 10:00"
      verifying={over.verifying ?? false}
      onVerify={() => {}}
    />,
  )
}

test("部分完成时每件商品各显示自己的结果", () => {
  const markup = results([
    { productId: "101", offerId: "A-1", state: "applied" },
    { productId: "102", offerId: "A-2", state: "pending", taskId: "t-1" },
    { productId: "103", offerId: "A-3", state: "rejected", detailCode: "ozon_rejected" },
    { productId: "104", offerId: "A-4", state: "needs_review", detailCode: "observation_budget_exhausted" },
  ])
  for (const offer of ["A-1", "A-2", "A-3", "A-4"]) assert.match(markup, new RegExp(offer))
  assert.match(markup, /已并入同款/)
  assert.match(markup, /等待 Ozon 生效/)
  assert.match(markup, /Ozon 已拒绝/)
  assert.match(markup, /待人工核实/)
  assert.match(markup, /Ozon 拒绝了这次属性更新/)
  assert.match(markup, /观察轮次或时限已用尽/)
  assert.match(markup, /最后核实 2026\/10\/14/)
  // 页面里没有原始错误原文，也没有内联告警块。
  assert.doesNotMatch(markup, /role="alert"/)
  assert.doesNotMatch(markup, /ozon_rejected|observation_budget_exhausted/)
})

test("有任务号但没有分组事实不算完成", () => {
  const markup = results([{ productId: "102", offerId: "A-2", state: "pending", taskId: "777" }])
  assert.match(markup, /等待 Ozon 生效/)
  assert.doesNotMatch(markup, /已并入同款/)
  // 任务号是内部标识，不进页面。
  assert.doesNotMatch(markup, /777/)
})

test("认不出的状态既不猜成功，也不显示原始字符串", () => {
  const markup = results([{ productId: "105", offerId: "A-5", state: "brand_new_state" }])
  assert.match(markup, /结果未确认/)
  assert.doesNotMatch(markup, /brand_new_state/)
  assert.doesNotMatch(markup, /已并入同款/)
})

test("核实入口在结果区，核实中禁用且不叠重复按钮", () => {
  const idle = results([{ productId: "101", offerId: "A-1", state: "pending" }])
  assert.match(idle, />核实结果</)
  assert.equal((idle.match(/>核实结果</g) ?? []).length, 1)
  assert.doesNotMatch(idle, /disabled=""/)
  const busy = results([{ productId: "101", offerId: "A-1", state: "pending" }], { verifying: true })
  assert.match(busy, /核实中…/)
  assert.match(busy, /disabled=""/)
  assert.doesNotMatch(busy, />核实结果</)
  // 核实按钮接的是只读回读操作状态，不是重新执行。
  assert.match(SOURCE, /onVerify=\{requestVerify\}/)
  assert.match(SOURCE, /productVariantsHttp\.operation\(operationId\)/)
})

test("常驻提示的键是稳定的，重开不会叠出第二条", () => {
  assert.equal(LIVE_VARIANT_OPEN, "products-variant-open")
})

test("对话框复用 ConfirmDialog，不手搓弹窗", () => {
  assert.match(SOURCE, /<ConfirmDialog/)
  assert.match(SOURCE, /import \{ ConfirmDialog \} from "@\/components\/ui\/confirm-dialog"/)
  assert.doesNotMatch(SOURCE, /from "@\/components\/ui\/dialog"/)
  assert.doesNotMatch(SOURCE, /DialogContent/)
})

test("只有移入提供已核实目标，合并/拆出不提供已有目标或自由型号名", () => {
  assert.match(SOURCE, /\{variantAction === "move" \? \(/)
  assert.doesNotMatch(SOURCE, /目标型号名|按型号名|targetName|allowNew/)
})

test("执行只带服务端摘要，重复点击复用同一个 operationId", () => {
  assert.match(SOURCE, /buildVariantOperationCommand\(preview, operationId\)/)
  assert.match(SOURCE, /useOperationIds\(scopeKey\)/)
  assert.match(SOURCE, /const \[operationId\] = operationIdsFor\(\[/)
})

test("409 之后重新预览，绝不重试这次写入", () => {
  // 漂移分支里必须出现 reload()；同分支里不得再发一次执行。
  assert.match(
    SOURCE,
    /variantRefusalStep\(reason\) === "repreview"\)[\s\S]{0,400}?reload\(\)/,
  )
  assert.match(SOURCE, /variantRefusalStep/)
  // 漂移分支里只有「重新预览」这一条出路，没有第二次执行调用。
  assert.doesNotMatch(SOURCE, /retryExecute/)
})

test("观察走有界预算，不用无界定时器；未确认时用常驻提示带重试", () => {
  assert.match(SOURCE, /useVisiblePolling\(\{/)
  assert.match(SOURCE, /variantObservationExhausted\(passes\.current/)
  assert.doesNotMatch(SOURCE, /setInterval/)
  assert.match(SOURCE, /notifyLive\(\{/)
  assert.match(SOURCE, /id: LIVE_VARIANT_OPEN/)
  assert.match(SOURCE, /clearLive\(LIVE_VARIANT_OPEN\)/)
  assert.match(SOURCE, /notifyCommandError\(reason/)
})

test("页面不渲染错误原文：没有 errorMessage / {error} 直出", () => {
  assert.doesNotMatch(SOURCE, /errorMessage\(/)
  assert.doesNotMatch(SOURCE, /role="alert"/)
  assert.doesNotMatch(SOURCE, /\{reason\}/)
})

test("自动观察只跟随未终态件数，静默读到终态也清除等待提示", () => {
  assert.match(SOURCE, /variantOperationCounts\(result.items\).open > 0/)
  assert.match(SOURCE, /enabled: unsettled && !cooledDown/)
  assert.match(SOURCE, /if \(counts.open === 0\) clearLive\(LIVE_VARIANT_OPEN\)\s+if \(quiet\) return/)
})
