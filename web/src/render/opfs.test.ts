import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { readFileSync } from "node:fs"
import { renderOpfs } from "../bindings/render-opfs"
import { stubOpfs, restoreOpfsTestGlobals } from "./opfs-test-support"

import {
  contentHash,
  sha256Hex,
  dropRender,
  getTemplate,
  openStaticSliceCache,
  putRender,
  putSource,
  putTemplate,
  renderProfile,
  writeStaticSlices,
} from "./opfs"
import { opfsUnavailableReason } from "./opfs-io"
import {
  clearCache,
  clearCacheFamily,
  flushUseLog,
  pinnedSourceUsage,
  setPinnedSources,
  sweep,
  usageByFamily,
  USE_LOG_KEY,
} from "./opfs-cache"

test("Window OPFS does not require createSyncAccessHandle", () => {
  assert.equal(
    opfsUnavailableReason(
      { getDirectory: async () => null },
      { prototype: { createWritable: async () => null } },
    ),
    null,
  )
})

test("an engine without createWritable is unsupported even if it has a sync handle", () => {
  const syncOnly = { prototype: { createSyncAccessHandle: async () => null } }
  assert.equal(
    opfsUnavailableReason({ getDirectory: async () => null }, syncOnly),
    "FileSystemFileHandle.createWritable",
  )
})

test("an engine without getDirectory is unsupported", () => {
  assert.equal(
    opfsUnavailableReason(undefined, { prototype: { createWritable: async () => null } }),
    "navigator.storage.getDirectory",
  )
})

/**
 * A minimal Window-thread OPFS: enough surface for the write, delete and walk
 * paths, plus a counter on `persist` so the test can see how often persistence
 * was claimed. `written` is the whole file system — a flat set of paths — so a
 * recursive `removeEntry` is a prefix match and `entries()` is the set of next
 * path segments. `sizes` lets a case put a big file on disk without writing
 * one. The use log the ceiling reads lives in localStorage, which node has no
 * global for, so it is stubbed too.
 */
afterEach(restoreOpfsTestGlobals)

const GIB = 1024 ** 3


function useLog(store: Map<string, string>): Record<string, { at: number, size: number }> {
  // The log's truth is in memory; the mirror a test reads is debounced.
  flushUseLog()
  return JSON.parse(store.get(USE_LOG_KEY) ?? "{}")
}

const SLICE = {
  groupName: "主图",
  index: 0,
  fileName: "slice-1.jpg",
  width: 900,
  height: 1200,
  contentHash: "sha256:one",
  bytes: new Uint8Array([1, 2, 3, 4]),
}

test("an OPFS write claims persistence, and claims it once for the tab", async () => {
  const { written, persistCount } = stubOpfs()

  const digest = await putTemplate(new Uint8Array([1, 2, 3]))
  await putSource(new Uint8Array([4, 5]), "design.jpg")

  assert.ok(written.has(`templates/${digest}.psd`))
  assert.equal(written.size, 2)
  assert.equal(
    persistCount(),
    1,
    "an unpersisted OPFS is evictable, and a 254 MiB template does not survive eviction",
  )
})

test("an older render cannot overwrite or delete a newer artifact", async () => {
  const { written, contents } = stubOpfs()
  const newer = { ...SLICE, bytes: new Uint8Array([9, 8, 7]) }
  assert.equal(await putRender("row-1", [newer], { v: 2 }, { jobId: "job-new", generation: 20 }), true)
  assert.equal(await putRender("row-1", [SLICE], { v: 1 }, { jobId: "job-old", generation: 10 }), false)
  const image = [...written].find(path => path.endsWith("/slice-1.jpg"))!
  assert.deepEqual(contents.get(image), newer.bytes)
  await dropRender("row-1", { jobId: "job-old", generation: 10 })
  assert.ok(written.has(image), "a stale job must not delete a newer owner's slices")
  await dropRender("row-1", { jobId: "job-new" })
  assert.equal(written.has(image), false)
})

