import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { createDiagnosticMemory, type DiagnosticDetail, type OriginalUnavailableReason } from "@/lib/diagnostic-memory"
import { captureDiagnostic, getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import type { DiagnosticEvent } from "@/lib/diagnostic-summary"
import { PublishDiagnosticDetails, type PublishDiagnosticDetailsProps, type PublishDiagnosticReadPorts } from "./publish-diagnostic-details"
import { RemediationDetails } from "./publish-remediation"
import { capturePublishDiagnostic } from "../model/publish-diagnostic"
import { createPublishDiagnosticRoute, PublishDiagnosticReporterContext, type PublishDiagnosticReporter } from "../submit/use-publish-diagnostics"

const id = "11111111-1111-4111-8111-111111111111"
const original = ' { "name": "本机保密商品文本", "currency_code": "RUB" }\n'
const hash = createHash("sha256").update(original).digest("hex")
const event: DiagnosticEvent = {
  schema_version: 4, diagnostic_id: id, trace_id: "request-trace-42", platform: "ozon", stage: "submit",
  field: "name", code: "result_unknown", occurred_at: "2026-10-02T01:00:00.000Z", payload_sha256: hash,
  summary: [{ field: "name", field_id: null, value_type: "string", length: 8, enum_value: null },
    { field: "currency_code", field_id: null, value_type: "string", length: 3, enum_value: "RUB" }],
}

function ports(memory: ReturnType<typeof createDiagnosticMemory>): PublishDiagnosticReadPorts {
  return { getDiagnosticDetail: memory.detail, getDiagnosticCopyData: memory.copyData }
}

/** Like the existing dialog tree tests, SSR renders the real component and
 * Button, then we invoke the handler it emitted; no alternate copy UI exists. */
function rendered(props: PublishDiagnosticDetailsProps, reporter?: PublishDiagnosticReporter) {
  let tree!: ReturnType<typeof PublishDiagnosticDetails>
  function Capture() { tree = PublishDiagnosticDetails(props); return tree }
  const markup = renderToStaticMarkup(<PublishDiagnosticReporterContext.Provider value={reporter}><Capture /></PublishDiagnosticReporterContext.Provider>)
  const pending: ReactNode[] = [tree]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const node = pending.pop()
    if (!isValidElement<Record<string, unknown>>(node)) continue
    elements.push(node)
    pending.push(...Children.toArray(node.props.children as ReactNode))
  }
  return { markup, elements, report() {
    const button = elements.find((node) => node.type === Button && node.props.children === "上报诊断信息")
    assert.ok(button, "the real component must emit its explicit report button only with a route binding")
    assert.ok(typeof button.props.onClick === "function")
    let stopped = 0
    button.props.onClick({ stopPropagation() { stopped++ } })
    assert.equal(stopped, 1)
  }, click() {
    const button = elements.find((node) => node.type === Button && node.props.children === "复制诊断信息")
    assert.ok(button, "the real component must emit its explicit copy button")
    const click = button.props.onClick
    assert.ok(typeof click === "function")
    let stopped = 0
    click({ stopPropagation() { stopped++ } })
    assert.equal(stopped, 1, "copy must not focus or select the containing row")
  } }
}

test("actual detail handler calls the current route reporter only on explicit click, with no clipboard or business action", async () => {
  const environment = browser(), owner = createPublishDiagnosticRoute(() => true)
  setErrorTelemetryContext({ sessionKey: "detail-report-gesture" })
  try {
    const held = await capturePublishDiagnostic({ platform: "ozon", stage: "submit", family: "control", code: "result_unconfirmed" })
    assert.ok(held?.event)
    owner.enter()
    const ui = rendered({ diagnosticId: held.diagnosticId }, owner.report)
    assert.match(ui.markup, /上报诊断信息/)
    assert.deepEqual(environment.calls, { fetch: 0, storage: 0, clipboard: [], notices: [] })
    ui.report()
    assert.equal(environment.calls.fetch, 1, "the current route claim and delivery begin in the click stack")
    ui.report()
    assert.equal(environment.calls.fetch, 1, "duplicate click cannot remint the bounded action")
    await Promise.resolve(); await Promise.resolve()
    assert.equal(environment.calls.clipboard.length, 0)
    assert.equal(environment.calls.storage, 0)
    assert.doesNotMatch(ui.markup + environment.calls.notices.join(""), /上报成功|RAW_|role="alert"/)
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); environment.restore() }
})

