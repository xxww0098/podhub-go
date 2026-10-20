import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { createDiagnosticContext, type DiagnosticContextInput } from "./diagnostic-context"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRACE_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"
const LEAKS = [
  "см. https://cdn.example.invalid/a.jpg", "www.example.invalid", "/Users/someone/Pictures/a.png",
  "картина /home/someone/a.png", "C:\\Users\\someone\\a.png", "file:///tmp/a.png", "blob:3f2b8c1e",
  "data:image/png;base64,AAAA", "Bearer abc.def.ghi", "token=abc123", "api_key : abc123",
  "Authorization: Basic abc", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.leaked", "-----BEGIN PRIVATE KEY-----",
  "seller-ops@example.invalid", "bell\u0007", "broken \ud800 surrogate",
]

test("defaults are safe runtime context with a fresh trace id and no payload", () => {
  const first = createDiagnosticContext()
  const second = createDiagnosticContext({})
  assert.deepEqual({ ...first.context, traceId: "" }, { platform: "web", stage: "runtime", field: null, traceId: "" })
  assert.match(first.context.traceId, UUID)
  assert.notEqual(first.context.traceId, second.context.traceId)
  assert.deepEqual(Object.keys(first), ["context"], "local metadata has no v3 rawPayload transport result")
})

test("explicit context is kept, normalized or replaced by defaults", () => {
  const kept = createDiagnosticContext({ platform: "Ozon", stage: "submit.readback", field: "attributes[0].values[0].value", traceId: TRACE_ID.toUpperCase() })
  assert.deepEqual(kept.context, { platform: "ozon", stage: "submit.readback", field: "attributes[0].values[0].value", traceId: TRACE_ID.toUpperCase() })
  assert.equal(createDiagnosticContext({ platform: "yandex_market" }).context.platform, "yandex_market")
  assert.equal(createDiagnosticContext({ traceId: "request.Trace-7" }).context.traceId, "request.Trace-7")
  const bad = createDiagnosticContext({ platform: "ozon market", stage: "提交", field: "商品标题", traceId: "invalid trace!" })
  assert.equal(bad.context.platform, "web")
  assert.equal(bad.context.stage, "runtime")
  assert.equal(bad.context.field, null)
  assert.match(bad.context.traceId, UUID)
  for (const field of ["name is required", "/Users/someone/a.json", "attributes[1234567]", "a".repeat(129), "token"]) assert.equal(createDiagnosticContext({ field }).context.field, null, field)
})

test("Ozon and WB business objects remain uninspected local metadata, never a transport projection", () => {
  for (const kind of ["ozon_fields", "wb_fields"] as const) {
    let reads = 0
    const data = { get name() { reads++; return "secret" }, title: "装饰画", vendorCode: "private", price: "990" }
    const context = createDiagnosticContext({ traceId: TRACE_ID, platform: kind === "ozon_fields" ? "ozon" : "wb", rawPayload: { kind, data } })
    assert.equal(reads, 0)
    assert.deepEqual(Object.keys(context), ["context"])
    for (const value of ["secret", "装饰画", "private", "990"]) assert.ok(!JSON.stringify(context).includes(value))
  }
})

test("runtime and HTTP metadata cannot substitute for exact original payload evidence", () => {
  for (const rawPayload of [
    { kind: "runtime" as const, data: { memoryBytes: 1024, rows: 2 } },
    { kind: "http" as const, data: { method: "POST", path: route("listingSubmit"), status: 502, body: "secret" } },
  ]) {
    const result = createDiagnosticContext({ rawPayload })
    assert.deepEqual(Object.keys(result), ["context"])
    assert.equal("payloadSha256" in result, false)
    assert.ok(!JSON.stringify(result).includes("secret"))
  }
})

test("native crashes, Error objects and unknown kinds never become a payload", () => {
  for (const rawPayload of [null, undefined, "Error: secret", new Error("token=secret"), { kind: "headers", data: { token: "secret" } }]) {
    const result = createDiagnosticContext({ rawPayload } as unknown as DiagnosticContextInput)
    assert.deepEqual(Object.keys(result), ["context"])
    assert.ok(!JSON.stringify(result).includes("secret"))
  }
})

test("URLs, secrets, local paths and control characters never reach local context or remote payload", () => {
  for (const leak of LEAKS) {
    const result = createDiagnosticContext({ rawPayload: { kind: "ozon_fields", data: { name: leak, price: leak, attributes: [{ id: 4191, values: [{ value: leak }] }] } } })
    assert.deepEqual(Object.keys(result), ["context"])
    assert.ok(!JSON.stringify(result).includes(leak), leak)
  }
})

test("arrays, depth and large business objects are not serialized by the metadata helper", () => {
  const cyclic: Record<string, unknown> = { title: "ы".repeat(100_000) }; cyclic.self = cyclic
  const result = createDiagnosticContext({ rawPayload: { kind: "wb_fields", data: cyclic } })
  assert.deepEqual(Object.keys(result), ["context"])
  assert.ok(JSON.stringify(result).length < 200)
})

test("hostile getters and proxies never throw and keep safe defaults", () => {
  let reads = 0
  const throwing = { get() { reads++; throw new Error("getter") } }
  const input = Object.defineProperties({}, { platform: throwing, stage: throwing, field: throwing, traceId: throwing, rawPayload: throwing })
  const result = createDiagnosticContext(input)
  assert.equal(reads, 0)
  assert.equal(result.context.platform, "web")
  assert.match(result.context.traceId, UUID)
  const trap = new Proxy({}, { get() { throw new Error("trap") }, getOwnPropertyDescriptor() { throw new Error("trap") } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const hostile of [trap, revoked.proxy]) assert.doesNotThrow(() => createDiagnosticContext(hostile))
})
