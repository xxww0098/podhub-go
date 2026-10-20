import type { PreparedRow } from "./types"
export const MAX_BLOCK_ROWS = 100
export const MAX_BLOCK_BYTES = 7.5 * 1024 * 1024

/** Full envelope UTF-8 bytes, including delimiters; oversize single rows never dispatch. */
export function splitPreparedRows(items: readonly PreparedRow[], bytes: (items: readonly PreparedRow[]) => number) {
  const chunks: PreparedRow[][] = []
  const oversized: string[] = []
  let current: PreparedRow[] = []
  // ponytail: exact envelope recount is quadratic within at most 100 rows;
  // move byte counting off-thread if the browser long-task gate exceeds 50 ms.
  for (const item of items) {
    if (bytes([item]) > MAX_BLOCK_BYTES) { oversized.push(item.rowId); continue }
    const candidate = [...current, item]
    if (current.length > 0 && (candidate.length > MAX_BLOCK_ROWS || bytes(candidate) > MAX_BLOCK_BYTES)) {
      chunks.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length > 0) chunks.push(current)
  return { chunks, oversized }
}