test("a rendered report rechecks current identity at click instead of using its previous event snapshot", async () => {
  const environment = browser(), owner = createPublishDiagnosticRoute(() => true)
  setErrorTelemetryContext({ sessionKey: "detail-report-before-switch" })
  try {
    const held = await capturePublishDiagnostic({ platform: "ozon", stage: "freeze", code: "core_unavailable" })
    assert.ok(held?.event)
    owner.enter()
    const ui = rendered({ diagnosticId: held.diagnosticId }, owner.report)
    setErrorTelemetryContext({ sessionKey: "detail-report-after-switch" })
    ui.report()
    await Promise.resolve()
    assert.equal(environment.calls.fetch, 0)
    assert.equal(environment.calls.clipboard.length, 0)
    assert.equal(environment.calls.notices.length, 1)
    assert.match(environment.calls.notices[0]!, /原账户.*当前诊断/)
    assert.doesNotMatch(rendered({ diagnosticId: held.diagnosticId }, owner.report).markup, /上报诊断信息/)
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); environment.restore() }
})

test("trace-only and unbound detail renders cannot invent report permission or expand the closed trace grammar", () => {
  const memory = createDiagnosticMemory(), environment = browser()
  memory.retain(event, { provenance: "native_freeze", jsonText: original })
  try {
    assert.doesNotMatch(rendered({ diagnosticId: id, readPorts: ports(memory) }).markup, /上报诊断信息/)
    assert.doesNotMatch(rendered({ traceId: "trace-only" }, async () => true).markup, /上报诊断信息|诊断编号/)
    assert.equal(rendered({ traceId: "trace:invalid" }).markup, "")
    assert.deepEqual(environment.calls, { fetch: 0, storage: 0, clipboard: [], notices: [] })
  } finally { memory.clear(); environment.restore() }
})

function browser(write: ((text: string) => Promise<void>) | null = async () => {}) {
  const names = ["navigator", "fetch", "localStorage", "sessionStorage", "indexedDB"] as const
  const before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const calls = { fetch: 0, storage: 0, clipboard: [] as string[], notices: [] as string[] }
  const storage = { getItem() { calls.storage++; return null }, setItem() { calls.storage++ },
    removeItem() { calls.storage++ }, clear() { calls.storage++ } }
  const previousToast = toast.add
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: write ? {
    writeText(text: string) { calls.clipboard.push(text); return write(text) },
  } : undefined } })
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => {
    calls.fetch++; throw new Error("diagnostic details must not fetch")
  } })
  for (const name of ["localStorage", "sessionStorage"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: storage })
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() { calls.storage++ } } })
  toast.add = (notice) => { calls.notices.push(String(notice.title)); return "copy-test" }
  return { calls, restore() {
    toast.add = previousToast
    for (const name of names) {
      const descriptor = before.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  } }
}

