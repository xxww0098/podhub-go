import assert from "node:assert/strict"
import test from "node:test"
import {
  deleteResume, fileFromGrantedHandle, psdResumeId, readResume, resetResumeMemory, sliceResumeId, writeResume,
} from "./upload-resume-store"

test("a resume record keeps the fingerprint, finished parts, objects, and the target row", async () => {
  resetResumeMemory()
  const id = sliceResumeId("ws", "row-1", "ab".repeat(32))
  await writeResume({
    id,
    kind: "slice",
    sha256: "ab".repeat(32),
    rowId: "row-1",
    workspaceUuid: "ws",
    fileName: "",
    byteLength: 30,
    updatedAt: 1,
    completedParts: [],
    uploadBatch: "batch-1",
    batchExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    objects: [{
      digest: "cd".repeat(32),
      extension: "jpg",
      byteLength: 30,
      objectKey: "uploads/a.jpg",
      accountId: "acct",
      putDone: true,
      confirmed: true,
    }],
  })
  const stored = await readResume(id)
  assert.equal(stored?.rowId, "row-1")
  assert.equal(stored?.sha256, "ab".repeat(32))
  assert.equal(stored?.objects[0]?.objectKey, "uploads/a.jpg")
  assert.equal(stored?.objects[0]?.confirmed, true)
  await deleteResume(id)
  assert.equal(await readResume(id), null)
})

test("a finished part is not a new PUT, and an unreadable handle does not resume", async () => {
  resetResumeMemory()
  const sha = "ef".repeat(32)
  await writeResume({
    id: psdResumeId(sha),
    kind: "psd",
    sha256: sha,
    rowId: "card-1",
    workspaceUuid: "ws",
    fileName: "a.psd",
    byteLength: 10,
    updatedAt: 1,
    uploadId: "up",
    ticket: "ticket",
    partSize: 8,
    completedParts: [{ partNumber: 1, etag: "\"a\"" }],
    objects: [],
  })
  const stored = await readResume(psdResumeId(sha))
  assert.equal(stored?.completedParts.length, 1)
  assert.equal(stored?.ticket, "ticket")
  assert.equal(stored?.rowId, "card-1")
  const denied = await fileFromGrantedHandle({
    queryPermission: async () => "prompt",
    getFile: async () => { throw new Error("should not read") },
  } as unknown as FileSystemFileHandle)
  assert.equal(denied, null)
})
