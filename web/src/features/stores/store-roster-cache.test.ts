import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { OzonStoresOverview, OzonStoreView } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import {
  activeCloudStoreUid,
  cloudConfiguredStores,
  forgetStoreRoster,
  invalidateStoreRoster,
  isStoreKeyExpired,
  isStoreRosterCacheFresh,
  loadStoreRoster,
  peekStoreRoster,
  rememberStoreRoster,
  rosterHasUnavailableStores,
  storeRosterCacheKey,
  subscribeStoreRoster,
  STORE_ROSTER_TTL_MS,
  type StoreRosterCacheEntry,
} from "./store-roster-cache"

const cloudStore = {
  id: "local-copy",
  label: "主店",
  client_id: "248917",
  watermark_name: "",
  advertising_client_id: "",
  advertising_configured: false,
  configured: true,
  secret_status: "absent",
  ref_id: "store:cloud-1",
  updated_at_ms: 0,
  verified_at_ms: null,
  last_used_at_ms: null,
  key_expires_at_ms: null,
  active: false,
  cloud_store_uuid: "cloud-1",
  create_order: 1,
  cloud_status: "active",
  manual_disabled: false,
  quota_suspended: false,
  cloud_revision: 1,
  credential_revision: 1,
  needs_reentry: true,
  can_manage: true,
    can_edit_credential: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
} satisfies OzonStoreView

const overview = {
  stores: [],
  active_id: null,
  store_limit: null,
  stores_used: null,
  suspended: null,
} satisfies OzonStoresOverview

