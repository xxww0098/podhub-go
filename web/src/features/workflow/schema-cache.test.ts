import assert from "node:assert/strict"
import test from "node:test"
import { createSchemaCache, type SchemaIdentity } from "./schema-cache"
import { goldenSchema } from "./submit/send-test-support"

test("resident schema identity includes platform, native coordinate, language, digest, defaults and account fence", async () => {
  let loads = 0
  let drops = 0
  const cache = createSchemaCache({ loadSchema: () => ++loads, dropSchema: () => { drops++ } })
  const identity: SchemaIdentity = { platform: "third", coordinate: [1, 2], language: "ru", materialDigest: "hash", defaultsRevision: "1", sessionFence: "account-1" }
  assert.equal(cache.get(identity), undefined)
  const first = await cache.load(identity, { snapshot: goldenSchema })
  assert.equal((await cache.load(identity, { snapshot: goldenSchema })).handle, first.handle)
  for (const patch of [{ platform: "other" }, { coordinate: [2, 1] }, { language: "en" }, { materialDigest: "next" }, { defaultsRevision: "2" }, { sessionFence: "account-2" }]) assert.equal(cache.get({ ...identity, ...patch }), undefined)
  assert.equal(loads, 1)
  cache.invalidate()
  assert.equal(cache.get(identity), undefined)
  assert.equal(drops, 0, "trap invalidation must not call the retired instance")
})
