import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import publishInput from "./fixtures/listing-core/ozon-publish-input.json"
import schema from "./fixtures/listing-core/decorative-wall-art-schema.json"

// Only this Node-side contract test reads the native oracle. Browser modules
// import app-owned snapshots so their static server never exposes crate tests.
function nativeFixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../rust/crates/listing-core-wasm/tests/fixtures/ambient/${name}.json`, import.meta.url), "utf8"))
}

test("browser publish inputs retain the native freeze contract without importing crate fixtures", () => {
  const native = nativeFixture("ozon-freeze-golden")
  assert.deepEqual(publishInput, { row: native.row, card: native.card })
  assert.deepEqual(schema, nativeFixture("decorative-wall-art-schema"))
})
