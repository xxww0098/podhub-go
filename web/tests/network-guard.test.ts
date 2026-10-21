/**
 * Regression for the default-deny bootstrap (tests/network-guard.preload.ts).
 *
 * The guard is reached only through its global symbol with a type-only import:
 * importing the preload as a value would install it here and hide a
 * web/package.json `test` script that stopped passing `--preload`. A direct
 * targeted run must pass `--preload ./tests/network-guard.preload.ts` itself.
 * Blocked attempts are observed with `captureBlocked`, the guard's self-test
 * channel; the "a caught attempt still fails the run" half is
 * tests/network-guard-probe.test.ts, driven from the real scripts.
 *
 * The only sockets opened here are node:http listeners on 127.0.0.1:0 that each
 * test defines route by route and closes in `finally`.
 */
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import type { NetworkGuard } from "./network-guard.preload.ts"

function installedGuard(): NetworkGuard {
  const guard = (globalThis as unknown as Record<symbol, NetworkGuard | undefined>)[Symbol.for("podhub.network-guard")]
  assert.ok(guard, "tests/network-guard.preload.ts is not installed in this worker: run via the web/package.json test script or pass --preload")
  return guard
}

const fetchAtModuleLoad = globalThis.fetch
const stateAtModuleLoad = installedGuard().snapshot()

