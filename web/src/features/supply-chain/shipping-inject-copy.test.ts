import assert from "node:assert/strict"
import test from "node:test"

import type { SellerShippingReadiness } from "@/bindings/http-supply-chain"

import {
  SELLER_INJECT_COPY,
  presentSellerInject,
} from "./shipping-inject-copy"
import { assertSellerSurfaceClean, sellerLeakPhrases } from "./seller-leak"

function readiness(
  patch: Partial<SellerShippingReadiness> &
    Pick<SellerShippingReadiness, "status" | "reasons">,
): SellerShippingReadiness {
  return {
    sku_id: "sku_1",
    inject_ready: patch.status === "ready",
    preset_display_name: "莫斯科快递",
    ...patch,
  }
}

const snapshots: SellerShippingReadiness[] = [
  readiness({ status: "blocked", reasons: ["shop_not_injected"] }),
  readiness({ status: "ready", reasons: [], inject_status: "succeeded" }),
  readiness({ status: "stale", reasons: ["stale_version"], inject_status: "succeeded" }),
  readiness({ status: "blocked", reasons: ["waiting"], inject_status: "waiting" }),
  readiness({ status: "blocked", reasons: ["result_unknown"], inject_status: "unknown" }),
  readiness({ status: "blocked", reasons: ["failed"], inject_status: "failed" }),
  readiness({ status: "blocked", reasons: ["missing_bind"] }),
  readiness({ status: "blocked", reasons: ["writes_disabled"] }),
]

test("seller inject copy matches SHIP-04 states and never offers replay", () => {
  assert.equal(
    presentSellerInject(readiness({ status: "blocked", reasons: ["shop_not_injected"] }))
      .statusText,
    SELLER_INJECT_COPY.notConfigured,
  )
  assert.equal(
    presentSellerInject(readiness({ status: "blocked", reasons: ["shop_not_injected"] }))
      .actionLabel,
    SELLER_INJECT_COPY.inject,
  )
  assert.equal(
    presentSellerInject(
      readiness({ status: "ready", reasons: [], inject_status: "succeeded" }),
    ).statusText,
    SELLER_INJECT_COPY.ready,
  )
  const stale = presentSellerInject(
    readiness({ status: "stale", reasons: ["stale_version"], inject_status: "succeeded" }),
  )
  assert.equal(stale.statusText, SELLER_INJECT_COPY.stale)
  assert.equal(stale.actionLabel, SELLER_INJECT_COPY.update)
  assert.equal(
    presentSellerInject(
      readiness({ status: "blocked", reasons: ["waiting"], inject_status: "waiting" }),
    ).statusText,
    SELLER_INJECT_COPY.waiting,
  )
  const unknown = presentSellerInject(
    readiness({
      status: "blocked",
      reasons: ["result_unknown"],
      inject_status: "unknown",
    }),
  )
  assert.equal(unknown.statusText, SELLER_INJECT_COPY.unknown)
  assert.equal(unknown.action, null)
  assert.equal(unknown.actionLabel, null)
})

test("seller inject JSON and copy snapshots stay leak-free", () => {
  for (const row of snapshots) {
    const view = presentSellerInject(row)
    const text = [view.statusText, view.actionLabel ?? ""].join(" ")
    assertSellerSurfaceClean(row, text)
    assert.equal(sellerLeakPhrases(text).includes("再创建一次"), false)
    assert.doesNotMatch(text, /再创建一次/)
  }
})
