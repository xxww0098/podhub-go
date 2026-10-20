import assert from "node:assert/strict"
import test from "node:test"

import { addTransfer, finishUploadBatch, logUploadRow, uploadEndFields, type SliceTransferStat, type UploadRowStat } from "./upload-transfer-log"

function capture(run: () => void): string[] {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try { run() } finally { console.log = original }
  return lines
}

test("a row summary and one batch line carry bytes, phase times, and throughput", () => {
  const batch = {}
  const stat: UploadRowStat = {
    rowId: "row-1",
    startedAt: 0,
    endedAt: 2000,
    bindMs: 30,
    slices: [
      { index: 1, bytes: 500, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0, via: "local" },
      {
        index: 0, bytes: 1_000_000, encodeMs: 12, readMs: 1, hashMs: 2,
        presignMs: 3, putMs: 400, completeMs: 20, via: "put",
      },
    ],
  }
  const lines = capture(() => {
    logUploadRow(stat, batch)
    finishUploadBatch(batch)
    finishUploadBatch(batch)
  })
  assert.deepEqual(lines, [
    "[prepare] upload row=row-1 slices=2 manifestBytes=1000500 putBytes=1000000 encodeMs=12 readMs=1 hashMs=2 presignMs=3 putMs=400 completeMs=20 bindMs=30 wallMs=2000 MBps=0.50 via=put:1,local:1",
    "[prepare] upload.slices row=row-1 parts=0:1000000:12:1:2:3:400:20:put 1:500:-:0:0:0:0:0:local",
    "[prepare] upload.batch rows=1 slices=2 manifestBytes=1000500 putBytes=1000000 encodeMs=12 readMs=1 hashMs=2 presignMs=3 putMs=400 completeMs=20 bindMs=30 wallMs=2000 MBps=0.50 via=put:1,local:1",
  ])
})

test("upload.end reports the put bound and sums overlapping put time", () => {
  const put = (index: number, putMs: number): SliceTransferStat => ({
    index, bytes: 380_000, readMs: 0, hashMs: 0, presignMs: 40, putMs, completeMs: 100, via: "put",
  })
  const fields = uploadEndFields([0, 1, 2, 3, 4, 5, 6].map((index) => put(index, 1000)))
  assert.equal(fields?.slices, 7)
  assert.equal(fields?.bytes, 380_000 * 7)
  assert.equal(fields?.presignMs, 280)
  assert.equal(fields?.putMs, 7000)
  assert.equal(fields?.completeMs, 700)
  assert.equal(fields?.concurrency, 6)
  const cached = uploadEndFields([
    { index: 0, bytes: 10, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0, via: "ready" },
  ])
  assert.equal(cached?.concurrency, undefined)
  assert.equal(cached?.putMs, 0)
})

test("a signed or trusted checksum is appended and absent checksums leave the line unchanged", () => {
  const lines = capture(() => {
    logUploadRow({
      rowId: "row-3",
      startedAt: 0,
      endedAt: 1000,
      bindMs: 1,
      slices: [
        { index: 0, bytes: 10, readMs: 0, hashMs: 0, presignMs: 1, putMs: 2, completeMs: 3, via: "put", checksum: "trusted" },
        { index: 1, bytes: 10, readMs: 0, hashMs: 0, presignMs: 1, putMs: 2, completeMs: 3, via: "put", checksum: "signed" },
      ],
    })
  })
  assert.match(lines[0]!, /via=put:2 checksum=trusted:1,signed:1$/)
  assert.match(lines[1]!, /parts=0:10:-:0:0:1:2:3:put:trusted 1:10:-:0:0:1:2:3:put:signed$/)
})

test("cache hits omit encode time and report zero throughput", () => {
  const lines = capture(() => {
    logUploadRow({
      rowId: "row-2",
      startedAt: 10,
      endedAt: 10,
      bindMs: 4,
      slices: [{ index: 0, bytes: 800, readMs: 0, hashMs: 0, presignMs: 1, putMs: 0, completeMs: 0, via: "ready" }],
    })
  })
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /manifestBytes=800 putBytes=0 /)
  assert.equal(lines[0]!.includes("encodeMs="), false)
  assert.match(lines[0]!, /putMs=0 completeMs=0 bindMs=4 wallMs=0 MBps=0 via=ready:1$/)
  assert.match(lines[1]!, /parts=0:800:-:0:0:1:0:0:ready$/)
})

test("a later probe does not erase a put, and a local hit can become a probe", () => {
  const put: SliceTransferStat = {
    index: 0, bytes: 100, encodeMs: 5, readMs: 1, hashMs: 1, presignMs: 2, putMs: 40, completeMs: 8, via: "put",
  }
  addTransfer(put, { via: "probe", timing: { bytes: 100, readMs: 0, hashMs: 0, presignMs: 3, putMs: 0, completeMs: 0 } })
  assert.equal(put.via, "put")
  assert.equal(put.putMs, 40)
  assert.equal(put.presignMs, 5)

  const local: SliceTransferStat = {
    index: 1, bytes: 100, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0, via: "local",
  }
  addTransfer(local, { via: "probe", timing: { bytes: 100, readMs: 0, hashMs: 0, presignMs: 7, putMs: 0, completeMs: 4 } })
  assert.equal(local.via, "probe")
  assert.equal(local.presignMs, 7)
  assert.equal(local.completeMs, 4)
  assert.equal(local.putMs, 0)
})
