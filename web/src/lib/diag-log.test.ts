import assert from "node:assert/strict"
import test from "node:test"

import { route } from "@/api/routes"
import { diagLine, diagLog, PREPARE_LOG, RENDER_LOG, reportError, stageCountFields } from "./diag-log"
import { setErrorTelemetryContext } from "./error-telemetry"

test("a diagnostic line is one prefixed, greppable key=value row", () => {
  assert.equal(
    diagLine(RENDER_LOG, "renderProduct.ok", {
      design: "SZ-0001.png",
      template: 3,
      ms: 1234.6,
      memoryBytes: 268435456,
      skipped: undefined,
      retry: true,
    }),
    "[render-wasm] renderProduct.ok design=SZ-0001.png template=3 ms=1235 memoryBytes=268435456 retry=true",
  )
  assert.equal(diagLine(PREPARE_LOG, "batch"), "[prepare] batch")
})

test("stage timings flatten to counts, with milliseconds only where the renderer had a clock", () => {
  // Missing timing remains a count; measured stages retain their duration.
  assert.deepEqual(
    stageCountFields({
      psdParse: { ms: null, count: 1 },
      pass2Composite: { ms: null, count: 37 },
      encodeTotal: { ms: 812.25, count: 4 },
      broken: { count: "x" },
    }),
    { psdParse: 1, pass2Composite: 37, encodeTotal: "4/812.3ms" },
  )
  assert.deepEqual(stageCountFields(null), {})
  assert.deepEqual(stageCountFields("nope"), {})
})

test("diagLog writes exactly one console line", () => {
  const original = console.log
  const lines: unknown[][] = []
  console.log = (...args: unknown[]) => {
    lines.push(args)
  }
  try {
    diagLog(PREPARE_LOG, "row.done", { row: "row-1", ms: 42 })
  } finally {
    console.log = original
  }
  assert.deepEqual(lines, [["[prepare] row.done row=row-1 ms=42"]])
})

test("error reporting keeps safe causal symbols once without messages, URLs or arbitrary fields", () => {
  const lines: unknown[][] = []
  const original = console.log
  console.log = (...args) => { lines.push(args) }
  const cause = new Error("socket closed")
  const error = Object.assign(new Error("upload failed", { cause }), { token: "secret" })
  error.stack = "Error: token=secret\n    at uploadAsset (https://cdn.invalid/app.js?token=secret:4:2)"
  cause.stack = "Error: Bearer secret\n    at relayMedia (/Users/operator/private/source.ts:5:1)"
  cause.cause = error
  try {
    reportError("[api]", error, { status: 503 })
    reportError("[notify]", error)
    reportError("[browser]", { token: "secret" })
    reportError("[browser]", { message: "failed", code: "LOCAL_IO", token: "secret" })
    assert.deepEqual(lines, [
      ["[api] error code=operation_failed status=503 frames=uploadAsset,relayMedia"],
      ["[browser] error code=operation_failed"],
      ["[browser] error code=LOCAL_IO"],
    ])
    assert.ok(!JSON.stringify(lines).includes("secret"))
  } finally {
    console.log = original
  }
})

test("notification diagnostics keep reviewed copy, omit raw reason and redact credential shapes", () => {
  const original = console.log
  const lines: unknown[][] = []
  console.log = (...args) => { lines.push(args) }
  try {
    diagLog("[notify]", "error", {
      message: "上传未完成 https://cdn.invalid?token=secret password=secret",
      description: "raw private body", reason: "Bearer secret", code: "cloud_unavailable",
    })
    assert.deepEqual(lines, [["[notify] error code=cloud_unavailable message=上传未完成 [omitted] [omitted]"]])
  } finally { console.log = original }
})

test("render worker errors preserve safe worker/request/time correlation", () => {
  const original = console.log
  const lines: string[] = []
  console.log = (line) => { lines.push(String(line)) }
  try {
    for (const request of [1, 2, 3]) reportError("[render-wasm]", "raw token=secret", {
      worker: "a1b2c3d4", request, atMs: 1234, event: "secret",
    })
    assert.equal(lines.length, 3)
    for (const [index, line] of lines.entries()) {
      assert.match(line, new RegExp(`worker=a1b2c3d4 request=${index + 1} atMs=1234`))
      assert.ok(!line.includes("secret"))
    }
  } finally { console.log = original }
})

