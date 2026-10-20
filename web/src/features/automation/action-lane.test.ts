import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createActionLanes } from "./action-lane"

test("a different action starts while the first lane is busy", async () => {
  const lanes = createActionLanes(1)
  const order: string[] = []
  const release: Record<string, () => void> = {}
  const run = (name: string, action: string) => lanes.take(action).then(() => new Promise<void>((resolve) => {
    order.push(name)
    release[name] = () => {
      lanes.free(action)
      resolve()
    }
  }))
  const first = run("prepare-1", "listing_prepare")
  const other = run("import-1", "assets_import")
  const second = run("prepare-2", "listing_prepare")
  await tick()
  assert.deepEqual(order, ["prepare-1", "import-1"])
  release["prepare-1"]!()
  await tick()
  assert.deepEqual(order, ["prepare-1", "import-1", "prepare-2"])
  release["import-1"]!()
  release["prepare-2"]!()
  await Promise.all([first, other, second])
})

test("two of the same action overlap when the lane allows it", async () => {
  const lanes = createActionLanes(2)
  let running = 0
  let peak = 0
  const release: Array<() => void> = []
  const run = () => lanes.take("listing_prepare").then(() => new Promise<void>((resolve) => {
    running += 1
    peak = Math.max(peak, running)
    release.push(() => {
      running -= 1
      lanes.free("listing_prepare")
      resolve()
    })
  }))
  const tasks = [run(), run(), run()]
  await tick()
  assert.equal(peak, 2)
  assert.equal(running, 2)
  release[0]!()
  await tick()
  assert.equal(running, 2)
  release[1]!()
  release[2]!()
  await Promise.all(tasks)
  assert.equal(running, 0)
})