test("a delivered render leaves nothing behind on the device", async () => {
  const { written, store } = stubOpfs()

  await putRender("row-1", [SLICE], { staticGroups: 0 })
  assert.ok(written.has("renders/row-1/slice-1.jpg"))
  assert.ok(written.has("renders/row-1/manifest.json"))
  assert.ok(useLog(store)["renders/row-1"])

  await dropRender("row-1")

  assert.deepEqual(
    [...written].filter((path) => path.startsWith("renders/")),
    [],
    "a slice that reached the Public Media URL is dead weight (listing-design.md §3.1.1)",
  )
  assert.equal(useLog(store)["renders/row-1"], undefined)
})

test("the ceiling evicts least-recently-used first and stops once under it", async () => {
  // Sizes come from the disk the sweep surveys; the log only carries the order.
  const { written, store, sizes } = stubOpfs()
  written.add("templates/cold.psd")
  written.add("templates/warm.psd")
  sizes.set("templates/cold.psd", 3 * GIB)
  sizes.set("templates/warm.psd", 2 * GIB)
  store.set(
    USE_LOG_KEY,
    JSON.stringify({
      "templates/cold.psd": { at: 1, size: 3 * GIB },
      "templates/warm.psd": { at: 2, size: 2 * GIB },
    }),
  )

  // The write pushes the logged total over the ceiling, which is what starts
  // the sweep; `sweep()` joins the one already in flight.
  await putSource(new Uint8Array([9, 9]), "design.jpg")
  await sweep()

  assert.equal(written.has("templates/cold.psd"), false, "the oldest entry pays first")
  assert.ok(written.has("templates/warm.psd"), "eviction stops at the ceiling, it is not a purge")
  const log = useLog(store)
  assert.equal(log["templates/cold.psd"], undefined)
  assert.ok(log["templates/warm.psd"])
  assert.equal(Object.keys(log).length, 2, "the source just written is still logged")
})

test("a pinned source survives eviction even when it alone is over the ceiling", async () => {
  const { written, store, sizes } = stubOpfs()
  const digest = await putSource(new Uint8Array([1, 2, 3]), "design.jpg")
  setPinnedSources(async () => new Set([digest]))
  sizes.set(`sources/${digest}/design.jpg`, 5 * GIB)

  await sweep()

  assert.ok(
    written.has(`sources/${digest}/design.jpg`),
    "a source a local row still references is its only copy (README D3) and must never be evicted",
  )
  assert.ok(
    useLog(store)[`sources/${digest}`],
    "a pinned entry stays logged — it is still real bytes occupying the device",
  )
})

test("an unpinned source next to a pinned one still evicts normally", async () => {
  const { written, sizes } = stubOpfs()
  const pinned = await putSource(new Uint8Array([1]), "kept.jpg")
  const unpinned = await putSource(new Uint8Array([2]), "gone.jpg")
  setPinnedSources(async () => new Set([pinned]))
  sizes.set(`sources/${pinned}/kept.jpg`, 3 * GIB)
  sizes.set(`sources/${unpinned}/gone.jpg`, 3 * GIB)

  await sweep()

  assert.ok(written.has(`sources/${pinned}/kept.jpg`), "pinning is per-digest, not a blanket exemption for the family")
  assert.equal(
    written.has(`sources/${unpinned}/gone.jpg`),
    false,
    "an unpinned source pays the ceiling exactly as before this slice",
  )
})

test("清理本机缓存 drops every family and the log with them", async () => {
  const { written, store } = stubOpfs()

  await putTemplate(new Uint8Array([1]))
  await putSource(new Uint8Array([2]), "design.jpg")
  await putRender("row-1", [SLICE], { staticGroups: 0 })
  assert.ok(written.size > 0)

  await clearCache()

  assert.deepEqual([...written], [])
  assert.deepEqual(useLog(store), {})
})

