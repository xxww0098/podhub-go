import assert from "node:assert/strict"
import test from "node:test"

import {
  addressOf,
  currentHref,
  hrefOf,
  notifyAddress,
  readAddress,
  replaceAddress,
  subscribeAddress,
} from "./address"

/**
 * `replaceAddress` writes to the real location, so the cases that need a
 * document install the smallest one that can answer: a location and a
 * replaceState that keeps it honest.
 */
function withFakeWindow(run: (replaced: string[]) => void) {
  const replaced: string[] = []
  const location = { pathname: "/", search: "", hash: "", href: "http://localhost/" }
  const fake = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        replaced.push(url)
        const next = new URL(url, "http://localhost")
        location.pathname = next.pathname
        location.search = next.search
        location.hash = next.hash
        location.href = next.href
      },
    },
  }
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = fake
  try {
    run(replaced)
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

test("addressOf parses every href form", () => {
  for (const href of ["http://x/a?b=1#c", "/a?b=1#c", "a?b=1#c"]) {
    assert.deepEqual(addressOf(href), { pathname: "/a", search: "?b=1", hash: "#c" }, href)
  }
  assert.deepEqual(addressOf("http://x"), { pathname: "/", search: "", hash: "" })
})

test("hrefOf round trips", () => {
  const address = addressOf("http://x/a?b=1#c")
  assert.equal(hrefOf(address), "/a?b=1#c")
  assert.deepEqual(addressOf(hrefOf(address)), address)
})

test("the helpers stay safe without a document", () => {
  assert.deepEqual(readAddress(), { pathname: "/", search: "", hash: "" })
  assert.equal(currentHref(), "/")
  replaceAddress("/x")
  replaceAddress({ search: "?y=1" })
})

test("unsubscribing stops notifications", () => {
  let notified = 0
  const off = subscribeAddress(() => {
    notified += 1
  })
  off()
  notifyAddress()
  assert.equal(notified, 0)
})

test("a partial write keeps the parts it was not given", () => {
  withFakeWindow((replaced) => {
    replaceAddress("/a?b=1#c")
    replaced.length = 0
    replaceAddress({ search: "?d=2" })
    assert.deepEqual(readAddress(), { pathname: "/a", search: "?d=2", hash: "#c" })
    assert.deepEqual(replaced, ["/a?d=2#c"])
  })
})

test("a string write replaces the whole address", () => {
  withFakeWindow((replaced) => {
    replaceAddress("/a?b=1#c")
    replaceAddress("/fresh?x=1#top")
    assert.deepEqual(readAddress(), { pathname: "/fresh", search: "?x=1", hash: "#top" })
    assert.deepEqual(replaced, ["/a?b=1#c", "/fresh?x=1#top"])
  })
})

test("a write that changes nothing is not an event", () => {
  withFakeWindow((replaced) => {
    replaceAddress("/a?b=1#c")
    replaced.length = 0
    let notified = 0
    const off = subscribeAddress(() => {
      notified += 1
    })
    replaceAddress({ search: "?b=1" })
    replaceAddress("/a?b=1#c")
    assert.deepEqual(replaced, [], "the identical address is not rewritten")
    assert.equal(notified, 0, "and it wakes no subscriber")

    replaceAddress({ hash: "#d" })
    off()
    assert.deepEqual(replaced, ["/a?b=1#d"])
    assert.equal(notified, 1)
  })
})
