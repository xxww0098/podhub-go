import assert from "node:assert/strict"
import test from "node:test"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { mediaRecordWrites } from "./media-object-mirror"
import { LOCAL_CAPACITY, LOCAL_TTL_MS, STORAGE_KEY, flushMediaObjects, reloadMediaObjects,
  lookupMediaObject, rememberMediaObject } from "./media-objects"
import { fresh, activeWorkspace, answer, DIGEST, OTHER, PUBLIC, WORKSPACE } from "./direct-media-test-fixtures"
test("a video entry is keyed by the active Workspace and refused under another", () => {
  fresh()
  rememberMediaObject(answer(DIGEST, "mov", "other-workspace"), DIGEST, "mov")
  assert.equal(lookupMediaObject(DIGEST, "mov"), undefined, "a key outside the active Workspace is never remembered")

  rememberMediaObject(answer(DIGEST, "mov"), DIGEST, "mov")
  assert.equal(lookupMediaObject(DIGEST, "mov")?.via, "local")
  assert.equal(lookupMediaObject(DIGEST, "mp4"), undefined, "extension is part of the object")

  invalidateAccountOverview()
  rememberAccountOverview(activeWorkspace("other-workspace"))
  assert.equal(lookupMediaObject(DIGEST, "mov"), undefined, "switching Workspace hides the other Workspace's set")

  invalidateAccountOverview()
  assert.equal(lookupMediaObject(DIGEST, "mov"), undefined, "no Workspace, no local answer")
})

test("images without a current batch never use the old persistent cache", () => {
  fresh()
  rememberMediaObject(answer(DIGEST), DIGEST, "jpg")
  rememberMediaObject({
    ...answer(DIGEST),
    objectKey: `uploads/2026-09-16/1700000000000-uuid/${DIGEST}.jpg`,
    publicUrl: `${PUBLIC}/uploads/2026-09-16/1700000000000-uuid/${DIGEST}.jpg`,
  }, DIGEST, "jpg")
  assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined)
})

test("an entry expires well inside the lease window", () => {
  fresh()
  const confirmedAt = 1_000_000
  rememberMediaObject(answer(DIGEST, "mov"), DIGEST, "mov", confirmedAt)
  assert.equal(lookupMediaObject(DIGEST, "mov", confirmedAt + LOCAL_TTL_MS - 1)?.via, "local")
  assert.equal(lookupMediaObject(DIGEST, "mov", confirmedAt + LOCAL_TTL_MS), undefined)
  assert.ok(LOCAL_TTL_MS <= 60 * 60 * 1000, "the local window stays a quarter of the 4 h lease")
})

test("confirmations flush one record each and a reload keeps the 1h window", async () => {
  fresh()
  const now = Date.now()
  const before = mediaRecordWrites()
  rememberMediaObject(answer(DIGEST, "mov"), DIGEST, "mov", now)
  rememberMediaObject(answer(OTHER, "mov"), OTHER, "mov", now - LOCAL_TTL_MS)
  assert.equal(mediaRecordWrites(), before, "the mirror is debounced, not written per confirmation")
  assert.equal(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null, null)
  await flushMediaObjects()
  assert.equal(mediaRecordWrites() - before, 2, "each confirmation is its own record")
  await reloadMediaObjects()
  assert.equal(lookupMediaObject(DIGEST, "mov")?.via, "local")
  assert.equal(lookupMediaObject(OTHER, "mov"), undefined, "expired at load, never trusted")
  assert.equal(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null, null)
})

test("the mirror keeps at most LOCAL_CAPACITY records", async () => {
  fresh()
  const now = Date.now()
  const before = mediaRecordWrites()
  for (let index = 0; index < LOCAL_CAPACITY + 1; index += 1) {
    rememberMediaObject({
      accountId: "env-media",
      objectKey: `videos/teams/${WORKSPACE}/n-${index}.mov`,
      publicUrl: `${PUBLIC}/videos/teams/${WORKSPACE}/n-${index}.mov`,
    }, `digest-${index}`, "mov", now + index)
  }
  await flushMediaObjects()
  assert.equal(mediaRecordWrites() - before, LOCAL_CAPACITY)
  await reloadMediaObjects()
  assert.equal(lookupMediaObject("digest-0", "mov"), undefined)
  assert.equal(lookupMediaObject(`digest-${LOCAL_CAPACITY}`, "mov")?.via, "local")
})
