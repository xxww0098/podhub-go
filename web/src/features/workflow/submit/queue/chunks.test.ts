import assert from "node:assert/strict"
import test from "node:test"
import { MAX_BLOCK_BYTES, splitPreparedRows } from "./chunks"
import type { PreparedRow } from "./types"
const row = (id: number, body: unknown = {}): PreparedRow => ({ rowId: String(id), revision: 1, offerId: String(id), digest: "d", previewOperationId: "p", body })

test("100 rows and inclusive 7.5MiB full UTF-8 envelope; oversized singles never dispatch", () => {
  assert.deepEqual(splitPreparedRows(Array.from({ length: 201 }, (_, i) => row(i)), () => 1).chunks.map((chunk) => chunk.length), [100, 100, 1])
  const bytes = (items: readonly PreparedRow[]) => new TextEncoder().encode(JSON.stringify({ items: items.map((item) => item.body) })).length
  const overhead = bytes([row(1, "")])
  const exact = row(1, "x".repeat(MAX_BLOCK_BYTES - overhead))
  assert.equal(bytes([exact]), MAX_BLOCK_BYTES)
  const result = splitPreparedRows([exact, row(2, "俄".repeat(MAX_BLOCK_BYTES / 2)), row(3)], bytes)
  assert.deepEqual(result.oversized, ["2"])
  assert.deepEqual(result.chunks.map((chunk) => chunk.map((item) => item.rowId)), [["1"], ["3"]])
})
