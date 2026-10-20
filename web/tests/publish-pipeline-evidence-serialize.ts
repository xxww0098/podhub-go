import type { PipelineEvidence } from "./publish-pipeline-metrics"

export const EVIDENCE_PREVIEW_PAGE_SIZE = 8192
export type SerializedEvidence = { json: string; pages: readonly string[]; offsets: readonly number[]; blob: Blob }
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const high = (code: number) => code >= 0xD800 && code <= 0xDBFF
const low = (code: number) => code >= 0xDC00 && code <= 0xDFFF

// Native escaping/number formatting, with bounded strings. Do not split a pair:
// JSON.stringify would otherwise escape its two halves as lone surrogates.
function* quoted(value: string): Generator<string> {
  yield '"'
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + EVIDENCE_PREVIEW_PAGE_SIZE, value.length)
    if (end < value.length && high(value.charCodeAt(end - 1)) && low(value.charCodeAt(end))) end--
    yield JSON.stringify(value.slice(start, end)).slice(1, -1)
    start = end
  }
  yield '"'
}

/** The recorder's plain JSON graph; key order and undefined rules match stringify. */
function* tokens(value: unknown, shared: Set<object>, ancestors = new Set<object>(), cache = new WeakMap<object, string>()): Generator<string> {
  if (typeof value === "string") { yield* quoted(value); return }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new TypeError("Evidence JSON cannot encode bigint")
    yield JSON.stringify(value) ?? "null"
    return
  }
  if (ancestors.has(value)) throw new TypeError("Evidence JSON cannot encode cycles")
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Evidence JSON requires plain objects and arrays")
  }
  const cached = cache.get(value)
  if (cached !== undefined) { yield cached; return }
  // Pagination windows share frozen row captures. Encode a small shared graph
  // once per export, then emit its FULL JSON again at every occurrence. No wire
  // references or omitted before/after values; large histories are never joined.
  let parts: string[] | undefined = shared.has(value) && Object.isFrozen(value) ? [] : undefined, size = 0
  function remember(token: string) {
    if (parts) {
      size += token.length
      if (size <= 32 * EVIDENCE_PREVIEW_PAGE_SIZE) parts.push(token)
      else parts = undefined
    }
    return token
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    yield remember("[")
    for (let index = 0; index < value.length; index++) {
      if (index) yield remember(",")
      for (const token of tokens(value[index], shared, ancestors, cache)) yield remember(token)
    }
    yield remember("]")
  } else {
    yield remember("{")
    let comma = false
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue
      if (comma) yield remember(",")
      comma = true
      for (const token of quoted(key)) yield remember(token)
      yield remember(":")
      for (const token of tokens(item, shared, ancestors, cache)) yield remember(token)
    }
    yield remember("}")
  }
  ancestors.delete(value)
  if (parts) cache.set(value, parts.join(""))
}

/** Capture is already immutable before the first yield. All JSON remains inline.
 * Pages and bounded Blob parts avoid flattening/encoding the complete history in
 * one task. The full string is a concatenation of those same frozen pages; DOM
 * navigation reads a page directly, without flattening that large string again.
 */
export async function serializeEvidence(snapshot: PipelineEvidence, yieldTask: () => Promise<void> = yieldToBrowser): Promise<SerializedEvidence> {
  await yieldTask()
  const references = new Map<object, number>()
  const count = (value: unknown) => { if (value && typeof value === "object") references.set(value, (references.get(value) ?? 0) + 1) }
  count(snapshot.state)
  for (const action of snapshot.actions ?? []) { count(action.before); count(action.after) }
  const shared = new Set([...references].filter(([, count]) => count > 1).map(([value]) => value))
  const pages: string[] = [], offsets = [0], blobs: Blob[] = []
  let page = "", json = "", blobStart = 0, sliceStart = performance.now(), work = 0
  function flushPage() {
    if (!page) return
    pages.push(page); offsets.push(offsets[offsets.length - 1]! + page.length)
    json += page; page = ""
  }
  async function pause() {
    if (pages.length > blobStart) { blobs.push(new Blob(pages.slice(blobStart), { type: "application/json" })); blobStart = pages.length }
    await yieldTask(); sliceStart = performance.now()
  }
  for (const token of tokens(snapshot, shared)) {
    for (let start = 0; start < token.length;) {
      let end = Math.min(start + EVIDENCE_PREVIEW_PAGE_SIZE - page.length, token.length)
      if (end < token.length && high(token.charCodeAt(end - 1)) && low(token.charCodeAt(end))) end--
      // One remaining code unit cannot hold this pair: close the shorter page.
      if (end === start) { flushPage(); continue }
      page += token.slice(start, end); start = end
      if (page.length === EVIDENCE_PREVIEW_PAGE_SIZE || start < token.length) flushPage()
      if (pages.length - blobStart >= 32 || performance.now() - sliceStart >= 4) await pause()
    }
    if (++work >= 512) {
      work = 0
      if (performance.now() - sliceStart >= 4) await pause()
    }
  }
  flushPage()
  if (pages.length > blobStart) blobs.push(new Blob(pages.slice(blobStart), { type: "application/json" }))
  await yieldTask()
  return Object.freeze({ json, pages: Object.freeze(pages), offsets: Object.freeze(offsets), blob: new Blob(blobs, { type: "application/json" }) })
}
