import assert from "node:assert/strict"
import test from "node:test"

// stubStorage() installs a partial window stub; drop it after this file so a
// later suite never sees a window without the real browser surface.
test.after(() => {
  delete (globalThis as { window?: unknown }).window
})

import type { AccountOverview } from "@/bindings/commands"

import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import type { MonitorProduct, StorePerformance, SyncState } from "./product-list-model"
import {
  readProductSnapshot,
  writeProductSnapshot,
  type ProductSnapshot,
} from "./product-snapshot-store"

const product: MonitorProduct = {
  productId: 41,
  offerId: "ART-41",
  sku: 90041,
  name: "Live product",
  categoryName: "类目 170",
  primaryImageUrl: "https://img/41.jpg",
  imageCount: 3,
  officialState: "active",
  statusName: "Продается",
  isArchived: false,
  issueCount: 0,
  issueLevel: "",
  issueCode: "",
  issueMessage: "",
  price: 100,
  oldPrice: 0,
  currencyCode: "CNY",
  stockPresent: 7,
  stockReserved: 2,
  promotionDiscountPercent: 10,
  promotionActionTitle: "Sale",
  promotionActionPrice: "90.00",
  hitsView: 12,
  sessionView: 6,
  orderedUnits: 2,
  revenue: 180,
  sessionViewSeries: [1, 3, 2],
  staleUnsold: false,
}

const performance: StorePerformance = {
  periodDays: 3,
  hitsView: 12,
  sessionView: 6,
  orderedUnits: 2,
  revenue: 180,
  throughDay: "2026-09-13",
}

const SYNCED_AT = Date.now() - 60_000

function snapshotAt(syncedAtMs: number, items: MonitorProduct[] = [product]): ProductSnapshot {
  const syncStates: SyncState[] = [
    { domain: "products", lastSyncAtMs: syncedAtMs, lastError: "", rateLimitedUntilMs: 0 },
    { domain: "metrics", lastSyncAtMs: syncedAtMs, lastError: "", rateLimitedUntilMs: 0 },
  ]
  return { products: items, syncStates, performance }
}

/** A sessionStorage with a byte ceiling, plus the map behind it for assertions. */
function stubStorage(ceilingBytes = Infinity) {
  const items = new Map<string, string>()
  const used = () => [...items.values()].reduce((total, value) => total + value.length, 0)
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const after = used() - (items.get(key)?.length ?? 0) + value.length
      if (after > ceilingBytes) {
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" })
      }
      items.set(key, value)
    },
    removeItem: (key: string) => void items.delete(key),
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: storage },
  })
  return items
}

function signIn(uuid: string) {
  rememberAccountOverview({
    session: { authenticated: true, email: `${uuid}@example.invalid` },
    accounts: [{ uuid, active: true, email: `${uuid}@example.invalid`, name: uuid }],
    workspaces: [],
  } as unknown as AccountOverview)
}

function keyFor(items: Map<string, string>, storeUid: string): string {
  const key = [...items.keys()].find((candidate) => candidate.includes(`:${storeUid}`))
  assert.ok(key, `expected a stash for ${storeUid}`)
  return key
}

test("this tab repaints the sweep it already paid Ozon for", () => {
  stubStorage()
  signIn("acct-1")
  const snapshot = snapshotAt(SYNCED_AT)
  writeProductSnapshot("store_01", snapshot)
  assert.deepEqual(readProductSnapshot("store_01"), snapshot)
})

test("another Account or Store on the same tab never inherits the stash", () => {
  stubStorage()
  signIn("acct-1")
  writeProductSnapshot("store_01", snapshotAt(SYNCED_AT))
  assert.ok(readProductSnapshot("store_01"))
  assert.equal(readProductSnapshot("store_02"), null)

  signIn("acct-2")
  assert.equal(readProductSnapshot("store_01"), null)
})

test("a corrupt or misshapen stash is a miss, not a crash", () => {
  const items = stubStorage()
  signIn("acct-1")
  writeProductSnapshot("store_01", snapshotAt(SYNCED_AT))
  const key = keyFor(items, "store_01")

  const cases: unknown[] = [
    "{ not json",
    { storeUid: "store_01", syncedAtMs: SYNCED_AT }, // no products at all
    {
      ...snapshotAt(SYNCED_AT),
      storeUid: "store_01",
      syncedAtMs: SYNCED_AT,
      products: [{ ...product, price: "100" }],
    },
    {
      ...snapshotAt(SYNCED_AT),
      storeUid: "store_01",
      syncedAtMs: SYNCED_AT,
      syncStates: [{ domain: "unknown", lastSyncAtMs: SYNCED_AT }],
    },
    {
      ...snapshotAt(SYNCED_AT),
      storeUid: "store_01",
      syncedAtMs: SYNCED_AT,
      performance: { ...performance, revenue: "180" },
    },
  ]
  for (const corrupted of cases) {
    items.set(key, typeof corrupted === "string" ? corrupted : JSON.stringify(corrupted))
    assert.equal(readProductSnapshot("store_01"), null)
  }
})

test("a stash older than a day, or stamped in the future, misses and evicts itself", () => {
  const items = stubStorage()
  signIn("acct-1")
  for (const syncedAtMs of [
    Date.now() - 25 * 60 * 60 * 1000,
    Date.now() + 60 * 60 * 1000,
  ]) {
    writeProductSnapshot("store_01", snapshotAt(syncedAtMs))
    assert.equal(readProductSnapshot("store_01"), null, `should not serve ${syncedAtMs}`)
    // The miss is what re-arms the operator's next sweep, so the bytes go too.
    assert.equal(items.size, 0)
  }
})

test("a sweep with no Ozon read behind it is never stashed", () => {
  const items = stubStorage()
  signIn("acct-1")
  writeProductSnapshot("store_01", { products: [product], syncStates: [], performance })
  assert.equal(items.size, 0)
})

test("a stash over quota drops the previous one and lands on the retry", () => {
  signIn("acct-1")
  const small = snapshotAt(SYNCED_AT)
  const big = snapshotAt(SYNCED_AT, [product, { ...product, productId: 42, offerId: "ART-42" }])
  const bigBytes = JSON.stringify({ ...big, storeUid: "store_01", syncedAtMs: SYNCED_AT }).length
  const items = stubStorage(bigBytes + 40)
  items.set("podhub.theme", "dark")

  writeProductSnapshot("store_01", small)
  const key = keyFor(items, "store_01")
  const before = items.get(key)
  writeProductSnapshot("store_01", big)

  assert.notEqual(items.get(key), before, "the fresh sweep should have replaced the old one")
  assert.equal(items.get("podhub.theme"), "dark", "a small neighbour key must survive")
})

test("a stash too large even for an empty quota leaves the small keys alone", () => {
  const items = stubStorage(40)
  signIn("acct-1")
  items.set("podhub.theme", "dark")

  writeProductSnapshot("store_01", snapshotAt(SYNCED_AT))

  assert.equal(items.has("podhub.theme"), true)
  assert.equal([...items.keys()].filter((key) => key.includes("store_01")).length, 0)
})
