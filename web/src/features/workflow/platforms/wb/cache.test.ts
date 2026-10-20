import assert from "node:assert/strict"
import test from "node:test"
import { createWbCache } from "./cache"
import { wbCatalogFixture, wbConfigFixture } from "../../../../../tests/publish-pipeline-fixtures"
import { goldenSchema, wasmCore } from "../../submit/send-test-support"
import { createSchemaCache } from "../../schema-cache"

const coordinate = { subjectId: 105, language: "ru" as const }
const scope = { accountId: "a", workspaceUuid: "w", sessionFence: "f1" }

test("WB explicit open + refresh are the only two C reads; cache miss, build, expiry and idle do not fetch", async () => {
  const core = await wasmCore()
  let reads = 0, now = wbCatalogFixture.catalog!.expires_at_ms
  const cache = createWbCache({ core, scope, current: () => true, now: () => now,
    read: async () => { reads++; return structuredClone(wbCatalogFixture) } })
  assert.equal(cache.get(coordinate), undefined)
  assert.throws(() => cache.requireHandle(coordinate), /explicitly open/)
  assert.equal(reads, 0)
  await Promise.all([cache.open(coordinate), cache.open(coordinate)])
  assert.equal(reads, 1)
  const first = cache.requireHandle(coordinate)
  assert.deepEqual(core.wbPreview(first, wbConfigFixture()).issues, [])
  now++
  assert.throws(() => cache.requireHandle(coordinate), /expired/)
  assert.equal(reads, 1, "inclusive Cloud boundary, no TS 72h arithmetic")
  now = NaN
  assert.throws(() => cache.requireHandle(coordinate), /invalid clock/)
  now = wbCatalogFixture.catalog!.expires_at_ms
  await cache.refresh(coordinate)
  assert.equal(reads, 2)
  await assert.rejects(cache.refresh(coordinate), /budget/)
  assert.throws(() => core.wbMetadataIssues(first), /retired/)
  await cache.close()
})

test("empty/unusable material preserves native reasons and never cold-fills Seller", async () => {
  const core = await wasmCore()
  const cache = createWbCache({ core, scope, current: () => true, read: async () => ({ ...wbCatalogFixture, catalog: null, defaults: null, usable: false }) })
  const result = await cache.open(coordinate)
  assert.equal(result.response.catalog, null)
  assert.equal(core.wbPreview(cache.requireHandle(coordinate), wbConfigFixture()).issues[0]!.key.code, "catalog_unavailable")
  await cache.close()
})

test("same integer coordinate never shares Ozon/WB material; defaults digest and account fence participate in identity", async () => {
  const core = await wasmCore()
  const ozon = createSchemaCache(core)
  const a = createWbCache({ core, scope, current: () => true, read: async () => structuredClone(wbCatalogFixture) })
  const b = createWbCache({ core, scope: { ...scope, accountId: "b", sessionFence: "f2" }, current: () => true, read: async () => structuredClone(wbCatalogFixture) })
  const native = await ozon.load({ platform: "ozon", coordinate: [105], language: "ru", materialDigest: "d", defaultsRevision: "3", sessionFence: "f1" }, { snapshot: goldenSchema })
  const first = await a.open(coordinate), second = await b.open(coordinate)
  assert.notEqual(native.handle, first.handle.handle)
  assert.notEqual(first.key, second.key)
  assert.notEqual(first.handle, second.handle)
  await a.close(); await b.close(); await ozon.close()
})

test("late coordinate reads cannot install materials after scope change or close", async () => {
  const core = await wasmCore()
  let current = true, resolve!: (value: typeof wbCatalogFixture) => void
  const cache = createWbCache({ core, scope, current: () => current, read: () => new Promise((done) => { resolve = done }) })
  const opening = cache.open(coordinate)
  current = false
  resolve(structuredClone(wbCatalogFixture))
  await assert.rejects(opening, /scope changed/)
  assert.equal(cache.get(coordinate), undefined)
  await cache.close()
})

test("explicit next-action restart reloads local WB material with no new C call and preserves read budget", async () => {
  const { ListingCoreClient } = await import("@/listing-core/client")
  const { readFileSync } = await import("node:fs")
  const core = new ListingCoreClient(readFileSync(new URL("../../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url)))
  let reads = 0
  const cache = createWbCache({ core, scope, current: () => true, read: async () => { reads++; return structuredClone(wbCatalogFixture) } })
  const first = await cache.open(coordinate)
  cache.invalidate()
  await core.restart()
  assert.equal(cache.get(coordinate), undefined)
  const second = await cache.open(coordinate)
  assert.notEqual(first.handle, second.handle)
  assert.equal(reads, 1)
  await assert.rejects(core.wbPreview(first.handle, wbConfigFixture()), /retired/)
  assert.deepEqual((await core.wbPreview(second.handle, wbConfigFixture())).issues, [])
  await cache.refresh(coordinate)
  await assert.rejects(cache.refresh(coordinate), /budget/)
  assert.equal(reads, 2)
  await cache.close()
})