async function swallow(request: () => Promise<unknown>): Promise<string> {
  try {
    await request()
    return "resolved"
  } catch (error) {
    // Business code that catches and falls back — the guard must not care.
    return error instanceof Error ? error.message : String(error)
  }
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}` }
}

test("the preload is in place before this file's modules evaluate, with no state leaked from other files", () => {
  const guard = installedGuard()
  assert.equal(fetchAtModuleLoad, guard.fetch)
  assert.deepEqual(stateAtModuleLoad.allowedOrigins, [])
  assert.equal(stateAtModuleLoad.unreported, 0)
})

test("relative API, loopback and remote HTTP are refused even when the caller swallows the rejection", async () => {
  const guard = installedGuard()
  const outcomes: string[] = []
  const labels = await guard.captureBlocked(async () => {
    outcomes.push(await swallow(() => fetch("/api/listing/submit", { method: "POST", body: "{\"secret\":1}" })))
    outcomes.push(await swallow(() => fetch("http://localhost:8080/api/health")))
    outcomes.push(await swallow(() => fetch("http://127.0.0.1:1420/cpa/x")))
    outcomes.push(await swallow(() => fetch("http://[::1]:14920/v0/management/y")))
    outcomes.push(await swallow(() => fetch(new Request("https://seller.invalid/v3/product?token=abc#frag"))))
  })
  assert.deepEqual(labels, [
    "POST relative:/api/listing/submit",
    "GET http://localhost:8080/api/health",
    "GET http://127.0.0.1:1420/cpa/x",
    "GET http://[::1]:14920/v0/management/y",
    "GET https://seller.invalid/v3/product",
  ])
  for (const outcome of outcomes) assert.match(outcome, /^\[network-guard\] blocked unregistered network attempt: /)
  assert.ok(labels.every((label) => !label.includes("token") && !label.includes("secret")), "labels carry no query or body")
})

test("file: URLs are not a local exception", async () => {
  const labels = await installedGuard().captureBlocked(async () => {
    await swallow(() => fetch(new URL("./network-guard.test.ts", import.meta.url)))
  })
  assert.equal(labels.length, 1)
  assert.match(labels[0], /^GET file:\/\//)
})

test("a stub a test installs and restores leaves the deny default, not native HTTP", async () => {
  const guard = installedGuard()
  const saved = globalThis.fetch
  globalThis.fetch = (async () => new Response("stubbed")) as unknown as typeof fetch
  assert.equal(await (await fetch("https://anything.invalid/")).text(), "stubbed")
  globalThis.fetch = saved
  assert.equal(globalThis.fetch, guard.fetch)
  const labels = await guard.captureBlocked(async () => {
    await swallow(() => fetch("http://127.0.0.1:8080/api/health"))
  })
  assert.deepEqual(labels, ["GET http://127.0.0.1:8080/api/health"])
})

test("blob: and data: URLs stay local and record nothing", async () => {
  const guard = installedGuard()
  const before = guard.snapshot().total
  assert.equal(await (await fetch("data:text/plain,local-data")).text(), "local-data")
  const blobUrl = URL.createObjectURL(new Blob(["local-blob"]))
  try {
    assert.equal(await (await fetch(blobUrl)).text(), "local-blob")
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
  assert.equal(guard.snapshot().total, before)
})

test("an exact registered fake origin works, unknown routes and other spellings fail, revoke closes it", async () => {
  const guard = installedGuard()
  const { server, origin } = await listen((request, response) => {
    if (request.method === "GET" && request.url === "/fixture/known") {
      response.writeHead(200, { "content-type": "text/plain" }).end("known")
      return
    }
    // A mock that does not know the route records it instead of answering success.
    guard.recordUnregistered(`${request.method} fake:${request.url ?? ""}`)
    response.writeHead(404).end()
  })
  const revoke = guard.allowOrigin(origin)
  try {
    assert.deepEqual(guard.snapshot().allowedOrigins, [origin])
    assert.equal(await (await fetch(`${origin}/fixture/known`)).text(), "known")

    const port = new URL(origin).port
    const labels = await guard.captureBlocked(async () => {
      assert.equal((await fetch(`${origin}/fixture/unknown?q=1`)).status, 404)
      await swallow(() => fetch(`http://localhost:${port}/fixture/known`))
    })
    assert.deepEqual(labels, ["GET fake:/fixture/unknown", `GET http://localhost:${port}/fixture/known`])
  } finally {
    revoke()
  }
  try {
    assert.deepEqual(guard.snapshot().allowedOrigins, [])
    const labels = await guard.captureBlocked(async () => {
      await swallow(() => fetch(`${origin}/fixture/known`))
    })
    assert.deepEqual(labels, [`GET ${origin}/fixture/known`])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("allowOrigin takes one exact loopback origin with its port, never a host, pattern, alias or remote", () => {
  const guard = installedGuard()
  const refused = [
    "localhost",
    "*",
    "http://localhost:9",
    "http://127.0.0.1:9/path",
    "http://127.0.0.1:9/",
    "ws://127.0.0.1:9",
    "http://127.0.0.1",
    "http://127.0.0.1:80",
    "https://127.0.0.1:443",
    "http://127.1:9",
    "http://127.0.0.2:9",
    "http://0.0.0.0:9",
    "http://user:pass@127.0.0.1:9",
    "http://[::1]",
    "https://seller.invalid:8443",
    "http://*.invalid:9",
  ]
  for (const bad of refused) {
    assert.throws(() => guard.allowOrigin(bad), /allowOrigin needs one exact loopback http\(s\) origin with its port/, bad)
  }
  assert.deepEqual(guard.snapshot().allowedOrigins, [])

  for (const good of ["http://127.0.0.1:9", "https://127.0.0.1:9", "http://[::1]:9"]) {
    const revoke = guard.allowOrigin(good)
    revoke()
  }
  assert.deepEqual(guard.snapshot().allowedOrigins, [])
})

test("an allowed origin's redirect is never followed, for URL and Request input, and the target gets 0 requests", async () => {
  const guard = installedGuard()
  const targetHits: string[] = []
  const target = await listen((request, response) => {
    targetHits.push(`${request.method} ${request.url ?? ""}`)
    response.writeHead(200).end("target")
  })
  const source = await listen((request, response) => {
    // Routes match the exact path; the query (`?q=1` below) only proves labels drop it.
    const pathname = (request.url ?? "").split("?", 1)[0]
    if (request.method === "GET" && pathname === "/fixture/redirect-away") {
      response.writeHead(302, { location: `${target.origin}/fixture/landed?token=abc` }).end()
      return
    }
    if (request.method === "GET" && pathname === "/fixture/redirect-self") {
      response.writeHead(307, { location: "/fixture/landed" }).end()
      return
    }
    if (request.method === "GET" && pathname === "/fixture/landed") {
      targetHits.push("GET source:/fixture/landed")
      response.writeHead(200).end("landed")
      return
    }
    guard.recordUnregistered(`${request.method} fake:${request.url ?? ""}`)
    response.writeHead(404).end()
  })
  // Both fakes are allowed: even an allowed Location target must not be reached through a redirect.
  const revokeTarget = guard.allowOrigin(target.origin)
  const revokeSource = guard.allowOrigin(source.origin)
  try {
    const outcomes: string[] = []
    const labels = await guard.captureBlocked(async () => {
      outcomes.push(await swallow(() => fetch(`${source.origin}/fixture/redirect-away?q=1`)))
      outcomes.push(await swallow(() => fetch(`${source.origin}/fixture/redirect-self`, { redirect: "follow" })))
      outcomes.push(await swallow(() => fetch(new Request(`${source.origin}/fixture/redirect-away`, { redirect: "follow" }))))
      outcomes.push(await swallow(() => fetch(new URL(`${source.origin}/fixture/unknown`))))
    })
    assert.deepEqual(labels, [
      `GET ${source.origin}/fixture/redirect-away redirect:302`,
      `GET ${source.origin}/fixture/redirect-self redirect:307`,
      `GET ${source.origin}/fixture/redirect-away redirect:302`,
      "GET fake:/fixture/unknown",
    ])
    for (const outcome of outcomes.slice(0, 3)) assert.match(outcome, /^\[network-guard\] blocked redirect from an allowed origin, not followed: /)
    assert.equal(outcomes[3], "resolved", "an unknown route answers 404 but is still recorded by the fake")
    assert.deepEqual(targetHits, [], "no Location target received a request")
    assert.ok(
      labels.every((label) => !label.includes("token") && !label.includes("landed") && !label.includes("q=1")),
      "labels carry no Location or query",
    )
  } finally {
    revokeSource()
    revokeTarget()
    await new Promise<void>((resolve) => source.server.close(() => resolve()))
    await new Promise<void>((resolve) => target.server.close(() => resolve()))
  }
})

test("Bun destination options (unix socket, proxy) are refused even for an allowed origin", async () => {
  const guard = installedGuard()
  let hits = 0
  const { server, origin } = await listen((_request, response) => {
    hits += 1
    response.writeHead(200).end("ok")
  })
  const revoke = guard.allowOrigin(origin)
  try {
    const labels = await guard.captureBlocked(async () => {
      await swallow(() => fetch(`${origin}/fixture/known`, { unix: "/tmp/podhub-guard.sock" } as RequestInit))
      await swallow(() => fetch(`${origin}/fixture/known`, { proxy: "http://proxy.invalid:3128" } as RequestInit))
    })
    assert.deepEqual(labels, [`GET ${origin}/fixture/known option:unix`, `GET ${origin}/fixture/known option:proxy`])
    assert.equal(hits, 0)
  } finally {
    revoke()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("an awaited timer still runs before the test ends", async () => {
  let ran = false
  await new Promise<void>((resolve) => setTimeout(() => { ran = true; resolve() }, 15))
  assert.equal(ran, true)
})

test("a timer armed here must not post after this test ends", () => {
  setTimeout(() => { void fetch("/api/events/inbox", { method: "POST" }) }, 40)
})

test("the following test is not charged for that inbox post", async () => {
  await new Promise((resolve) => setTimeout(resolve, 60))
})

test("WebSocket and EventSource constructors, when the runtime has them, are refused and recorded", async () => {
  const guard = installedGuard()
  const globals = globalThis as unknown as Record<string, unknown>
  const present = ["WebSocket", "EventSource"].filter((name) => typeof globals[name] === "function")
  const labels = await guard.captureBlocked(() => {
    for (const name of present) {
      const Construct = globals[name] as new (url: string) => unknown
      assert.throws(() => new Construct("ws://127.0.0.1:9/socket?session=x"), /blocked unregistered network attempt/)
    }
  })
  assert.deepEqual(labels, present.map((name) => `${name} ws://127.0.0.1:9/socket`))
})
