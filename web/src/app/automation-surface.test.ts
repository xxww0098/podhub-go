import assert from "node:assert/strict"
import test from "node:test"
import { mountWorkbenchRuntime } from "./automation-surface"
import type { AppRoute } from "@/lib/app-route"

test("platform and refused/no-workspace routes never mount delegated execution, even with an active workspace", () => {
  const calls: number[] = []
  const mount = (id: number) => { calls.push(id); return () => {} }
  for (const kind of ["admin", "admin-denied", "public", "login", "workspace-required"] satisfies AppRoute["kind"][]) {
    assert.equal(mountWorkbenchRuntime(kind, 7, mount), undefined)
  }
  assert.equal(mountWorkbenchRuntime("workbench", undefined, mount), undefined)
  assert.deepEqual(calls, [])
})

test("workbench keeps the existing runtime lifetime and cleanup", () => {
  let mounted = 0
  let cleaned = 0
  const cleanup = mountWorkbenchRuntime("workbench", 7, (id) => {
    mounted = id
    return () => { cleaned++ }
  })
  assert.equal(mounted, 7)
  cleanup?.()
  assert.equal(cleaned, 1)
})