for (const provenance of ["native_freeze", "submitted_http_body"] as const) {
  test(`rendered diagnostic copy preserves both IDs, full hash, approved summary and exact ${provenance} original`, () => {
    const memory = createDiagnosticMemory()
    memory.retain(Object.assign({ ...event, summary: event.summary.map((field) =>
      Object.assign({ ...field }, { value: "RAW_FIELD_VALUE_MUST_NOT_LEAK" })) },
    { exception: "RAW_EXCEPTION_MUST_NOT_LEAK" }), { provenance, jsonText: original })
    const environment = browser()
    let detailReads = 0, copyReads = 0
    const readPorts: PublishDiagnosticReadPorts = {
      getDiagnosticDetail: (key) => { detailReads++; return memory.detail(key) },
      getDiagnosticCopyData: (key) => { copyReads++; return memory.copyData(key) },
    }
    try {
      const ui = rendered({ diagnosticId: id, traceId: "stale-view-trace", readPorts })
      assert.match(ui.markup, new RegExp(`诊断编号.*${id}.*请求追踪编号.*request-trace-42`, "s"))
      assert.ok(ui.markup.includes(hash), "the hash must contain all 64 characters")
      assert.match(ui.markup, /批准的字段摘要.*name.*类型 string.*长度 8.*currency_code.*枚举 RUB/s)
      assert.match(ui.markup, /原文仅在本机内存中保留/)
      assert.doesNotMatch(ui.markup, /本机保密商品文本|RAW_EXCEPTION_MUST_NOT_LEAK|RAW_FIELD_VALUE_MUST_NOT_LEAK|stale-view-trace|role="alert"/)
      assert.deepEqual(environment.calls, { fetch: 0, storage: 0, clipboard: [], notices: [] })
      assert.equal(detailReads, 1)
      assert.equal(copyReads, 0, "render may never request the original")
      ui.click()
      assert.equal(copyReads, 1)
      assert.equal(environment.calls.clipboard.length, 1, "the write begins synchronously in the click")
      assert.deepEqual(JSON.parse(environment.calls.clipboard[0]!), {
        diagnosticId: id, traceId: event.trace_id, platform: event.platform, stage: event.stage,
        field: event.field, code: event.code, occurredAt: event.occurred_at, payloadSha256: hash,
        // The clipboard projection stays camelCase; only the v4 wire event is snake_case.
        summary: event.summary.map((field) => ({ field: field.field, fieldId: field.field_id,
          valueType: field.value_type, length: field.length, enumValue: field.enum_value })),
        hasOriginal: true, originalUnavailableReason: null, provenance, originalJson: original,
      })
      assert.doesNotMatch(environment.calls.clipboard[0]!, /RAW_EXCEPTION_MUST_NOT_LEAK|RAW_FIELD_VALUE_MUST_NOT_LEAK/)
      assert.equal(environment.calls.fetch + environment.calls.storage + environment.calls.notices.length, 0)
    } finally { memory.clear(); environment.restore() }
  })
}

test("the production singleton and shared remediation use the same current diagnostic and explicit copy", async () => {
  const environment = browser()
  try {
    setErrorTelemetryContext({ sessionKey: "diagnostic-ui-fixture" })
    // Fixture setup is an explicit capture outside render, not a UI producer.
    const captured = await captureDiagnostic({ code: "result_unknown", platform: "ozon", stage: "submit", field: "name",
      traceEvidence: { requestHeaderTraceId: "production-request-trace" },
      exactOperation: { provenance: "submitted_http_body", jsonText: original } })
    assert.ok(captured?.event)
    assert.equal(captured.event.payload_sha256, hash)
    const markup = renderToStaticMarkup(<RemediationDetails view={{ reason: "原发送结果未确认", scope: "原店铺",
      steps: ["核对原 Intent，确认前不要重新发送"], diagnosticId: captured.diagnosticId, traceId: "old-trace" }} />)
    assert.ok(markup.includes(captured.diagnosticId))
    assert.ok(markup.includes(hash))
    assert.match(markup, /请求追踪编号.*production-request-trace/s)
    assert.doesNotMatch(markup, /本机保密商品文本|old-trace/)
    assert.deepEqual(environment.calls, { fetch: 0, storage: 0, clipboard: [], notices: [] })
    const ui = rendered({ diagnosticId: captured.diagnosticId })
    ui.click()
    const copied = JSON.parse(environment.calls.clipboard[0]!)
    assert.equal(copied.diagnosticId, captured.diagnosticId)
    assert.equal(copied.traceId, captured.event.trace_id)
    assert.equal(copied.payloadSha256, hash)
    assert.deepEqual(copied.summary, captured.event.summary.map((field) => ({ field: field.field, fieldId: field.field_id,
      valueType: field.value_type, length: field.length, enumValue: field.enum_value })))
    assert.equal(copied.provenance, "submitted_http_body")
    assert.equal(copied.originalJson, original)
    setErrorTelemetryContext({ sessionKey: null })
    ui.click()
    const afterSwitch = JSON.parse(environment.calls.clipboard[1]!)
    assert.equal(afterSwitch.originalJson, null)
    assert.equal(afterSwitch.traceId, null)
    assert.equal(afterSwitch.originalUnavailableReason, "not_retained")
    assert.equal(getDiagnosticDetail(captured.diagnosticId).event, null)
    assert.equal(environment.calls.fetch + environment.calls.storage + environment.calls.notices.length, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); environment.restore() }
})

