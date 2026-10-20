import assert from "node:assert/strict"
import test from "node:test"

import { sellerLeakKeys, sellerLeakPhrases } from "./seller-leak"

test("seller leak scanner catches forbidden keys and allows platform fields", () => {
  const leaked = sellerLeakKeys({
    data: {
      supplierId: null,
      presetId: "shp_1",
      operationId: "op",
      cost: 9,
      readiness: {
        skuId: "sku_1",
        presetDisplayName: "莫斯科快递",
        status: "ready",
      },
    },
  })
  leaked.sort()
  assert.deepEqual(leaked, ["cost", "operationId", "presetId", "supplierId"])
})

test("seller leak scanner flags replay copy", () => {
  assert.deepEqual(sellerLeakPhrases("请再创建一次仓库"), ["再创建一次"])
  assert.deepEqual(sellerLeakPhrases("✓ 物流配置已就绪"), [])
})
