/**
 * Displayed upload speed. A sliding window averages bytes, then a blend keeps
 * one finished part from jumping the number the operator is reading.
 */

export type RateSample = { at: number; bytes: number }

export const RATE_WINDOW_MS = 8_000
export const RATE_MIN_SPAN_MS = 1_000
const BLEND = 0.3

export function slidingRate(
  samples: readonly RateSample[],
  now: number,
  previous: number,
  windowMs = RATE_WINDOW_MS,
  minSpanMs = RATE_MIN_SPAN_MS,
): { rate: number; samples: RateSample[] } {
  const kept = samples.filter((sample) => now - sample.at <= windowMs && sample.at <= now)
  const first = kept[0]
  const last = kept[kept.length - 1]
  if (!first || !last || last.at - first.at < minSpanMs) {
    return { rate: kept.length === 0 ? 0 : Math.max(0, previous), samples: kept }
  }
  const instant = Math.max(0, (last.bytes - first.bytes) / ((last.at - first.at) / 1000))
  const rate = previous > 0 ? previous * (1 - BLEND) + instant * BLEND : instant
  return { rate, samples: kept }
}

export function etaSeconds(remainingBytes: number, bytesPerSec: number): number {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return 0
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return Number.POSITIVE_INFINITY
  return remainingBytes / bytesPerSec
}
