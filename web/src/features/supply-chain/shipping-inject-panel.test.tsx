import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { SellerShippingReadiness } from "@/bindings/http-supply-chain"

import { assertSellerSurfaceClean, sellerLeakPhrases } from "./seller-leak"
import { ShippingInjectPanel } from "./shipping-inject-panel"

function readiness(
  patch: Partial<SellerShippingReadiness> &
    Pick<SellerShippingReadiness, "status" | "reasons">,
): SellerShippingReadiness {
  return {
    sku_id: "sku_1",
    inject_ready: patch.status === "ready",
    preset_display_name: "莫斯科快递",
    warehouse_id: 88,
    delivery_method_id: 12,
    ...patch,
  }
}

function html(row: SellerShippingReadiness): string {
  return renderToStaticMarkup(
    <ShippingInjectPanel readiness={row} shopName="注入店" />,
  )
}

test("inject panel paints platform-safe copy for each SHIP-04 state", () => {
  const idle = html(readiness({ status: "blocked", reasons: ["shop_not_injected"] }))
  assert.match(idle, /平台物流配置/)
  assert.match(idle, /莫斯科快递/)
  assert.match(idle, /注入店/)
  assert.match(idle, /尚未配置/)
  assert.match(idle, />注入到店铺</)

  const ready = html(
    readiness({ status: "ready", reasons: [], inject_status: "succeeded" }),
  )
  assert.match(ready, /物流配置已就绪/)
  assert.doesNotMatch(ready, />注入到店铺</)

  const stale = html(
    readiness({
      status: "stale",
      reasons: ["stale_version"],
      inject_status: "succeeded",
    }),
  )
  assert.match(stale, /平台物流配置有更新/)
  assert.match(stale, />更新店铺物流配置</)

  const waiting = html(
    readiness({ status: "blocked", reasons: ["waiting"], inject_status: "waiting" }),
  )
  assert.match(waiting, /Ozon 正在处理物流配置/)
  assert.doesNotMatch(waiting, />注入到店铺</)

  const unknown = html(
    readiness({
      status: "blocked",
      reasons: ["result_unknown"],
      inject_status: "unknown",
    }),
  )
  assert.match(unknown, /物流配置状态待核对，请勿重复提交/)
  assert.doesNotMatch(unknown, />注入到店铺</)
  assert.doesNotMatch(unknown, /再创建一次/)
})

test("inject panel DOM and seller JSON omit forbidden leak keys", () => {
  const row = readiness({
    status: "blocked",
    reasons: ["result_unknown"],
    inject_status: "unknown",
  })
  const markup = html(row)
  assertSellerSurfaceClean(row, markup)
  assert.equal(sellerLeakPhrases(markup).length, 0)
  assert.doesNotMatch(markup, /warehouseId|deliveryMethodId|skuId|presetId|operationId/)
  assert.doesNotMatch(markup, /供应商|供货来源|再创建一次/)
})

test("inject panel source does not mention ops-shipping or suppliers", () => {
  const source = readFileSync(new URL("./shipping-inject-panel.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /ops-shipping|features\/suppliers|ops\/supply/)
  assert.doesNotMatch(source, /SELLER_INJECT_COPY\.replay/)
})