const entry: StoreRosterCacheEntry = {
  cachedAt: 10_000,
  overview,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("store roster cache is isolated by Workspace", () => {
  assert.equal(storeRosterCacheKey(), undefined)
  assert.equal(storeRosterCacheKey(42), "42")
  assert.equal(storeRosterCacheKey(43), "43")
})

test("remember without a Workspace does not write a shared session cache", () => {
  invalidateStoreRoster()
  rememberStoreRoster(overview)
  assert.equal(peekStoreRoster(), undefined)
  assert.equal(peekStoreRoster(7), undefined)
})

test("ops reads use only active Cloud stores even when this device needs re-entry", () => {
  assert.equal(activeCloudStoreUid(cloudStore), "cloud-1")
  assert.equal(activeCloudStoreUid({ ...cloudStore, cloud_store_uuid: null }), undefined)
  assert.equal(activeCloudStoreUid({ ...cloudStore, cloud_status: "manual_disabled" }), undefined)
  assert.equal(activeCloudStoreUid({ ...cloudStore, configured: false }), undefined)
  const configured = cloudConfiguredStores({
    ...overview,
    stores: [cloudStore, { ...cloudStore, id: "disabled", cloud_status: "quota_suspended" }],
  })
  assert.equal(configured.length, 1)
  assert.equal(configured[0]?.id, "cloud-1")
  assert.equal(
    rosterHasUnavailableStores({
      ...overview,
      stores: [{ ...cloudStore, cloud_status: "quota_suspended" }],
    }),
    true,
  )
})

test("a lapsed Seller key leaves the Store listed but unusable", () => {
  // Relative to the wall clock: `cloudConfiguredStores` reads the real one.
  const now = Date.now()
  const expired = { ...cloudStore, key_expires_at_ms: now - 1 }
  const future = { ...cloudStore, key_expires_at_ms: now + 60_000 }
  const legacy = { ...cloudStore, key_expires_at_ms: null }

  assert.equal(isStoreKeyExpired(expired, now), true)
  assert.equal(isStoreKeyExpired(future, now), false)
  assert.equal(isStoreKeyExpired(legacy, now), false)
  assert.equal(isStoreKeyExpired({ ...cloudStore }, now), false)
  assert.equal(activeCloudStoreUid(expired, now), undefined)
  // The boundary is Cloud's: exactly now already counts as expired.
  assert.equal(
    activeCloudStoreUid({ ...cloudStore, key_expires_at_ms: now }, now),
    undefined,
  )
  assert.equal(activeCloudStoreUid(future, now), "cloud-1")
  assert.equal(activeCloudStoreUid(legacy, now), "cloud-1")

  // The roster still paints the Store; only the executable projection drops it.
  const configured = cloudConfiguredStores({
    ...overview,
    stores: [future, expired],
  })
  assert.equal(configured.length, 1)
  assert.equal(configured[0]?.id, "cloud-1")

  assert.equal(
    rosterHasUnavailableStores({ ...overview, stores: [expired] }, now),
    true,
  )
  assert.equal(
    rosterHasUnavailableStores({ ...overview, stores: [future, legacy] }, now),
    false,
  )
})

test("store roster cache stays fresh for the short switching window", () => {
  assert.equal(
    isStoreRosterCacheFresh(entry, entry.cachedAt + STORE_ROSTER_TTL_MS - 1),
    true,
  )
  assert.equal(
    isStoreRosterCacheFresh(entry, entry.cachedAt + STORE_ROSTER_TTL_MS),
    false,
  )
})

test("load without a Workspace fetches and does not cache", async (t) => {
  invalidateStoreRoster()
  const original = integrationsHttp.integrationsListOzonStores
  integrationsHttp.integrationsListOzonStores = async () => overview
  t.after(() => {
    integrationsHttp.integrationsListOzonStores = original
    invalidateStoreRoster()
  })
  const loaded = await loadStoreRoster()
  assert.equal(loaded, overview)
  assert.equal(peekStoreRoster(), undefined)
  assert.equal(peekStoreRoster(7), undefined)
})

test("remembered roster is visible until invalidate", () => {
  rememberStoreRoster(overview, 7, 20_000)
  assert.equal(peekStoreRoster(7)?.overview, overview)
  assert.equal(peekStoreRoster(8), undefined)
  invalidateStoreRoster()
  assert.equal(peekStoreRoster(7), undefined)
})

test("remembering the roster notifies every subscriber", () => {
  invalidateStoreRoster()
  const seen: Array<string | null> = []
  const stop = subscribeStoreRoster(() => {
    seen.push(peekStoreRoster(7)?.overview.active_id ?? null)
  })
  rememberStoreRoster({ ...overview, active_id: "a" }, 7)
  rememberStoreRoster({ ...overview, active_id: "b" }, 7)
  forgetStoreRoster(7)
  stop()
  assert.deepEqual(seen, ["a", "b", null])
})

test("上架 and 店铺 subscribe to the same roster snapshot", () => {
  const cache = readFileSync(new URL("./store-roster-cache.ts", import.meta.url), "utf8")
  const sessionCache = readFileSync(
    new URL("../../lib/session-cache.ts", import.meta.url),
    "utf8",
  )
  const stores = readFileSync(new URL("./stores-screen.tsx", import.meta.url), "utf8")
  const workflow = readFileSync(
    new URL("../workflow/workflow-screen.tsx", import.meta.url),
    "utf8",
  )
  const state = readFileSync(new URL("../workflow/workflow-screen-state.ts", import.meta.url), "utf8")
  const library = readFileSync(new URL("../workflow/workflow-screen-library.ts", import.meta.url), "utf8")
  assert.match(sessionCache, /from "zustand"/)
  assert.match(cache, /createSessionCache/)
  assert.match(stores, /useStoreRoster/)
  assert.match(workflow, /import \{ useWorkflowScreenState, TEMPLATE_NOTICE_ID \} from "\.\/workflow-screen-state"/)
  assert.match(workflow, /const state = useWorkflowScreenState\(initialSchema, workspaceId, active\)/)
  const stateStart = state.indexOf("export function useWorkflowScreenState")
  const stateEnd = state.indexOf("export type WorkflowScreenState", stateStart)
  assert.ok(stateStart >= 0 && stateEnd > stateStart)
  assert.match(state.slice(stateStart, stateEnd), /useStoreRoster\(workspaceId\)\?\.overview\.stores/)
  assert.match(workflow, /import \{ useWorkflowScreenLibrary \} from "\.\/workflow-screen-library"/)
  assert.match(workflow, /const \{ refreshSavedForms, reloadOzonStores, openRunner \} = useWorkflowScreenLibrary\(\{\s*state, workspaceId/)
  assert.match(library, /export function useWorkflowScreenLibrary/)
  const reloadStart = library.indexOf("async function reloadOzonStores")
  const reloadEnd = library.indexOf("async function openRunner", reloadStart)
  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart)
  const reload = library.slice(reloadStart, reloadEnd)
  assert.match(reload, /loadStoreRoster\(\{ workspaceId, force: !options\?\.soft \}\)/)
  assert.match(reload, /if \(!options\?\.soft\) \{\s*forgetStoreRoster\(workspaceId\)/)
  assert.match(library, /return \{ refreshSavedForms, reloadOzonStores, openRunner \}/)
  const products = readFileSync(
    new URL("../products/products-screen.tsx", import.meta.url),
    "utf8",
  )
  const shipping = readFileSync(
    new URL("../ops/shipping/shipping-screen.tsx", import.meta.url),
    "utf8",
  )
  const returns = readFileSync(
    new URL("../ops/returns/returns-screen.tsx", import.meta.url),
    "utf8",
  )
  const supply = readFileSync(
    new URL("../ops/supply/supply-screen.tsx", import.meta.url),
    "utf8",
  )
  const voice = readFileSync(
    new URL("../ops/voice/voice-screen.tsx", import.meta.url),
    "utf8",
  )
  const messageCenter = readFileSync(
    new URL("../message-center/message-center-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(products, /useStoreRoster/)
  assert.match(shipping, /useStoreRoster/)
  assert.match(returns, /useStoreRoster/)
  assert.match(supply, /useStoreRoster/)
  assert.match(voice, /useStoreRoster/)
  assert.match(messageCenter, /useStoreRoster/)
})

test("a request resolved after invalidate cannot repopulate the cache", async (t) => {
  invalidateStoreRoster()
  const original = integrationsHttp.integrationsListOzonStores
  const pending = deferred<OzonStoresOverview>()
  integrationsHttp.integrationsListOzonStores = () => pending.promise
  t.after(() => {
    integrationsHttp.integrationsListOzonStores = original
    invalidateStoreRoster()
  })

  const request = loadStoreRoster({ workspaceId: 71, force: true })
  invalidateStoreRoster()
  pending.resolve(overview)
  await request
  assert.equal(peekStoreRoster(71), undefined)
})

test("a forced refresh wins when the older request resolves last", async (t) => {
  invalidateStoreRoster()
  const original = integrationsHttp.integrationsListOzonStores
  const older = deferred<OzonStoresOverview>()
  const newer = deferred<OzonStoresOverview>()
  const responses = [older.promise, newer.promise]
  integrationsHttp.integrationsListOzonStores = () => responses.shift()!
  t.after(() => {
    integrationsHttp.integrationsListOzonStores = original
    invalidateStoreRoster()
  })
  const oldOverview = { ...overview, active_id: "old" }
  const newOverview = { ...overview, active_id: "new" }

  const oldRequest = loadStoreRoster({ workspaceId: 72, force: true })
  const newRequest = loadStoreRoster({ workspaceId: 72, force: true })
  newer.resolve(newOverview)
  await newRequest
  older.resolve(oldOverview)
  await oldRequest
  assert.equal(peekStoreRoster(72)?.overview.active_id, "new")
})

test("a remembered mutation wins over an older list request", async (t) => {
  invalidateStoreRoster()
  const original = integrationsHttp.integrationsListOzonStores
  const pending = deferred<OzonStoresOverview>()
  integrationsHttp.integrationsListOzonStores = () => pending.promise
  t.after(() => {
    integrationsHttp.integrationsListOzonStores = original
    invalidateStoreRoster()
  })
  const saved = { ...overview, active_id: "saved" }

  const request = loadStoreRoster({ workspaceId: 73, force: true })
  rememberStoreRoster(saved, 73)
  pending.resolve({ ...overview, active_id: "stale" })
  await request
  assert.equal(peekStoreRoster(73)?.overview.active_id, "saved")
})
