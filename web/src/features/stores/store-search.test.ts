import assert from "node:assert/strict"
import test from "node:test"

import type { OzonStoreView } from "@/bindings/commands"
import { filterStoresBySearch, matchesStoreQuery } from "./store-search"

function store(id: string, fields: Partial<OzonStoreView> = {}): OzonStoreView {
  return { id, label: "", client_id: "", tags: [], ...fields } as OzonStoreView
}

const main = store("main", {
  label: "主店",
  client_id: "4877007",
  assignee_name: "工作空间成员",
  assignee_email: "member@example.invalid",
  tags: [{ uuid: "red", name: "Red" }],
})
const backup = store("backup", {
  label: "Backup Shop",
  client_id: "998877",
  tags: [{ uuid: "blue", name: "假日" }],
})

test("matchesStoreQuery searches name, Client ID, tags and assignee", () => {
  assert.equal(matchesStoreQuery(main, "主店"), true)
  assert.equal(matchesStoreQuery(main, "4877007"), true)
  assert.equal(matchesStoreQuery(main, "member@example.invalid"), true)
  assert.equal(matchesStoreQuery(main, "Red"), true)
  assert.equal(matchesStoreQuery(backup, "backup"), true)
  assert.equal(matchesStoreQuery(backup, "假日"), true)
  assert.equal(
    matchesStoreQuery(store("grouped", { group: { uuid: "g", name: "华东" } }), "华东"),
    true,
  )
  assert.equal(matchesStoreQuery(main, "zzz"), false)
})

test("matchesStoreQuery trims and ignores case, empty query matches all", () => {
  assert.equal(matchesStoreQuery(backup, "  BACKUP  "), true)
  assert.equal(matchesStoreQuery(backup, "   "), true)
  assert.equal(matchesStoreQuery(backup, ""), true)
})

test("filterStoresBySearch narrows the roster and copies when idle", () => {
  const stores = [main, backup]
  assert.deepEqual(
    filterStoresBySearch(stores, "shop").map(({ id }) => id),
    ["backup"],
  )
  assert.deepEqual(
    filterStoresBySearch(stores, "998877").map(({ id }) => id),
    ["backup"],
  )
  assert.deepEqual(filterStoresBySearch(stores, "zzz"), [])
  const all = filterStoresBySearch(stores, "  ")
  assert.deepEqual(all.map(({ id }) => id), ["main", "backup"])
  assert.notEqual(all, stores)
})
