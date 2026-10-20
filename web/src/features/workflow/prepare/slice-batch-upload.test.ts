import assert from "node:assert/strict"
import test from "node:test"

import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"

import type { DeliveredMediaObject, DeliverMediaObjectRequest } from "../media/direct-media-types"

const workspace = "batch-workspace"

function overview() {
  const row = { id: 7, uuid: workspace, name: "Test", plan: "pro", role: "owner", is_owned: true }
  return {
    session: { authenticated: true, email: "test@example.invalid", role: "user" },
    entitlement: {
      plan: "pro",
      features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
      limits: {
        stores: 1, stores_used: 0, seats: 1, seats_used: 1, s3_upload_bytes_monthly: 0,
        s3_upload_bytes_used: 0, ai_tokens_monthly: 0, ai_tokens_used: 0, ai_calls_per_day: 0,
      },
    },
    active_workspace: row,
    workspaces: [row],
    account_mode: "owner" as const,
    owned_count: 1,
    owned_limit: 3,
  }
}

function pending(digest: string): { request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject } {
  const objectKey = `images/teams/${workspace}/sha256/${digest}.jpg`
  return {
    request: {
      digest,
      extension: "jpg",
      contentType: "image/jpeg",
      byteLength: 4,
      bytes: () => new Uint8Array([1, 2, 3, 4]),
      workspaceUuid: workspace,
    },
    delivered: {
      publicUrl: `https://cdn.example.invalid/${objectKey}`,
      objectKey,
      accountId: "acct",
      workspaceUuid: workspace,
      storageRevision: 1,
      via: "put",
      pendingConfirm: true,
      uploadTicket: `ticket-${digest}`,
      timing: { bytes: 4, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0 },
    },
  }
}

test("one failed object does not discard the siblings a complete-batch already confirmed", async () => {
  rememberAccountOverview(overview())
  const previous = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
    if (url.endsWith("/complete-batch")) {
      const objects = (body.objects as { object_key: string, byte_length: number }[]).map((item, index) => index === 0
        ? {
          object: {
            transport: "ready",
            workspace_uuid: workspace,
            account_id: "acct",
            object_key: item.object_key,
            public_url: `https://cdn.example.invalid/${item.object_key}`,
            storage_revision: 1,
            byte_length: item.byte_length,
            deduplicated: false,
            checksum_trusted: true,
          },
        }
        : { error: { status: 429, code: "UNAVAILABLE", error: "媒体并发已满，请稍后重试", retry_after: 1 } })
      return new Response(JSON.stringify({ data: { objects } }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.endsWith("/complete")) {
      return new Response(JSON.stringify({
        data: {
          transport: "ready",
          workspace_uuid: workspace,
          account_id: body.account_id,
          object_key: body.object_key,
          public_url: `https://cdn.example.invalid/${body.object_key}`,
          storage_revision: body.storage_revision,
          byte_length: body.byte_length,
          deduplicated: false,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("missing", { status: 500 })
  }) as typeof fetch
  try {
    const { confirmSliceBatch } = await import("./slice-batch-upload")
    const first = "a".repeat(64)
    const second = "b".repeat(64)
    const delivered = await confirmSliceBatch([pending(first), pending(second)])
    assert.equal(delivered.length, 2)
    assert.equal(delivered[0]?.pendingConfirm, undefined)
    assert.equal(delivered[1]?.pendingConfirm, undefined)
    assert.equal(delivered[0]?.objectKey, pending(first).delivered.objectKey)
    assert.equal(delivered[1]?.objectKey, pending(second).delivered.objectKey)
    const singles = calls.filter((url) => url.endsWith("/complete") && !url.endsWith("/complete-batch"))
    assert.equal(singles.length, 1, "only the failed object falls back to single complete")
    assert.match(singles[0]!, new RegExp(`/${second}/jpg/complete$`))
  } finally {
    globalThis.fetch = previous
    invalidateAccountOverview()
  }
})