test("清理本机缓存 keeps a pinned source while dropping unpinned sources and every other family", async () => {
  const { written, store } = stubOpfs()
  const pinned = await putSource(new Uint8Array([1]), "kept.jpg")
  const unpinned = await putSource(new Uint8Array([2]), "gone.jpg")
  await putTemplate(new Uint8Array([3]))
  await putRender("row-1", [SLICE], { staticGroups: 0 })
  setPinnedSources(async () => new Set([pinned]))

  await clearCache()

  assert.deepEqual(
    [...written],
    [`sources/${pinned}/kept.jpg`],
    "a pinned in-制品 source stays; templates, renders and the unpinned source are gone",
  )
  const log = useLog(store)
  assert.ok(log[`sources/${pinned}`], "the surviving source stays logged, not silently untracked")
  assert.equal(log[`sources/${unpinned}`], undefined)
  assert.equal(Object.keys(log).length, 1)
})

test("清理本机缓存 without a pinned provider behaves exactly as before this slice", async () => {
  // The default provider (no rows wired up yet) must not change today's
  // drop-everything behaviour — this is the "0 pinned" state slice 17 inherits.
  const { written } = stubOpfs()
  await putSource(new Uint8Array([1]), "design.jpg")
  await putTemplate(new Uint8Array([2]))

  await clearCache()

  assert.deepEqual([...written], [])
})

test("the first sweep of a tab surveys OPFS, so bytes the log never saw still evict", async () => {
  // The state every existing device is in when this ships, and the state a
  // cleared or half-written localStorage leaves behind: real bytes, empty log.
  const { written, store, sizes } = stubOpfs()
  written.add("templates/already-here.psd")
  sizes.set("templates/already-here.psd", 5 * GIB)
  assert.deepEqual(useLog(store), {})

  await putSource(new Uint8Array([1]), "design.jpg")
  await sweep()

  assert.equal(
    written.has("templates/already-here.psd"),
    false,
    "a log that cannot see the cache is a ceiling that never trips",
  )
  assert.ok(useLog(store)["sources/"] === undefined)
  assert.equal(Object.keys(useLog(store)).length, 1, "only the surviving source stays logged")
})

test("a static cache hit reads one manifest and touches the use log once per row", async () => {
  const fs = stubOpfs()
  const fingerprint = "sha256:template"
  const profile = renderProfile()
  const slices = await Promise.all([2, 5].map(async (index) => {
    const bytes = new Uint8Array([index, index + 1])
    return { ...SLICE, index, groupName: `group ${index}`, bytes, contentHash: await contentHash(bytes) }
  }))
  await writeStaticSlices(fingerprint, profile, slices)
  await sweep()
  fs.fileReads.length = 0
  const beforeWrites = fs.storageWrites()

  const cache = await openStaticSliceCache(fingerprint, profile)
  assert.ok(cache)
  const hits = await cache.read(slices)

  assert.deepEqual(hits.map(hit => [hit?.groupIndex, hit?.groupName, hit?.contentHash, hit?.bytes]),
    slices.map(slice => [slice.index, slice.groupName, slice.contentHash, slice.bytes]))
  assert.equal(fs.fileReads.filter(path => path.endsWith("/manifest.json")).length, 1,
    "a row must not reread its manifest separately for each static slice")
  flushUseLog()
  assert.equal(fs.storageWrites() - beforeWrites, 1,
    "a row touches its static cache entry once, regardless of static group count")
})

test("a pre-wave0 static-slice manifest (schema v2) is a miss under schema v3", async () => {
  // Wave-0 structural reject changes what pixels may have been cached; B7
  // bumps STATIC_SLICE_CACHE_VERSION so old OPFS slices cannot be reused.
  const fs = stubOpfs()
  const fingerprint = "sha256:template"
  const profile = renderProfile()
  assert.ok(profile.startsWith("v3:"), `profile must encode schema v3: ${profile}`)
  const slice = { ...SLICE, contentHash: await contentHash(SLICE.bytes) }
  await writeStaticSlices(fingerprint, profile, [slice])
  const manifestPath = [...fs.written].find(path => path.endsWith("/manifest.json"))!
  const manifest = JSON.parse(new TextDecoder().decode(fs.contents.get(manifestPath)))
  assert.equal(manifest.version, 3)
  manifest.version = 2
  fs.contents.set(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)))

  assert.equal(await openStaticSliceCache(fingerprint, profile), null)
})

