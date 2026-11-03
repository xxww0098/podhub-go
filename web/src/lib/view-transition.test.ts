import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { runViewTransition } from "./view-transition"

test("runViewTransition mutates immediately when the View Transition API is missing", () => {
  let calls = 0
  runViewTransition(() => {
    calls += 1
  })
  assert.equal(calls, 1)
})

test("runViewTransition snapshots through startViewTransition when motion is allowed", () => {
  const order: string[] = []
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const startViewTransition = (update: () => void) => {
    order.push("start")
    update()
    order.push("started")
    return {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition() {},
    }
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { startViewTransition },
    writable: true,
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false }),
    },
    writable: true,
  })

  try {
    runViewTransition(() => {
      order.push("mutate")
    })
    assert.deepEqual(order, ["start", "mutate", "started"])
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document")
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
        writable: true,
      })
    }
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window")
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    }
  }
})

test("runViewTransition skips the snapshot when reduced motion is requested", () => {
  let started = 0
  let calls = 0
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      startViewTransition: () => {
        started += 1
      },
    },
    writable: true,
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
      }),
    },
    writable: true,
  })

  try {
    runViewTransition(() => {
      calls += 1
    })
    assert.equal(started, 0)
    assert.equal(calls, 1)
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document")
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
        writable: true,
      })
    }
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window")
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    }
  }
})

test("runViewTransition consumes a skipped snapshot without an unhandled rejection or replay", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const unhandled: unknown[] = []
  const recordUnhandled = (reason: unknown) => unhandled.push(reason)
  let rejectReady!: (reason: unknown) => void
  const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject })
  let mutations = 0
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    startViewTransition(update: () => void) { update(); return { ready } },
  } })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } })
  process.on("unhandledRejection", recordUnhandled)
  try {
    runViewTransition(() => { mutations += 1 })
    // A second navigation or skipTransition() rejects ready after the update committed.
    rejectReady(new DOMException("Transition skipped", "AbortError"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(unhandled, [])
    assert.equal(mutations, 1)
  } finally {
    process.off("unhandledRejection", recordUnhandled)
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else Reflect.deleteProperty(globalThis, "document")
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("module canvas dissolve refuses plus-lighter and names only the canvas", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8")
  const shell = readFileSync(
    new URL("../app/app-shell.tsx", import.meta.url),
    "utf8",
  )
  const app = readFileSync(
    new URL("../app/authenticated-app.tsx", import.meta.url),
    "utf8",
  )

  const dissolve = css.slice(
    css.indexOf("Module switch"),
    css.indexOf("Reduced motion suppresses"),
  )

  assert.match(shell, /className="module-canvas /)
  assert.match(app, /runViewTransition/)
  assert.doesNotMatch(app, /startTransition/)
  assert.match(css, /view-transition-name:\s*module-canvas/)
  assert.match(dissolve, /mix-blend-mode:\s*normal/)
  assert.doesNotMatch(dissolve, /mix-blend-mode:\s*plus-lighter/)
  assert.doesNotMatch(dissolve, /blur\(/)
  assert.match(css, /::view-transition-old\(root\)/)
})

