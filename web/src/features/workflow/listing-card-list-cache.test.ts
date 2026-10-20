import assert from "node:assert/strict"
import test from "node:test"

import type { ListingCardSummary } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import {
  invalidateListingCardList,
  LISTING_CARD_LIST_TTL_MS,
  loadListingCardList,
} from "./listing-card-list-cache"

const card = { draft_id: "card-1", display_name: "方案" } as ListingCardSummary

test("concurrent listing-card reads share one request and honor ttl plus invalidate", async (t) => {
  invalidateListingCardList()
  const original = listingHttp.listingCardListSavedDrafts
  const originalNow = Date.now
  let now = 1_700_000_000_000
  let calls = 0
  Date.now = () => now
  listingHttp.listingCardListSavedDrafts = async () => {
    calls += 1
    return [card]
  }
  t.after(() => {
    listingHttp.listingCardListSavedDrafts = original
    Date.now = originalNow
    invalidateListingCardList()
  })

  const [first, second] = await Promise.all([loadListingCardList(), loadListingCardList()])
  assert.equal(first, second)
  assert.equal(calls, 1)

  const cached = await loadListingCardList()
  assert.equal(cached, first)
  assert.equal(calls, 1)

  now += LISTING_CARD_LIST_TTL_MS
  const expired = await loadListingCardList()
  assert.deepEqual(expired, [card])
  assert.equal(calls, 2)

  invalidateListingCardList()
  await loadListingCardList()
  assert.equal(calls, 3)
})
