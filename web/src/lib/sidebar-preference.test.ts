import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { readSidebarOpen, writeSidebarOpen } from "./sidebar-preference"

const KEY = "podhub.sidebar-open"

/** A browser window whose storage is a Map; the storage methods can be swapped. */
function stubWindow(storage?: { getItem?: () => string | null; setItem?: () => void }) {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        ...storage,
      },
    },
  })
  return items
}

// The stub is a partial window (localStorage only); later suites in the same
// process read the real globals, so the property must not outlive this file.
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test("a browser that never chose opens with the rail visible", () => {
  const items = stubWindow()
  assert.equal(readSidebarOpen(), true)
  assert.equal(readSidebarOpen(false), false, "the cold-start fallback still applies")
  assert.equal(items.size, 0, "reading must not write a default")
})

test("the fold round-trips through storage", () => {
  const items = stubWindow()
  writeSidebarOpen(false)
  assert.equal(items.get(KEY), "false")
  assert.equal(readSidebarOpen(), false)

  writeSidebarOpen(true)
  assert.equal(items.get(KEY), "true")
  assert.equal(readSidebarOpen(), true)
})

test("the remembered fold outranks a cold-start default", () => {
  const items = stubWindow()
  items.set(KEY, "false")
  assert.equal(readSidebarOpen(true), false, "an expansion default cannot reopen a folded rail")

  items.set(KEY, "true")
  assert.equal(readSidebarOpen(false), true, "a collapse default cannot re-fold an open rail")
})

test("an absent or unresolvable value is not a fold", () => {
  const items = stubWindow()
  for (const stored of ["", "0", "collapsed", "yes"]) {
    items.set(KEY, stored)
    assert.equal(readSidebarOpen(), true, `should not fold on ${JSON.stringify(stored)}`)
  }

  stubWindow({ getItem: () => { throw new Error("denied") } })
  assert.equal(readSidebarOpen(), true)
  assert.equal(readSidebarOpen(false), false)
})

test("a storage that refuses writes cannot break the toggle", () => {
  stubWindow({ setItem: () => { throw new Error("quota") } })
  assert.doesNotThrow(() => writeSidebarOpen(false))
  assert.equal(readSidebarOpen(), true)
})