// Each case starts from a manifest this writer just produced and keeps its
// version, fingerprint and profile intact, so the schema check cannot be what
// rejects it: only the shape check added here can.
for (const [label, corrupt] of [
  ["zero bytes", () => new Uint8Array(0)],
  ["torn bytes", () => new Uint8Array([0x7b, 0x22])],
  ["a JSON null root", () => new TextEncoder().encode("null")],
  ["a manifest without a slices list", (valid: Record<string, unknown>) => {
    delete valid.slices
    return new TextEncoder().encode(JSON.stringify(valid))
  }],
  ["a slices list that is only array-like", (valid: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ ...valid, slices: { length: 1, 0: (valid.slices as unknown[])[0] } }))],
  ["a slices entry that is not an object", (valid: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ ...valid, slices: [null] }))],
] as const) {
  test(`a static manifest holding ${label} is a miss, never an exception`, async () => {
    const fs = stubOpfs()
    const fingerprint = "sha256:template"
    const profile = renderProfile()
    const slice = { ...SLICE, contentHash: await contentHash(SLICE.bytes) }
    await writeStaticSlices(fingerprint, profile, [slice])
    const manifestPath = [...fs.written].find(path => path.endsWith("/manifest.json"))!
    const valid = JSON.parse(new TextDecoder().decode(fs.contents.get(manifestPath)!))
    fs.contents.set(manifestPath, corrupt(valid))

    assert.equal(await openStaticSliceCache(fingerprint, profile), null,
      "an unreadable cache costs a full render, not the row")
  })
}

test("the write after an unreadable static manifest repairs it", async () => {
  const fs = stubOpfs()
  const fingerprint = "sha256:template"
  const profile = renderProfile()
  await writeStaticSlices(fingerprint, profile, [{ ...SLICE, contentHash: await contentHash(SLICE.bytes) }])
  const manifestPath = [...fs.written].find(path => path.endsWith("/manifest.json"))!
  fs.contents.set(manifestPath, new Uint8Array([0x7b]))

  const bytes = new Uint8Array([5, 6, 7])
  const replacement = { ...SLICE, index: 1, groupName: "详情", fileName: "slice-2.jpg", bytes,
    contentHash: await contentHash(bytes) }
  await writeStaticSlices(fingerprint, profile, [replacement])

  const cache = await openStaticSliceCache(fingerprint, profile)
  assert.ok(cache, "the next write must replace the manifest it could not read")
  assert.deepEqual((await cache.read([replacement]))[0]?.bytes, bytes)
  const repaired = JSON.parse(new TextDecoder().decode(fs.contents.get(manifestPath)!))
  assert.deepEqual(repaired.slices.map((entry: { groupIndex: number }) => entry.groupIndex), [1],
    "entries of an unreadable manifest cannot be carried over")
})

test("a static cache reader validates only the requested groups and keeps their order", async () => {
  const fs = stubOpfs()
  const fingerprint = "sha256:template"
  const profile = renderProfile()
  const slices = await Promise.all([0, 1, 2].map(async (index) => {
    const bytes = new Uint8Array([index, 10 + index])
    return { ...SLICE, index, groupName: `group ${index}`, bytes, contentHash: await contentHash(bytes) }
  }))
  await writeStaticSlices(fingerprint, profile, slices)
  await sweep()
  const unneeded = [...fs.written].find(path => path.endsWith("/slice-2.jpg"))!
  fs.written.delete(unneeded)
  fs.fileReads.length = 0
  const cache = await openStaticSliceCache(fingerprint, profile)
  assert.ok(cache)

  const hits = await cache.read([slices[2]!, slices[0]!])

  assert.deepEqual(hits.map(hit => [hit?.groupIndex, hit?.bytes]),
    [[2, slices[2]!.bytes], [0, slices[0]!.bytes]])
  assert.ok(!fs.fileReads.includes(unneeded), "an unrelated old group must not cost a read or invalidate this row")
})

