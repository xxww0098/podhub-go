import assert from "node:assert/strict"
import test from "node:test"
import {
  createPreparationTracks,
  preparationRunning,
  preparationTracksForCard,
  rowPreparing,
  trackBusy,
} from "./preparation-tracks"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"

test("prepare tracks do not take a whole-row lock", () => {
  const tracks = createPreparationTracks()
  assert.deepEqual(tracks.claim("ai", ["row-1"]), ["row-1"])
  assert.deepEqual(tracks.claim("render", ["row-1"]), ["row-1"])
  const live = tracks.snapshot()
  assert.equal(trackBusy(live, "ai", "row-1"), true)
  assert.equal(trackBusy(live, "render", "row-1"), true)
  assert.equal(rowPreparing(live, "row-1"), true)
  tracks.release("ai", ["row-1"])
  assert.equal(trackBusy(tracks.snapshot(), "render", "row-1"), true)
  assert.equal(trackBusy(tracks.snapshot(), "ai", "row-1"), false)
  tracks.release("render", ["row-1"])
  assert.equal(preparationRunning(tracks.snapshot()), false)
})

test("a remounted card observes old batch releases without updating another card", () => {
  resetListingWorkbench()
  const a = preparationTracksForCard("subscription-a")
  const b = preparationTracksForCard("subscription-b")
  a.claim("render", ["a-1", "a-2"])
  b.claim("ai", ["b-1"])
  let oldUpdates = 0
  const leaveA = a.subscribe(() => { oldUpdates++ })
  leaveA()
  const oldCount = oldUpdates
  const leaveB = b.subscribe(activity => patchListingWorkbench({ activity }))
  let leaveRestoredA = () => {}
  try {
    a.release("render", ["a-1"])
    assert.deepEqual([...peekListingWorkbench().activity.ai], ["b-1"])
    leaveB()
    resetListingWorkbench()
    const restored = preparationTracksForCard("subscription-a")
    assert.equal(restored, a)
    leaveRestoredA = restored.subscribe(activity => patchListingWorkbench({ activity }))
    assert.deepEqual([...peekListingWorkbench().activity.render], ["a-2"])
    a.release("render", ["a-2"])
    assert.equal(preparationRunning(peekListingWorkbench().activity), false)
    assert.equal(oldUpdates, oldCount, "the unmounted view must remain unsubscribed")
    assert.notEqual(preparationTracksForCard("subscription-a"), a)
  } finally {
    leaveB()
    leaveRestoredA()
    a.release("render", ["a-1", "a-2"])
    b.release("ai", ["b-1"])
    resetListingWorkbench()
  }
})
