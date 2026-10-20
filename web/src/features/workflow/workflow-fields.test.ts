import assert from "node:assert/strict"
import test from "node:test"

import { fixedSelectCurrent, fixedSelectOptions } from "./workflow-fields"

test("a supplier-projected decimal VAT selects the same option as text", () => {
  const options = fixedSelectOptions("vat")!.map((option) => option.value)
  for (const rate of [0, 0.1, 0.2]) {
    const current = fixedSelectCurrent({ kind: "decimal", value: rate })
    assert.ok(current !== null && options.includes(current), `${rate} → ${current}`)
    assert.equal(current, fixedSelectCurrent({ kind: "text", value: String(rate) }))
  }
})

test("an empty or non-scalar value selects nothing", () => {
  assert.equal(fixedSelectCurrent(undefined), null)
  assert.equal(fixedSelectCurrent({ kind: "text_list", value: ["0"] }), null)
})