function captureLocal(report: () => void) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  let requests = 0
  let timers = 0
  const lines: string[] = []
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected inbox") }) as typeof fetch
  globalThis.setTimeout = (() => { timers++; return timers as unknown as ReturnType<typeof setTimeout> }) as unknown as typeof setTimeout
  globalThis.clearTimeout = () => undefined
  console.log = (line) => { lines.push(String(line)) }
  try {
    setErrorTelemetryContext({ sessionKey: "test:local-diagnostics" })
    report()
    assert.equal(requests, 0)
    assert.equal(timers, 0, "no low-level diagnostic can schedule an inbox flush")
    return lines
  } finally {
    setErrorTelemetryContext({ sessionKey: null })
    globalThis.fetch = originalFetch
    console.log = originalLog
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
}

test("local notification validation and actual exceptions both remain console-only before normalization", () => {
  const lines = captureLocal(() => {
    diagLog("[notify]", "error", { message: "请填写方案名称。" })
    diagLog("[notify]", "error", { message: "没有可发送的商品。" }, { platform: "ozon", stage: "submit", rawPayload: { kind: "ozon_fields", data: { name: "本地校验" } } })
    reportError("[row-store]", new Error("raw token=secret"), { code: "local_storage_full", stage: "save" })
  })
  assert.equal(lines.length, 3)
  assert.match(lines[2]!, /code=local_storage_full stage=save/)
  assert.ok(!JSON.stringify(lines).includes("secret"))
})

test("known pipeline stage and leg retain local dedupe and row correlation without automatic receipts", () => {
  const lines = captureLocal(() => {
    for (let i = 0; i < 3; i++) diagLog(PREPARE_LOG, "media.fail", { leg: "upload", row: "private-row", message: "raw response token=secret" })
    diagLog(PREPARE_LOG, "media.fail", { leg: "upload", row: "other-private-row", message: "raw response token=secret" })
  })
  assert.equal(lines.filter((line) => /row=private-row(?: |$)/.test(line)).length, 1)
  assert.equal(lines.filter((line) => /row=other-private-row(?: |$)/.test(line)).length, 1)
  assert.match(lines[0]!, /stage=media leg=upload/)
  assert.match(lines[0]!, /frames=stage:media,leg:upload/)
  assert.ok(!JSON.stringify(lines).includes("secret"))
})

const TRACE = "3f2c9a4e-8b1d-4c6f-9e2a-5d7b1c0f4a86"

test("an API failure keeps local method/status/request correlation without copying its response", () => {
  const lines = captureLocal(() => {
    reportError("[api]", Object.assign(new Error("raw body token=secret"), { code: "cloud_bad_gateway" }), {
      method: "POST", path: route("listingSubmit"), durationMs: 12, status: 502, requestId: TRACE, kind: "http",
    })
  })
  assert.match(lines[0]!, /code=cloud_bad_gateway/)
  assert.match(lines[0]!, new RegExp(`requestId=${TRACE}`))
  assert.ok(!JSON.stringify(lines).includes("secret"))
})

test("a render worker failure keeps numeric counters and console correlation without a remote event", () => {
  const lines = captureLocal(() => {
    reportError("[render-wasm]", "raw token=secret", { worker: "a1b2c3d4", request: 7, atMs: 1234, memoryBytes: 1024, imageIndex: 2, event: "secret", stage: "render" })
  })
  assert.match(lines[0]!, /worker=a1b2c3d4 request=7 atMs=1234/)
  assert.match(lines[0]!, /frames=stage:render/)
  assert.ok(!JSON.stringify(lines).includes("secret"))
})

test("explicit Ozon business input stays uninspected while the supplied trace is logged unchanged", () => {
  let reads = 0
  const raw = { get name() { reads++; throw new Error("secret") }, token: "secret" }
  const lines = captureLocal(() => {
    reportError("[listing]", Object.assign(new Error("raw secret"), { code: "ozon_attribute_invalid" }), { stage: "submit" }, {
      platform: "ozon", stage: "submit", traceId: TRACE, rawPayload: { kind: "ozon_fields", data: raw },
    })
  })
  assert.equal(reads, 0)
  assert.match(lines[0]!, new RegExp(`traceId=${TRACE}`))
  assert.ok(!JSON.stringify(lines).includes("secret"))
})

test("explicit null payload and hostile context cannot turn arbitrary exception text into a diagnostic event", () => {
  const lines = captureLocal(() => {
    diagLog(PREPARE_LOG, "submit.fail", { status: 500, attempt: 2 }, { rawPayload: null })
    const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("secret") }, get() { throw new Error("secret") } })
    assert.doesNotThrow(() => reportError("[hostile]", new Error("secret"), { status: 500 }, hostile))
  })
  assert.equal(lines.length, 2)
  assert.ok(!JSON.stringify(lines).includes("secret"))
})