for (const invalid of ["missing", "truncated", "digest", "group name", "dimensions"] as const) {
  test(`a ${invalid} static slice stays a cache miss without a use-log write`, async () => {
    const fs = stubOpfs()
    const fingerprint = "sha256:template"
    const profile = renderProfile()
    const slice = { ...SLICE, contentHash: await contentHash(SLICE.bytes) }
    await writeStaticSlices(fingerprint, profile, [slice])
    await sweep()
    const imagePath = [...fs.written].find(path => path.endsWith("/slice-1.jpg"))!
    if (invalid === "missing") fs.written.delete(imagePath)
    if (invalid === "truncated") fs.contents.set(imagePath, new Uint8Array([1]))
    if (invalid === "digest") fs.contents.set(imagePath, new Uint8Array([4, 3, 2, 1]))
    if (invalid === "dimensions") {
      const manifestPath = [...fs.written].find(path => path.endsWith("/manifest.json"))!
      const manifest = JSON.parse(new TextDecoder().decode(fs.contents.get(manifestPath)))
      manifest.slices[0].width = 0
      fs.contents.set(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)))
    }
    const beforeWrites = fs.storageWrites()
    const cache = await openStaticSliceCache(fingerprint, profile)
    assert.ok(cache)

    const hits = await cache.read([{ ...slice, groupName: invalid === "group name" ? "different group" : slice.groupName }])

    assert.deepEqual(hits, [null], "invalid bytes or metadata must reach the executor's full-render recovery")
    flushUseLog()
    assert.equal(fs.storageWrites(), beforeWrites, "failed validation is not a cache use")
  })
}

test("the next row reads a newly published static manifest rather than retaining an old one", async () => {
  const fs = stubOpfs()
  const fingerprint = "sha256:template"
  const profile = renderProfile()
  assert.equal(await openStaticSliceCache(fingerprint, profile), null)
  let slice = { ...SLICE, contentHash: await contentHash(SLICE.bytes) }
  await writeStaticSlices(fingerprint, profile, [slice])
  const first = await openStaticSliceCache(fingerprint, profile)
  assert.ok(first)
  assert.deepEqual((await first.read([slice]))[0]?.bytes, slice.bytes)

  const bytes = new Uint8Array([8, 9, 10])
  slice = { ...slice, bytes, width: 100, contentHash: await contentHash(bytes) }
  await writeStaticSlices(fingerprint, profile, [slice])
  await sweep()
  fs.fileReads.length = 0
  const next = await openStaticSliceCache(fingerprint, profile)
  assert.ok(next)
  const [hit] = await next.read([slice])

  assert.deepEqual([hit?.bytes, hit?.width, hit?.contentHash], [bytes, 100, slice.contentHash])
  assert.equal(fs.fileReads.filter(path => path.endsWith("/manifest.json")).length, 1)
})

test("PNG source preview preserves cached bytes without labelling them JPEG", async () => {
  stubOpfs()
  const bytes = new Uint8Array(readFileSync(new URL("../../../fixtures/psd/synthetic/replacement-transparent-edges.png", import.meta.url)))
  const digest = await putSource(bytes, "design.PNG")
  const preview = await renderOpfs.workflowSourcePreview(`${digest}/design.PNG`)
  try {
    const blob = await (await fetch(preview.data_url)).blob()
    assert.notEqual(blob.type, "image/jpeg")
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
  } finally {
    URL.revokeObjectURL(preview.data_url)
  }
})

