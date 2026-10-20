import assert from "node:assert/strict"
import test from "node:test"
import { withScreen } from "@/lib/admin-surface"
import { mergeObservationProducts, observationProductKey, observationScopeFromSearch, observationScopeKey, withObservationScope } from "./observation-scope"
import { observedProduct, STORE_A, STORE_B, WORKSPACE_A, WORKSPACE_B } from "./observation-fixtures"

test("console → products → console retains explicit viewing scope, never an ActiveWorkspace id", () => {
  const search = withObservationScope("?screen=admin-console", { workspaceId: WORKSPACE_A, storeId: STORE_A })
  const products = withScreen(search, "admin-products")
  assert.deepEqual(observationScopeFromSearch(products), { workspaceId: WORKSPACE_A, storeId: STORE_A })
  assert.deepEqual(observationScopeFromSearch(withScreen(products, "admin-console")), observationScopeFromSearch(search))
  assert.doesNotMatch(search, /active_workspace|workspace_id|session/)
  const next = withObservationScope(products, { workspaceId: WORKSPACE_B })
  assert.deepEqual(observationScopeFromSearch(next), { workspaceId: WORKSPACE_B, storeId: undefined })
  assert.equal(new URLSearchParams(next).get("screen"), "admin-products")
})

test("an invalid explicit scope is not silently widened to all", () => {
  assert.deepEqual(observationScopeFromSearch("?workspaceId=unknown&storeId=wrong"), { workspaceId: "unknown", storeId: "wrong" })
  assert.notEqual(observationScopeKey({ workspaceId: WORKSPACE_A }), observationScopeKey({ workspaceId: WORKSPACE_B }))
  assert.notEqual(observationScopeKey({ storeId: STORE_A }), observationScopeKey({ storeId: STORE_B }))
})

test("two workspaces with identical store/product names, ids and offer keys remain isolated", () => {
  const a = observedProduct()
  const b = observedProduct(WORKSPACE_B, STORE_B)
  assert.notEqual(observationProductKey(a), observationProductKey(b))
  assert.equal(observationProductKey(a), observationProductKey({ ...a, product: { ...a.product, offer_id: "RENAMED" } }))
  assert.notEqual(observationProductKey(a), observationProductKey({ ...a, workspace_id: WORKSPACE_B }))
  const merged = mergeObservationProducts([a], [b, { ...a, product: { ...a.product, stock_present: 9 } }])
  assert.equal(merged.length, 2)
  assert.equal(merged[0]?.product.stock_present, 9)
  assert.equal(merged[1]?.product.stock_present, 3)
})
