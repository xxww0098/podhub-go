import assert from "node:assert/strict"
import test from "node:test"
import { factoryViewFromPath } from "./factory-workspace"

test("factory routes select the requested order list", () => {
  assert.equal(factoryViewFromPath("/supplier"), "dashboard")
  assert.equal(factoryViewFromPath("/supplier/orders/pending"), "pending")
  assert.equal(factoryViewFromPath("/supplier/orders/producing"), "producing")
  assert.equal(factoryViewFromPath("/supplier/orders/urgent"), "urgent")
  assert.equal(factoryViewFromPath("/supplier/orders/shipped/"), "shipped")
})
