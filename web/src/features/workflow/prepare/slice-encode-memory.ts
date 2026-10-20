/**
 * JPEG encode durations from slices rendered in this tab, keyed by content
 * hash. Upload happens after the bytes are already stored, so the upload log
 * can only attribute encode time when this session produced the slice.
 */

const encodeMsByHash = new Map<string, number>()

export function rememberSliceEncode(contentHash: string, encodeMs: number): void {
  if (!contentHash || !Number.isFinite(encodeMs) || encodeMs <= 0) return
  encodeMsByHash.set(contentHash, Math.round(encodeMs))
}

export function lookupSliceEncode(contentHash: string): number | undefined {
  return encodeMsByHash.get(contentHash)
}
