import assert from "node:assert/strict"
import test from "node:test"

import { assertSupplierSurfaceClean, supplierLeakKeys } from "./supplier-leak"

test("supplier leak scanner catches ownership keys including null values", () => {
  const leaked = supplierLeakKeys({
    data: {
      orgId: null,
      org_id: "42",
      storeId: null,
      storeName: "店名不下发",
      sellerName: "卖家身份",
      seller: "x",
      workspaceId: null,
      workspace: {},
      sku: null,
      skuId: 529602791,
      attempted_by: null,
      attemptCount: 2,
      "dispatch-attempts": [],
      sourceName: "禁造的厂家名键",
    },
  })
  leaked.sort()
  assert.deepEqual(leaked, [
    "attemptCount",
    "attempted_by",
    "dispatch-attempts",
    "orgId",
    "org_id",
    "seller",
    "sellerName",
    "sku",
    "skuId",
    "sourceName",
    "storeId",
    "storeName",
    "workspace",
    "workspaceId",
  ])
})

test("supplier queue whitelist shape is clean", () => {
  // 白名单：包号/posting/行三元组/素材下载路由；source_id 是本厂
  // linkage 的显式白名单，seller_note 是随单备注。
  const leaked = supplierLeakKeys({
    dispatches: [
      {
        dispatch_id: "0189dddd",
        dispatch_no: "dsp_abc",
        posting_number: "P-1",
        state: "dispatched",
        deadline: "2026-10-01",
        lines: [
          {
            offer_id: "OFFER-1",
            name: "挂画 40x50",
            quantity: 2,
            assets: [
              {
                asset_id: "0189aaaa",
                file_name: "原图.png",
                sha256: "a".repeat(64),
                bytes: 11,
                mime: "image/png",
                // 同源中转下载路由的占位（路径事实源在 @/api/routes，此处不拼写）。
                url: "/relative/asset-route",
              },
            ],
          },
        ],
        seller_note: "轻拿轻放",
        nudge_count: 1,
        nudged_at_ms: 1,
        payout_cents: 1500,
        payout_state: "held",
      },
    ],
    sources: [{ source_id: "src_1", name: "厂家甲", country: "CN", icon: "" }],
  })
  assert.deepEqual(leaked, [])
  // 白名单形状整体可过断言门（队列渲染侧的真实入口）。
  assertSupplierSurfaceClean({ dispatches: [], sources: [] })
})