test("opening the real remediation stays read-only and a fresh diagnostic render reads expired metadata", () => {
  let now = 0
  const memory = createDiagnosticMemory(() => now)
  memory.retain(event, { provenance: "native_freeze", jsonText: original })
  const environment = browser()
  try {
    const before = rendered({ diagnosticId: id, readPorts: ports(memory) })
    assert.match(before.markup, /原文仅在本机内存中保留/)
    now = 30 * 60 * 1000
    let tree!: ReturnType<typeof RemediationDetails>
    function Capture() { tree = RemediationDetails({ view: { reason: "原发送结果未确认", scope: "原店铺", steps: ["先核对原 Intent"], diagnosticId: id } }); return tree }
    renderToStaticMarkup(<Capture />)
    const toggle = tree.props.onToggle
    assert.ok(typeof toggle === "function")
    toggle({ currentTarget: { open: true } })
    const opened = rendered({ diagnosticId: id, readPorts: ports(memory) })
    assert.match(opened.markup, /原文已超过 30 分钟/)
    assert.ok(opened.markup.includes(hash), "expiration keeps the full original hash")
    assert.deepEqual(environment.calls, { fetch: 0, storage: 0, clipboard: [], notices: [] })
    before.click() // Even a handler emitted while retained must take a new copy read.
    const copied = JSON.parse(environment.calls.clipboard[0]!)
    assert.equal(copied.originalJson, null)
    assert.equal(copied.originalUnavailableReason, "expired")
    assert.equal(copied.payloadSha256, hash)
  } finally { memory.clear(); environment.restore() }
})

for (const change of ["expiry", "eviction", "identity-switch"] as const) {
  test(`an explicit copy after ${change} cannot reuse a previously rendered original`, () => {
    let now = 0
    const memory = createDiagnosticMemory(() => now)
    memory.retain(event, { provenance: "submitted_http_body", jsonText: original })
    const environment = browser()
    try {
      const ui = rendered({ diagnosticId: id, traceId: "stale-view-trace", readPorts: ports(memory) })
      if (change === "expiry") now = 30 * 60 * 1000
      if (change === "identity-switch") memory.clear()
      if (change === "eviction") for (let i = 0; i < 100; i++) memory.retain({ ...event, diagnostic_id: `other-${i}` }, null)
      ui.click()
      const copied = JSON.parse(environment.calls.clipboard[0]!)
      assert.equal(copied.diagnosticId, id)
      assert.equal(copied.originalJson, null)
      assert.equal(copied.hasOriginal, false)
      assert.equal(copied.originalUnavailableReason, change === "expiry" ? "expired" : "not_retained")
      assert.equal(copied.traceId, change === "expiry" ? event.trace_id : null)
      assert.equal(copied.payloadSha256, change === "expiry" ? hash : null)
      assert.doesNotMatch(environment.calls.clipboard[0]!, /本机保密商品文本|stale-view-trace|other-/)
      const updated = rendered({ diagnosticId: id, readPorts: ports(memory) })
      assert.match(updated.markup, change === "expiry" ? /原文已超过 30 分钟/ : /该诊断记录已不在当前账户/)
      assert.equal(environment.calls.fetch + environment.calls.storage + environment.calls.notices.length, 0)
    } finally { memory.clear(); environment.restore() }
  })
}

test("current copy read and clipboard write share one stack before a queued identity change", async () => {
  const memory = createDiagnosticMemory()
  memory.retain(event, { provenance: "native_freeze", jsonText: original })
  const order: string[] = []
  const environment = browser(async () => { order.push("write") })
  try {
    const ui = rendered({ diagnosticId: id, readPorts: {
      getDiagnosticDetail: memory.detail,
      getDiagnosticCopyData(key) {
        order.push("current-read")
        queueMicrotask(() => { order.push("identity-change"); memory.clear() })
        return memory.copyData(key)
      },
    } })
    ui.click()
    assert.deepEqual(order, ["current-read", "write"])
    assert.equal(JSON.parse(environment.calls.clipboard[0]!).originalJson, original)
    await Promise.resolve()
    assert.deepEqual(order, ["current-read", "write", "identity-change"])
  } finally { memory.clear(); environment.restore() }
})