test("a quota refusal sweeps and retries the write once", async () => {
  const { written, contents } = stubOpfs({ quotaOnce: true })
  const bytes = new Uint8Array([7, 7, 7])
  const digest = await putSource(bytes, "design.jpg")
  assert.ok(
    written.has(`sources/${digest}/design.jpg`),
    "a device whose quota is under the ceiling still lands the write after a sweep",
  )
  assert.deepEqual(contents.get(`sources/${digest}/design.jpg`), bytes)
})

test("a use is debounced to the mirror; a flush writes it", async () => {
  const fs = stubOpfs()
  const digest = await putTemplate(new Uint8Array([1, 2, 3]))
  await sweep()
  flushUseLog()
  const settled = fs.storageWrites()

  assert.ok(await getTemplate(digest))
  assert.equal(fs.storageWrites(), settled, "a read-side touch updates memory, not the mirror")

  flushUseLog()
  assert.equal(fs.storageWrites(), settled + 1)
})

test("usageByFamily measures what is on disk, and clearing one family spares the rest", async () => {
  const { written } = stubOpfs()
  const template = await putTemplate(new Uint8Array([1, 2, 3]))
  await putSource(new Uint8Array([4, 5]), "design.jpg")
  await putRender("row-1", [SLICE], { v: 1 })

  const usage = Object.fromEntries((await usageByFamily()).map((row) => [row.family, row]))
  assert.deepEqual([usage["templates"]?.entries, usage["templates"]?.bytes], [1, 3])
  assert.deepEqual([usage["sources"]?.entries, usage["sources"]?.bytes], [1, 2])
  assert.equal(usage["renders"]?.entries, 1)
  assert.equal(usage["static-slices"]?.entries, 0)

  await clearCacheFamily("sources")
  assert.ok(written.has(`templates/${template}.psd`), "other families are spared")
  assert.equal([...written].filter((path) => path.startsWith("sources/")).length, 0)
  assert.ok(written.has("renders/row-1/slice-1.jpg"))
  const after = Object.fromEntries((await usageByFamily()).map((row) => [row.family, row]))
  assert.equal(after["sources"]?.bytes, 0, "the survey the panel prints is post-clear")
})

test("clearCacheFamily(\"sources\") is not a second, unpinned way to drop an in-制品 source", async () => {
  const { written } = stubOpfs()
  const pinned = await putSource(new Uint8Array([1]), "kept.jpg")
  const unpinned = await putSource(new Uint8Array([2]), "gone.jpg")
  setPinnedSources(async () => new Set([pinned]))

  await clearCacheFamily("sources")

  assert.ok(
    written.has(`sources/${pinned}/kept.jpg`),
    "the per-family 清理 button must honour pinning exactly like 清理本机缓存",
  )
  assert.equal(written.has(`sources/${unpinned}/gone.jpg`), false)
})

test("pinnedSourceUsage reports the pinned subset of sources, not the family's gross total", async () => {
  stubOpfs()
  const pinned = await putSource(new Uint8Array([1, 2, 3]), "kept.jpg")
  await putSource(new Uint8Array([4, 5]), "gone.jpg")

  assert.deepEqual(
    await pinnedSourceUsage(),
    { count: 0, bytes: 0 },
    "nothing is pinned until a provider says so",
  )

  setPinnedSources(async () => new Set([pinned]))
  assert.deepEqual(await pinnedSourceUsage(), { count: 1, bytes: 3 })
})

test("image digests cover the byte view, including shared backing storage", async () => {
  const expected = await sha256Hex(new Uint8Array([1, 2]))
  assert.equal(await sha256Hex(new Uint8Array([9, 1, 2, 8]).subarray(1, 3)), expected)
  const shared = new Uint8Array(new SharedArrayBuffer(4))
  shared.set([9, 1, 2, 8])
  assert.equal(await sha256Hex(shared.subarray(1, 3)), expected)
})
