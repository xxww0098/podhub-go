import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { AccountOverview } from "@/bindings/commands"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { createErrorFeedback, reportFeedback } from "@/lib/error-feedback"
import { setErrorTelemetryContext } from "@/lib/error-telemetry"
import type { FrozenItem } from "../platforms/core"
import type { OzonBody } from "../platforms/ozon"
import { sendRefusalNotice } from "./send-report-context"
import { readSendHttpExchange, submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"

const endpoint = route("listingSubmit")
const rowId = "row-ready"
const userId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const workspaceId = "11111111-2222-3333-4444-555555555555"

function item(): FrozenItem<OzonBody> {
  return { key: rowId, body: { rowId, storeId: "store", offerId: rowId, import: { name: "local" },
    evidence: { digest: "preview", card_defaults_digest: "defaults", sources: [] } } as OzonBody,
  digest: "preview", clientOperationId: "local", provenance: [] }
}

test("a ready row blocked on media records the submit exchange and a secret-free summary", async () => {
  const original = globalThis.fetch
  const receipts: string[] = []
  rememberAccountOverview({
    session: { authenticated: true, email: "person@example.invalid" },
    owned_count: 0, owned_limit: 0,
    accounts: [{ active: true, email: "person@example.invalid", name: "Person", uuid: userId }],
    active_workspace: { id: 1, uuid: workspaceId, is_owned: true, name: "Workspace", plan: "pro", role: "owner" },
  } as AccountOverview)
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url === route("eventsInbox")) {
      receipts.push(String(init?.body))
      const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
      return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
    }
    assert.equal(url, endpoint)
    return Response.json({ data: { items: [{ row_id: rowId, created: false, skipped: "blocked", blockers: ["media_not_ready"] }] } },
      { headers: { "x-request-id": "req-ready-media" } })
  }) as typeof fetch
  const context: OzonSendContext = { storeId: "store", pins: new Map([[rowId, { revision: 3 }]]),
    shouldStop: () => false, results: new Map(), syncRequired: false, replayed: false }
  try {
    await submitOzonChunk(context, [item()])
    const result = context.results.get(rowId)!
    assert.equal(result.outcome, "blocked")
    assert.deepEqual(result.blockers, ["media_not_ready"])
    assert.deepEqual(readSendHttpExchange(result), { apiPath: endpoint, apiStatus: 200, requestId: "req-ready-media" })
    const images = Array.from({ length: 8 }, () => ({
      phase: "public_ready", object_key: "teams/secret/object", public_url: "https://cdn.example/img.jpg?X-Amz-Signature=secret", file_name: "img-0.jpg",
    }))
    const notice = sendRefusalNotice(result, {
      cardId: "card-1", blockedRows: 30, exchange: readSendHttpExchange(result),
      lifecycle: { stage: "ready_to_publish", media: "ready", image_total: 8, image_completed: 8, images, product_videos: [] },
    })
    const feedback = createErrorFeedback(notice.reason, "发送未执行：媒体尚未上传完成")
    reportFeedback(feedback, notice.context, true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(receipts.length, 1)
    const payload = JSON.parse(JSON.parse(receipts[0]!).events[0].payload_json)
    assert.equal(payload.errorId, feedback.errorId)
    assert.equal(payload.code, "media_not_ready")
    assert.equal(payload.userId, userId)
    assert.equal(payload.workspaceId, workspaceId)
    assert.equal(payload.requestId, "req-ready-media")
    assert.equal(payload.apiPath, endpoint)
    assert.equal(payload.apiStatus, 200)
    assert.equal(payload.rowId, rowId)
    assert.equal(payload.cardId, "card-1")
    assert.equal(payload.stage, "submit")
    assert.equal(payload.media.stage, "ready_to_publish")
    assert.equal(payload.media.media, "ready")
    assert.equal(payload.media.imageTotal, 8)
    assert.equal(payload.media.imageCompleted, 8)
    assert.equal(payload.media.phases, "public_ready:8")
    assert.equal(payload.media.objects, "bound:8,unbound:0")
    assert.equal(payload.media.videos, 0)
    assert.equal(payload.media.cover, "absent")
    assert.equal(payload.media.blockedRows, 30)
    assert.match(payload.userAgent, /^[\x20-\x7e]{1,180}$/)
    assert.doesNotMatch(receipts[0]!, /https|X-Amz|teams\/secret|img-0|person@example|发送未执行|媒体尚未/)
  } finally {
    setErrorTelemetryContext({ sessionKey: null })
    invalidateAccountOverview()
    globalThis.fetch = original
  }
})
