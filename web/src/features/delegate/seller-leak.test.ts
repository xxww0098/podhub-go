import assert from "node:assert/strict"
import test from "node:test"

import { assertDelegateSurfaceClean, delegateLeakKeys } from "./seller-leak"

test("delegate seller leak scanner catches factory and dispatch internals", () => {
  const leaked = delegateLeakKeys({
    data: {
      contact: null,
      internalNote: "厂家内部备注",
      sourceName: "禁造的厂家名键",
      factoryId: "src_1",
      supplierCost: 900,
      dispatchId: null,
      attemptedBy: "auto",
      attemptCount: 2,
      dispatch_attempts: [],
      source: { sourceId: "src_delegate_ok", name: "委托厂家甲" },
    },
  })
  leaked.sort()
  assert.deepEqual(leaked, [
    "attemptCount",
    "attemptedBy",
    "contact",
    "dispatchId",
    "dispatch_attempts",
    "factoryId",
    "internalNote",
    "sourceName",
    "supplierCost",
  ])
})

test("delegate seller surface keeps its own whitelist keys", () => {
  // sourceId/name 是卖家可见的厂家 linkage（SellerSupplierDbData 形状）；
  // sellerNote/packetState/sku 都是卖家 wire 的合法键。
  const leaked = delegateLeakKeys({
    order: {
      orderId: "0189cccc",
      postingNumber: "P-1",
      sellerNote: "请用加厚纸管",
      state: "dispatched",
      lines: [
        {
          offerId: "OFFER-1",
          sku: 529602791,
          name: "挂画 40x50",
          packetState: "dispatched",
          source: { sourceId: "src_delegate_ok", name: "委托厂家甲", country: "CN", icon: "" },
        },
      ],
    },
  })
  assert.deepEqual(leaked, [])
  // 白名单形状整体可过断言门（卖家屏渲染侧的真实入口）。
  assertDelegateSurfaceClean({ order: { state: "dispatched", lines: [] } })
})
