/**
 * 一个设计的规格共用一个店铺：每卡配额不得把同款规格拆到第二个店铺。
 *
 * A per-card quota may re-home an ordinary row whose Store left the target
 * list. An associated row is not the quota's to move: it stays unassigned and
 * the operator re-assigns explicitly. Attempts that already left keep their
 * Store either way — this function only answers where a *new* send would go.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { associationStoreConflicts, sendStoreAssignments } from "./store-quota"

test("an associated spec keeps its Store and never takes a quota slice", () => {
  const rows = [
    ["row-a", "store-1", "association"],
    ["row-b", "store-1", "association"],
    ["row-c", undefined, undefined],
    ["row-d", undefined, undefined],
  ] as const
  const targets = sendStoreAssignments(["store-1", "store-2"], rows)
  assert.equal(targets.get("row-a"), "store-1")
  assert.equal(targets.get("row-b"), "store-1")
  // The ordinary rows still land on a target from the list; the associated
  // ones are answered from their own binding and are never redistributed.
  for (const rowId of ["row-c", "row-d"]) {
    assert.ok(["store-1", "store-2"].includes(targets.get(rowId) ?? ""), rowId)
  }
})

test("associated specs whose Store left the targets stay unassigned and are reported", () => {
  const rows = [
    ["row-a", "store-9", "association"],
    ["row-b", "store-9", "association"],
    ["row-c", "store-9", undefined],
  ] as const
  const conflicts = associationStoreConflicts(["store-1"], rows)
  assert.deepEqual(conflicts, ["row-a", "row-b"], "only the associated rows need an explicit call")
  const targets = sendStoreAssignments(["store-1"], rows)
  assert.equal(targets.get("row-a"), "", "a design is never split by a quota")
  assert.equal(targets.get("row-b"), "")
  assert.equal(targets.get("row-c"), "store-1", "an ordinary row still fills the quota")
})

test("rows already on a target Store are answered with exactly that Store", () => {
  const targets = sendStoreAssignments(
    ["store-1", "store-2"],
    [
      ["row-a", "store-2", "association"],
      ["row-b", "store-1", undefined],
    ],
  )
  assert.equal(targets.get("row-a"), "store-2")
  assert.equal(targets.get("row-b"), "store-1")
})
