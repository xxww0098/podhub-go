/**
 * Local confirm plan: inconsistent objects never spend a media-upload slot,
 * and an admission 429 stays on the batch instead of fanning out to N completes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { advanceBusyClock } from "./executor-test-support"
import { confirmSliceBatch } from "./slice-batch-upload"
import { resetUploadMeter } from "./upload-batch-meter"
import type { DeliveredMediaObject, DeliverMediaObjectRequest } from "../media/direct-media-types"

const DIGEST = "ab".repeat(32)

function request(digest = DIGEST): DeliverMediaObjectRequest {
  return {
    digest,
    extension: "jpg",
    contentType: "image/jpeg",
    byteLength: 4,
    bytes: () => new Uint8Array([1, 2, 3, 4]),
    workspaceUuid: "test-workspace",
    retry: { attempts: 6, maxWaitMs: 60_000, random: () => 0 },
  }
}

function delivered(objectKey: string): DeliveredMediaObject {
  return {
    via: "put",
    pendingConfirm: true,
    accountId: "acct",
    objectKey,
    publicUrl: `https://cdn.example.invalid/${objectKey}`,
    workspaceUuid: "test-workspace",
    storageRevision: 1,
    uploadTicket: "ticket",
    timing: { bytes: 4, readMs: 0, hashMs: 0, presignMs: 0, putMs: 1, completeMs: 0 },
  }
}

test("a mismatched object key never calls complete", async () => {
  const calls: string[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response("no", { status: 500 })
  }) as typeof fetch
  try {
    await assert.rejects(
      () => confirmSliceBatch([{ request: request(), delivered: delivered("o/slice-1.jpg") }]),
      (reason: unknown) => (reason as { code?: string }).code === "media_confirm_key",
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = previous
    resetUploadMeter()
  }
})

test("an admission refusal does not split into single completes", async (context) => {
  const calls: string[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ code: "user_over_budget", message: "busy" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "0" },
    })
  }) as typeof fetch
  const key = `images/teams/test-workspace/sha256/${DIGEST}.jpg`
  try {
    await assert.rejects(
      () => advanceBusyClock(context, () => confirmSliceBatch([{ request: request(), delivered: delivered(key) }])),
      (reason: unknown) => (reason as { code?: string }).code === "media_complete_kept_batch",
    )
    assert.ok(calls.length > 0)
    assert.ok(calls.every((url) => url.endsWith(route("mediaObjectsCompleteBatch"))))
    assert.equal(calls.some((url) => url.endsWith("/complete")), false)
  } finally {
    globalThis.fetch = previous
    resetUploadMeter()
  }
})
