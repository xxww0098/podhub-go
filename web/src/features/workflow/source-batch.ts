/**
 * One Listing Card is one source-image batch: one imported file is one row.
 */
export const MAX_SOURCE_BATCH = 1000

/**
 * Card-sized work is chunked to this so a 1000-row card cannot overflow one request.
 */
export const MUTATION_BATCH = 100

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("chunk size must be a positive integer")
  }
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("mapLimit concurrency must be a positive integer")
  }
  const results = Array.from<R>({ length: items.length })
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}
