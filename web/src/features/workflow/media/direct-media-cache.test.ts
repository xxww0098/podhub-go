import assert from "node:assert/strict"
import test from "node:test"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { mediaRecordWrites } from "./media-object-mirror"
import { LOCAL_CAPACITY, LOCAL_TTL_MS, STORAGE_KEY, flushMediaObjects, reloadMediaObjects,
  lookupMediaObject, rememberMediaObject } from "./media-objects"
import { fresh, activeWorkspace, answer, DIGEST, OTHER, PUBLIC, WORKSPACE } from "./direct-media-test-fixtures"
test("an entry is keyed by the active Workspace and refused when Cloud's key is under another", () => {
  fresh()
  rememberMediaObject(answer(DIGEST, "jpg", "other-workspace"), DIGEST, "jpg")
  assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined, "a key outside the active Workspace is never remembered")

  rememberMediaObject(answer(DIGEST), DIGEST, "jpg")
  assert.equal(lookupMediaObject(DIGEST, "jpg")?.via, "local")
  assert.equal(lookupMediaObject(DIGEST, "png"), undefined, "extension is part of the object")

  invalidateAccountOverview()
  rememberAccountOverview(activeWorkspace("other-workspace"))
  assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined, "switching Workspace hides the other Workspace's set")

  invalidateAccountOverview()
  assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined, "no Workspace, no local answer")
})

test("a real uploads timestamp key without batch scope never enters legacy cache", () => {
  fresh()
  rememberMediaObject({
    ...answer(DIGEST),
    objectKey: `uploads/2026-09-16/1700000000000-uuid/images/teams/${WORKSPACE}/sha256/${DIGEST}.jpg`,
    publicUrl: `${PUBLIC}/uploads/2026-09-16/1700000000000-uuid/images/teams/${WORKSPACE}/sha256/${DIGEST}.jpg`,
  }, DIGEST, "jpg")
  assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined)
})

test("an entry expires well inside the lease window", () => {
  fresh()
  const confirmedAt = 1_000_000
  rememberMediaObject(answer(DIGEST), DIGEST, "jpg", confirmedAt)
  assert.equal(lookupMediaObject(DIGEST, "jpg", confirmedAt + LOCAL_TTL_MS - 1)?.via, "local")
  assert.equal(lookupMediaObject(DIGEST, "jpg", confirmedAt + LOCAL_TTL_MS), undefined)
  assert.ok(LOCAL_TTL_MS <= 60 * 60 * 1000, "the local window stays a quarter of the 4 h lease")
})

test("confirmations flush one record each and a reload keeps the 1h window", async () => {
  fresh()
  const now = Date.now()
  const before = mediaRecordWrites()
  rememberMediaObject(answer(DIGEST), DIGEST, "jpg", now)
  rememberMediaObject(answer(OTHER), OTHER, "jpg", now - LOCAL_TTL_MS)
  assert.equal(mediaRecordWrites(), before, "the mirror is debounced, not written per confirmation")
  assert.equal(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null, null)
  await flushMediaObjects()
  assert.equal(mediaRecordWrites() - before, 2, "each confirmation is its own record")
  await reloadMediaObjects()
  assert.equal(lookupMediaObject(DIGEST, "jpg")?.via, "local")
  assert.equal(lookupMediaObject(OTHER, "jpg"), undefined, "expired at load, never trusted")
  assert.equal(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null, null)
})

test("the mirror keeps at most LOCAL_CAPACITY records", async () => {
  fresh()
  const now = Date.now()
  const before = mediaRecordWrites()
  for (let index = 0; index < LOCAL_CAPACITY + 1; index += 1) {
    rememberMediaObject({
      accountId: "env-media",
      objectKey: `images/teams/${WORKSPACE}/n-${index}.jpg`,
      publicUrl: `${PUBLIC}/images/teams/${WORKSPACE}/n-${index}.jpg`,
    }, `digest-${index}`, "jpg", now + index)
  }
  await flushMediaObjects()
  assert.equal(mediaRecordWrites() - before, LOCAL_CAPACITY)
  await reloadMediaObjects()
  assert.equal(lookupMediaObject("digest-0", "jpg"), undefined)
  assert.equal(lookupMediaObject(`digest-${LOCAL_CAPACITY}`, "jpg")?.via, "local")
})
