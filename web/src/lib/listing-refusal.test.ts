import assert from "node:assert/strict"
import test from "node:test"
import { concreteToken, refusalPair } from "./listing-refusal"

test("refusal pairs keep a concrete code and drop placeholders", () => {
  assert.equal(concreteToken("operation_failed"), undefined)
  assert.equal(concreteToken("-"), undefined)
  assert.equal(concreteToken("https://secret"), undefined)
  assert.equal(refusalPair({ code: "https://secret" }), undefined)
  assert.deepEqual(refusalPair({ serverCode: "offer_busy", code: "cloud_offer_busy" }), {
    code: "offer_busy", refusal: "offer_busy",
  })
  assert.deepEqual(refusalPair({ code: "operation_failed", refusalReason: "media_not_ready" }), {
    code: "media_not_ready", refusal: "media_not_ready",
  })
  assert.deepEqual(refusalPair({ blockers: ["media_not_ready"] }), {
    code: "media_not_ready", refusal: "media_not_ready",
  })
  assert.deepEqual(
    refusalPair({ code: "validation", blockers: ['{"orphaned_running_state":{"store_id":"secret"}}'] }),
    { code: "validation", refusal: "orphaned_running_state" },
  )
  const throwing = Object.defineProperty({}, "code", { get() { throw new Error("must not execute") } })
  assert.equal(refusalPair(throwing), undefined)
})
