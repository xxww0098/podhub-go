import assert from "node:assert/strict"
import test from "node:test"
import { deleteResume, resetResumeMemory, sliceResumeId, writeResume } from "@/bindings/upload-resume-store"
import { batchStillValid, openSliceResume, resumedDelivery } from "./slice-resume"

test("a confirmed slice object resumes locally and does not force the old batch", async () => {
  resetResumeMemory()
  const digest = "ab".repeat(32)
  const id = sliceResumeId("ws", "row-1", digest)
  await writeResume({
    id,
    kind: "slice",
    sha256: digest,
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
  const resume = await openSliceResume({ workspaceUuid: "ws", rowId: "row-1", manifestDigest: digest })
  assert.equal(resume.batch, undefined)
  const delivered = resume.delivery("cd".repeat(32), "jpg")
  assert.equal(delivered?.via, "local")
  assert.equal(delivered?.pendingConfirm, undefined)
  assert.equal(delivered?.objectKey, "uploads/a.jpg")
  await deleteResume(id)
})

test("a finished PUT still confirms against the same batch while the token is valid", async () => {
  resetResumeMemory()
  const digest = "ef".repeat(32)
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
  const id = sliceResumeId("ws", "row-2", digest)
  await writeResume({
    id,
    kind: "slice",
    sha256: digest,
    rowId: "row-2",
    workspaceUuid: "ws",
    fileName: "",
    byteLength: 10,
    updatedAt: 1,
    completedParts: [],
    uploadBatch: "batch-live",
    batchExpiresAt: expiresAt,
    objects: [{
      digest,
      extension: "png",
      byteLength: 10,
      objectKey: "uploads/b.png",
      accountId: "acct",
      uploadTicket: "ticket",
      workspaceUuid: "ws",
      storageRevision: 3,
      putDone: true,
      confirmed: false,
    }],
  })
  const resume = await openSliceResume({ workspaceUuid: "ws", rowId: "row-2", manifestDigest: digest })
  assert.equal(resume.batch?.uploadBatch, "batch-live")
  assert.equal(resume.delivery(digest, "png")?.pendingConfirm, true)
  assert.equal(batchStillValid({ uploadBatch: "batch-live", batchExpiresAt: expiresAt }), true)
  await deleteResume(id)
})

test("an expired batch cannot confirm a finished PUT again", () => {
  assert.equal(resumedDelivery({
    digest: "aa".repeat(32),
    extension: "png",
    byteLength: 10,
    objectKey: "k",
    accountId: "a",
    uploadTicket: "t",
    workspaceUuid: "ws",
    storageRevision: 1,
    putDone: true,
    confirmed: false,
  }, false), undefined)
})