test("a missing or mismatched diagnostic record never copies another record or a stale trace", () => {
  const memory = createDiagnosticMemory()
  memory.retain({ ...event, diagnostic_id: "other-record" }, { provenance: "native_freeze", jsonText: original })
  const environment = browser()
  try {
    const ui = rendered({ diagnosticId: id, traceId: "stale-trace", readPorts: {
      getDiagnosticDetail: () => memory.detail("other-record"),
      getDiagnosticCopyData: () => memory.copyData("other-record"),
    } })
    assert.match(ui.markup, /当前记录不可用/)
    assert.doesNotMatch(ui.markup, /request-trace-42|other-record|stale-trace|本机保密商品文本/)
    ui.click()
    const copied = JSON.parse(environment.calls.clipboard[0]!)
    assert.equal(copied.diagnosticId, id)
    assert.equal(copied.traceId, null)
    assert.equal(copied.originalJson, null)
    assert.equal(copied.provenance, null)
    assert.equal(copied.payloadSha256, null)
    assert.equal(copied.originalUnavailableReason, "not_retained")
  } finally { memory.clear(); environment.restore() }
})

const unavailable: Record<OriginalUnavailableReason, RegExp> = {
  no_exact_payload: /没有取得确切 payload，未保留原文/,
  oversize: /超过单条 8 MiB/,
  expired: /超过 30 分钟/,
  byte_limit: /本机诊断内存达到保留上限/,
  not_retained: /不在当前账户的本机内存/,
}
for (const reason of Object.keys(unavailable) as OriginalUnavailableReason[]) {
  test(`readonly diagnostic details explain ${reason} without reading or displaying an original`, () => {
    let copies = 0
    const detail: DiagnosticDetail = { diagnosticId: id, event: reason === "not_retained" ? null : event,
      hasOriginal: false, originalUnavailableReason: reason }
    const ui = rendered({ diagnosticId: id, readPorts: {
      getDiagnosticDetail: () => detail,
      getDiagnosticCopyData: () => { copies++; return { detail, provenance: null, originalJson: null } },
    } })
    assert.match(ui.markup, unavailable[reason])
    assert.doesNotMatch(ui.markup, /本机保密商品文本|role="alert"/)
    assert.equal(copies, 0)
  })
}

test("trace-only explicit copy contains only request metadata and never invents a diagnostic or payload", () => {
  const environment = browser()
  let reads = 0
  try {
    const ui = rendered({ traceId: "trace-only", readPorts: {
      getDiagnosticDetail: () => { reads++; throw new Error("no diagnostic record exists") },
      getDiagnosticCopyData: () => { reads++; throw new Error("no original exists") },
    } })
    assert.match(ui.markup, /请求追踪编号.*trace-only/s)
    assert.doesNotMatch(ui.markup, /诊断编号|SHA-256|原文/)
    assert.equal(environment.calls.clipboard.length, 0)
    ui.click()
    assert.deepEqual(JSON.parse(environment.calls.clipboard[0]!), { traceId: "trace-only" })
    assert.equal(reads, 0)
  } finally { environment.restore() }
})

for (const failure of ["missing-permission", "rejected-write", "throwing-write"] as const) {
  test(`clipboard ${failure} emits exactly one actionable notification and no raw DOM error`, async () => {
    const environment = browser(failure === "missing-permission" ? null : () => {
      const reason = new Error("RAW_CLIPBOARD_EXCEPTION")
      if (failure === "throwing-write") throw reason
      return Promise.reject(reason)
    })
    try {
      const ui = rendered({ traceId: "request-trace-42" })
      assert.equal(environment.calls.notices.length, 0)
      ui.click()
      await Promise.resolve()
      assert.equal(environment.calls.notices.length, 1)
      assert.match(environment.calls.notices[0]!, /诊断信息未复制.*允许浏览器访问剪贴板后重试.*手动复制/s)
      assert.doesNotMatch(environment.calls.notices[0]!, /RAW_CLIPBOARD_EXCEPTION/)
      assert.doesNotMatch(rendered({ traceId: "request-trace-42" }).markup, /RAW_CLIPBOARD_EXCEPTION|诊断信息未复制|role="alert"/)
    } finally { await Promise.resolve(); environment.restore() }
  })
}
