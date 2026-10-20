import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { approvedDiagnosticField, diagnosticSha256, summarizeDiagnosticJson } from "./diagnostic-summary"

test("full UTF8 SHA256 differs beyond the old clip boundary and does not reorder JSON", async () => {
  const first = '{ "name": "' + "界🐱".repeat(9000) + 'a", "price": 20 }\n'
  const second = first.replace('a",', 'b",')
  const hash = await diagnosticSha256(first)
  assert.equal(hash, createHash("sha256").update(first, "utf8").digest("hex"))
  assert.notEqual(hash, await diagnosticSha256(second))
  assert.notEqual(hash, await diagnosticSha256(JSON.stringify(JSON.parse(first))))
})

test("Unicode scalar lengths, container counts, exact null keys and catalog IDs match v4", () => {
  const fields = summarizeDiagnosticJson(JSON.stringify({
    name: "俄🐱文", price: 9, vat: false, old_price: null, description_category_id: 123,
    attributes: [{ id: 85, values: [{ dictionary_value_id: 7, value: "Кот🐱" }] }],
  }))
  const byField = Object.fromEntries(fields.map((entry) => [entry.field, entry]))
  assert.deepEqual(byField.name, { field: "name", value_type: "string", length: 3, field_id: null, enum_value: null })
  assert.equal(byField["attributes"]?.length, 1)
  assert.equal(byField["attributes[0]"]?.length, 2)
  assert.equal(byField["attributes[0].id"]?.field_id, 85)
  assert.equal(byField["attributes[0].values[0].dictionary_value_id"]?.field_id, 7)
  assert.equal(byField.description_category_id?.field_id, 123)
  assert.equal(byField.price?.field_id, null)
  for (const name of ["price", "vat", "old_price"]) assert.equal(byField[name]?.length, null)
})

test("safe Ozon business values become only types and lengths; unknown keys never survive", () => {
  const raw = { name: "Постер «Кот»", offer_id: "private-offer", price: "990", token: "secret", images: ["https://cdn.invalid"] }
  const result = summarizeDiagnosticJson(JSON.stringify(raw))
  assert.deepEqual(result.map((entry) => entry.field), ["name", "offer_id", "price"])
  for (const leak of ["Постер", "private-offer", "990", "secret", "images", "cdn.invalid"]) assert.ok(!JSON.stringify(result).includes(leak))
})

test("safe WB business values become only structural evidence and native catalog IDs", () => {
  const result = summarizeDiagnosticJson(JSON.stringify({ subjectID: 123, vendorCode: "secret-vendor", title: "装饰画🐱", characteristics: [{ id: 987, value: ["Россия"] }], nmID: 123456789 }))
  const byField = Object.fromEntries(result.map((entry) => [entry.field, entry]))
  assert.equal(byField.subjectID?.field_id, 123)
  assert.equal(byField["characteristics[0].id"]?.field_id, 987)
  assert.equal(byField["characteristics[0].value"]?.length, 1)
  assert.equal(byField.title?.length, 4)
  for (const leak of ["secret-vendor", "Россия", "装饰画", "nmID", "123456789"]) assert.ok(!JSON.stringify(result).includes(leak))
})

test("closed enums survive only at their exact currency/unit coordinates", () => {
  for (const currency_code of ["RUB", "USD", "EUR", "CNY"]) assert.equal(summarizeDiagnosticJson(JSON.stringify({ currency_code }))[0]?.enum_value, currency_code)
  for (const dimension_unit of ["mm", "cm", "m"]) assert.equal(summarizeDiagnosticJson(JSON.stringify({ dimension_unit }))[0]?.enum_value, dimension_unit)
  for (const weight_unit of ["g", "kg"]) assert.equal(summarizeDiagnosticJson(JSON.stringify({ weight_unit }))[0]?.enum_value, weight_unit)
  for (const result of summarizeDiagnosticJson('{"name":"RUB","currency_code":"token=secret","dimension_unit":"kg","weight_unit":"mm","price":"USD"}')) assert.equal(result.enum_value, null)
})

test("approved address grammar rejects unknown names, oversized indices and arbitrary paths", () => {
  for (const field of ["name", "attributes[999999].values[0].value", "characteristics[1].id"]) assert.equal(approvedDiagnosticField(field), true)
  for (const field of ["", "secret", "name.secret", "attributes[1000000]", "attributes[-1]", "name.", "../private", "https://evil.invalid", "a".repeat(129)]) assert.equal(approvedDiagnosticField(field), false, field)
})

test("arrays and depth produce at most 64 fields; invalid JSON produces no invented evidence", () => {
  const result = summarizeDiagnosticJson(JSON.stringify({ attributes: Array.from({ length: 1000 }, (_, id) => ({ id, values: [{ value: "x" }] })) }))
  assert.equal(result.length, 64)
  assert.equal(new Set(result.map((entry) => entry.field)).size, 64)
  const nested = { value: { value: { value: { value: { value: { value: { value: { value: { value: { value: "raw" } } } } } } } } } }
  assert.ok(summarizeDiagnosticJson(JSON.stringify(nested)).length <= 9)
  for (const text of ["{", "null", "[]", '"token=secret"']) assert.deepEqual(summarizeDiagnosticJson(text), [])
})

test("literal dotted and bracketed keys cannot impersonate native catalog field addresses", async () => {
  const text = ' \n{"attributes[0].id":7654321,"characteristics[0].id":8765432,"dimensions.length":9876543,"attributes.0.id":6543210,"name.value":"俄🐱"}\n'
  assert.deepEqual(summarizeDiagnosticJson(text), [])
  assert.equal(await diagnosticSha256(text), createHash("sha256").update(text, "utf8").digest("hex"))
})

test("nested literal collisions are skipped; generated summaries remain unique and follow backend grammar", () => {
  const text = JSON.stringify({
    dimensions: { length: 12, "length.width": 7654321, "length[0]": 8765432 },
    attributes: [{ id: 85, "values[0].value": "poison", values: [{ value: "俄🐱", "value.price": 9876543, "dictionary_value_id[0]": 6543210 }] }],
    "attributes[0].id": 5432109, name: { value: "safe", "value.value": "poison" },
  })
  const result = summarizeDiagnosticJson(text)
  assert.deepEqual(result.map((field) => field.field), [
    "dimensions", "dimensions.length", "attributes", "attributes[0]", "attributes[0].id", "attributes[0].values",
    "attributes[0].values[0]", "attributes[0].values[0].value", "name", "name.value",
  ])
  assert.equal(new Set(result.map((field) => field.field)).size, result.length)
  assert.deepEqual(result.filter((field) => field.field_id !== null).map((field) => [field.field, field.field_id]), [["attributes[0].id", 85]])
  assert.equal(result.find((field) => field.field === "attributes[0].values[0].value")?.length, 2)
  for (const entry of result) {
    assert.equal(approvedDiagnosticField(entry.field), true)
    assert.equal(entry.length !== null, ["string", "array", "object"].includes(entry.value_type))
    assert.equal(entry.enum_value, null)
  }
  assert.doesNotMatch(JSON.stringify(result), /7654321|8765432|9876543|6543210|5432109|poison|俄/)
})
