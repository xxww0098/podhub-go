import assert from "node:assert/strict"
import test from "node:test"
import { ROUTES } from "@/api/routes"
import { createErrorFeedback, errorTransportContext, reportFeedback } from "./error-feedback"
import { listingMediaSummary, safeUserAgent } from "./error-report-environment"
import { setErrorTelemetryContext } from "./error-telemetry"
import { productVersion } from "./product-version"

const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const WORKSPACE = "11111111-2222-3333-4444-555555555555"

test("media summary keeps phases and counts and drops urls, keys and names", () => {
  const images = [
    { phase: "public_ready", object_key: "teams/secret/object", public_url: "https://cdn.example/a.jpg?X-Amz-Signature=secret" },
    { phase: "public_ready", object_key: "" },
  ]
  const summary = listingMediaSummary({
    stage: "ready_to_publish",
    media: "ready",
    image_total: 8,
    image_completed: 8,
    images,
    product_videos: [{ public_url: "https://cdn.example/pending.mp4" }],
    video_cover: undefined,
  }, 30)
  assert.deepEqual(summary, {
    stage: "ready_to_publish", media: "ready", imageTotal: 8, imageCompleted: 8,
    phases: "public_ready:2", videos: 1, cover: "absent", objects: "bound:1,unbound:1", blockedRows: 30,
  })
  assert.doesNotMatch(JSON.stringify(summary), /https|secret|mp4|Amz|teams\//)
})

test("user agent with a credential or url is omitted", () => {
  assert.equal(safeUserAgent("Mozilla/5.0 (test)"), "Mozilla/5.0 (test)")
  assert.equal(safeUserAgent("Mozilla/5.0 token=secret"), undefined)
  assert.equal(safeUserAgent("https://cdn.example/agent"), undefined)
})

test("reported error number carries session identity and the http path, not the ocr id or the email", async () => {
  const payloads: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    payloads.push(String(init?.body))
    const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
    return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
  }) as typeof fetch
  try {
    setErrorTelemetryContext({ sessionKey: "env-report", userId: USER, workspaceId: WORKSPACE })
    const reason = { code: "cloud_request_failed", status: 502, traceId: "http-trace",
      requestId: "ocr-business-must-not-leak", apiPath: `${ROUTES.listingSubmit}?sig=secret`,
      message: "token=secret https://cdn.example/a.jpg" }
    const feedback = createErrorFeedback(reason, "发送失败")
    reportFeedback(feedback, { ...errorTransportContext(reason), stage: "submit", rowId: "row-1" }, true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(payloads.length, 1)
    const payload = JSON.parse(JSON.parse(payloads[0]!).events[0].payload_json)
    assert.equal(payload.userId, USER)
    assert.equal(payload.workspaceId, WORKSPACE)
    assert.equal(payload.requestId, "http-trace")
    assert.equal(payload.apiPath, undefined)
    assert.equal(payload.apiStatus, 502)
    assert.equal(payload.traceId, "http-trace")
    const version = productVersion()
    if (/^\d+\.\d+\.\d+$/.test(version)) assert.equal(payload.appVersion, version)
    assert.doesNotMatch(payloads[0]!, /person@example|Workspace|ocr-business|token=|https:|sig=/)
  } finally {
    setErrorTelemetryContext({ sessionKey: null })
    globalThis.fetch = original
  }
})
