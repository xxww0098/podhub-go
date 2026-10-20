/**
 * Decision contract of the context-level browser guard (tests/mock-browser-network.ts)
 * against a small fake BrowserContext / Route — no browser, no server, no socket.
 *
 * The real-browser half (a controlled local 302 on the gate server whose target
 * must see 0 requests, `/@fs/` and forbidden-path probes) is the negative
 * scenario of tests/run-mock-browser.ts; this file pins the rules it relies on:
 * static reads never follow redirects, failed reads stay observable, the static
 * allowlist is pathname-only and loses to forbidden / ambiguous paths, and
 * static, business and unknown ledgers stay separate.
 */
// Shared hostile URL data: rejection probes only, never filesystem inputs or outputs.
import forbiddenPaths from "./fixtures/mock-browser-forbidden-paths.json"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import type { BrowserContext, Route, WebSocketRoute } from "playwright-core"

import { installBrowserNetworkGuard, isAllowedBrowserStaticPath, viteStaticPrefixes, type BrowserNetworkPolicy } from "./mock-browser-network.ts"

const ORIGIN = "http://127.0.0.1:14920"
const REPO = "/repo"
/** A committed build artifact: it lives above the Vite root, so Vite serves it through /@fs. */
const ARTIFACT = `/@fs${REPO}/wasm/dist/browser/listing-state.wasm`
/** `requestLabel` strips the /@fs repo prefix, so labels name the repo-relative artifact. */
const ARTIFACT_LABEL = "/@fs:wasm/dist/browser/listing-state.wasm"

/** `"throw"` fails route.fetch; `body: "throw"` fails the body read; `fulfill: "throw"` fails the hand-over. */
type StaticAnswer = { status: number; body?: string | "throw"; fulfill?: "throw" } | "throw"
type Handled = { calls: string[]; fetchOptions: unknown[] }

async function guardWith(policy: Partial<BrowserNetworkPolicy>) {
  let http: ((route: Route) => Promise<void>) | undefined
  let socket: ((route: WebSocketRoute) => void) | undefined
  const context = {
    route: async (_match: unknown, handler: (route: Route) => Promise<void>) => {
      http = handler
    },
    routeWebSocket: async (_match: unknown, handler: (route: WebSocketRoute) => void) => {
      socket = handler
    },
  } as unknown as BrowserContext
  const guard = await installBrowserNetworkGuard(
    context,
    { origin: ORIGIN, staticPaths: [], staticPrefixes: [], mocks: [], ...policy },
    REPO,
  )

  async function request(method: string, url: string, answer: StaticAnswer = { status: 200, body: "" }): Promise<Handled> {
    const handled: Handled = { calls: [], fetchOptions: [] }
    const response = answer === "throw" ? null : {
      status: () => answer.status,
      body: async () => {
        if (answer.body === "throw") throw new Error("body read failed")
        return Buffer.from(answer.body ?? "")
      },
      dispose: async () => {
        handled.calls.push("dispose")
      },
    }
    const route = {
      request: () => ({ method: () => method, url: () => url }),
      fetch: async (options: unknown) => {
        handled.calls.push("fetch")
        handled.fetchOptions.push(options)
        if (!response) throw new Error("read failed")
        return response
      },
      fulfill: async () => {
        handled.calls.push("fulfill")
        if (answer !== "throw" && answer.fulfill === "throw") throw new Error("fulfill failed")
      },
      abort: async (code: string) => {
        handled.calls.push(`abort:${code}`)
      },
    } as unknown as Route
    await http!(route)
    return handled
  }

  function webSocket(url: string): string[] {
    const calls: string[] = []
    socket!({
      url: () => url,
      close: async (options: { code: number }) => {
        calls.push(`close:${options.code}`)
      },
    } as unknown as WebSocketRoute)
    return calls
  }

  return { guard, request, webSocket }
}

test("viteStaticPrefixes opens only installed node_modules and the committed artifact tree under /@fs", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "mock-network-prefixes-"))
  try {
    const repoRoot = path.join(scratch, "repo")
    const webRoot = path.join(repoRoot, "web")
    const distRoot = path.join(repoRoot, "wasm", "dist")
    mkdirSync(path.join(repoRoot, "node_modules", ".bun"), { recursive: true })
    mkdirSync(webRoot, { recursive: true })
    const realRoot = realpathSync(repoRoot)

    const prefixes = viteStaticPrefixes(repoRoot, webRoot)
    const fsPrefixes = prefixes.filter((prefix) => prefix.startsWith("/@fs"))
    assert.deepEqual(fsPrefixes, [`/@fs${realRoot}/node_modules/`], "only the existing root node_modules; web/ and wasm/dist are absent")
    assert.ok(!prefixes.includes(`/@fs${repoRoot}/`) && !prefixes.includes(`/@fs${realRoot}/`), "never the repo root itself")
    assert.ok(!prefixes.some((prefix) => prefix === "/src/" || prefix.startsWith("/tests/")), "no source or fixture tree")
    assert.ok(prefixes.includes("/@id/__x00__") && !prefixes.includes("/@id/"), "only virtual module ids")

    mkdirSync(path.join(webRoot, "node_modules"))
    assert.ok(viteStaticPrefixes(repoRoot, webRoot).includes(`/@fs${realpathSync(webRoot)}/node_modules/`))

    // wasm/dist sits above the Vite root, so its artifacts are served through /@fs.
    mkdirSync(distRoot, { recursive: true })
    const withDist = viteStaticPrefixes(repoRoot, webRoot)
    assert.ok(withDist.includes(`/@fs${realpathSync(distRoot)}/`), "the committed artifact tree is served above the Vite root")
    assert.deepEqual(withDist.filter((prefix) => prefix.startsWith("/@fs") && !prefix.endsWith("/node_modules/")),
      [`/@fs${realpathSync(distRoot)}/`], "exactly one artifact prefix, anchored at wasm/dist")
    assert.ok(!withDist.includes(`/@fs${realRoot}/`) && !withDist.includes(`/@fs${realRoot}/wasm/`), "never the repo or its wasm parent")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a static GET is read once with maxRedirects 0, measured and released; the query never matters", async () => {
  const { guard, request } = await guardWith({ staticPaths: ["/tests/entry.html"] })
  const handled = await request("GET", `${ORIGIN}/tests/entry.html?token=abc`, { status: 200, body: "abcd" })
  assert.deepEqual(handled.calls, ["fetch", "fulfill", "dispose"])
  assert.deepEqual(handled.fetchOptions, [{ maxRedirects: 0 }])
  const report = guard.report()
  assert.deepEqual(report.static, { requests: 1, bytes: 4, byLabel: [{ label: "GET self:/tests/entry.html", count: 1, bytes: 4 }] })
  assert.equal(report.unknown.attempts, 0)
})

test("a static 3xx is not followed: unknown, aborted, no Location or query in the label", async () => {
  const { guard, request } = await guardWith({ staticPaths: ["/tests/mock-network-redirect"] })
  for (const status of [301, 302, 307, 308]) {
    const handled = await request("GET", `${ORIGIN}/tests/mock-network-redirect?next=/api/x`, { status })
    assert.deepEqual(handled.calls, ["fetch", "dispose", "abort:blockedbyclient"], `status ${status}`)
    assert.deepEqual(handled.fetchOptions, [{ maxRedirects: 0 }])
  }
  const report = guard.report()
  assert.equal(report.static.requests, 0, "a redirect is never a measured static read")
  assert.deepEqual(
    guard.unknownLabels(),
    [301, 302, 307, 308].map((status) => `GET self:/tests/mock-network-redirect redirect:${status}`),
  )
  assert.ok(guard.unknownLabels().every((label) => !label.includes("next") && !label.includes("/api/x")))
})

test("a failed static read is recorded as unknown and aborted, not swallowed", async () => {
  const { guard, request } = await guardWith({ staticPaths: [ARTIFACT] })
  const handled = await request("GET", `${ORIGIN}${ARTIFACT}`, "throw")
  assert.deepEqual(handled.calls, ["fetch", "abort:blockedbyclient"])
  assert.deepEqual(guard.unknownLabels(), [`GET self:${ARTIFACT_LABEL} static-read-failed`])
  assert.equal(guard.report().static.requests, 0)
})

test("a failed body read is unknown and aborted, and the fetched response is released", async () => {
  const { guard, request } = await guardWith({ staticPaths: [ARTIFACT] })
  const handled = await request("GET", `${ORIGIN}${ARTIFACT}`, { status: 200, body: "throw" })
  assert.deepEqual(handled.calls, ["fetch", "dispose", "abort:blockedbyclient"])
  assert.deepEqual(guard.unknownLabels(), [`GET self:${ARTIFACT_LABEL} static-read-failed`])
  assert.equal(guard.report().static.requests, 0)
  assert.equal(guard.report().static.bytes, 0)
})

test("a failed hand-over to the page is unknown, never a measured static read, and still released", async () => {
  const { guard, request } = await guardWith({ staticPaths: ["/tests/entry.html"] })
  const handled = await request("GET", `${ORIGIN}/tests/entry.html`, { status: 200, body: "abcd", fulfill: "throw" })
  assert.deepEqual(handled.calls, ["fetch", "fulfill", "dispose", "abort:blockedbyclient"])
  assert.deepEqual(guard.unknownLabels(), ["GET self:/tests/entry.html static-fulfill-failed"])
  const report = guard.report()
  assert.deepEqual(report.static, { requests: 0, bytes: 0, byLabel: [] })
  assert.equal(report.unknown.attempts, 1)
})

test("forbidden and ambiguous paths lose to every static prefix and are never read", async () => {
  const { guard, request } = await guardWith({ staticPrefixes: ["/node_modules/", `/@fs${REPO}/node_modules/`] })
  const refused = [
    ...forbiddenPaths.privateFiles,
    "/node_modules/..%2f..%2fsrc/main.tsx",
    "/node_modules/pkg%5c..%5c.env",
    "/node_modules//pkg/index.js",
    ...forbiddenPaths.repoFiles.map((file) => `/@fs${REPO}${file}`),
  ]
  for (const pathname of refused) {
    const handled = await request("GET", `${ORIGIN}${pathname}`)
    assert.deepEqual(handled.calls, ["abort:blockedbyclient"], pathname)
  }
  assert.equal(guard.report().unknown.attempts, refused.length)
  assert.equal(guard.report().static.requests, 0)

  const allowed = await request("GET", `${ORIGIN}/@fs${REPO}/node_modules/.bun/react@19/node_modules/react/index.js`)
  assert.deepEqual(allowed.calls, ["fetch", "fulfill", "dispose"], "Bun's store under the installed node_modules is static")
  assert.deepEqual(guard.report().static.byLabel.map((entry) => entry.label), ["GET self:/@fs:node_modules/.bun/react@19/node_modules/react/index.js"])
})

test("the committed artifact prefix admits only wasm/dist and never widens to the repo", async () => {
  const { guard, request } = await guardWith({
    staticPaths: [ARTIFACT],
    staticPrefixes: [`/@fs${REPO}/wasm/dist/`],
  })
  const refused = [
    // Traversal normalizes back out of the artifact tree before admission is decided.
    `/@fs${REPO}/wasm/dist/../../src/main.tsx`,
    `/@fs${REPO}/wasm/dist/browser/../../../../src/main.tsx`,
    // Encoded separators and empty segments stay ambiguous under any prefix.
    `/@fs${REPO}/wasm/dist/browser/..%2f..%2fsrc/main.tsx`,
    `/@fs${REPO}/wasm/dist//browser/listing-state.wasm`,
    // In-tree paths still lose to the general deny.
    `/@fs${REPO}/wasm/dist/browser/render/../.scratch/state.md`,
    `/@fs${REPO}/wasm/dist/browser/render/server.pem`,
    `/@fs${REPO}/wasm/dist/browser/render/.env.local`,
    // The artifact prefix never covers the repo, its source tree or its wasm parent.
    `/@fs${REPO}/src/main.tsx`,
    `/@fs${REPO}/.scratch/state.md`,
    `/@fs${REPO}/wasm/README.md`,
  ]
  for (const pathname of refused) {
    const handled = await request("GET", `${ORIGIN}${pathname}`)
    assert.deepEqual(handled.calls, ["abort:blockedbyclient"], pathname)
  }
  assert.equal(guard.report().unknown.attempts, refused.length)
  assert.equal(guard.report().static.requests, 0)

  const allowed = await request("GET", `${ORIGIN}${ARTIFACT}?import`, { status: 200, body: "wasm" })
  assert.deepEqual(allowed.calls, ["fetch", "fulfill", "dispose"])
  assert.deepEqual(guard.report().static.byLabel.map((entry) => entry.label), [`GET self:${ARTIFACT_LABEL}`])
  assert.equal(guard.report().static.bytes, 4)
})

test("business mocks are fulfilled and counted apart; business prefixes, other methods, origins and sealed runs are unknown", async () => {
  const { guard, request } = await guardWith({
    staticPrefixes: ["/"],
    mocks: [{ operation: "listingSubmit", method: "POST", path: "/api/listing/submit", status: 202, json: { ok: true } }],
  })
  assert.deepEqual((await request("POST", `${ORIGIN}/api/listing/submit?x=1`)).calls, ["fulfill"])
  assert.deepEqual((await request("GET", `${ORIGIN}/api/listing/rows`)).calls, ["abort:blockedbyclient"], "business prefix is never static")
  assert.deepEqual((await request("GET", `${ORIGIN}/cpa`)).calls, ["abort:blockedbyclient"])
  assert.deepEqual((await request("PUT", `${ORIGIN}/tests/upload.bin`)).calls, ["abort:blockedbyclient"])
  assert.deepEqual((await request("GET", "https://seller.invalid/v3/product")).calls, ["abort:blockedbyclient"])
  assert.deepEqual((await request("GET", "http://localhost:14920/tests/entry.html")).calls, ["abort:blockedbyclient"])
  guard.seal()
  assert.deepEqual((await request("GET", `${ORIGIN}/tests/entry.html`)).calls, ["abort:blockedbyclient"], "sealed: even static is late")
  assert.deepEqual((await request("POST", `${ORIGIN}/api/listing/submit`)).calls, ["abort:blockedbyclient"], "sealed: mocks are late too")

  const report = guard.report()
  assert.deepEqual(report.business, { calls: 1, byOperation: [{ operation: "listingSubmit", method: "POST", count: 1 }] })
  assert.equal(report.static.requests, 0)
  assert.deepEqual(guard.unknownLabels(), [
    "GET self:/api/listing/rows",
    "GET self:/cpa",
    "PUT self:/tests/upload.bin",
    "GET cross:https://seller.invalid/v3/product",
    "GET cross:http://localhost:14920/tests/entry.html",
    "GET self:/tests/entry.html",
    "POST self:/api/listing/submit",
  ])
})

test("every WebSocket is unknown and closed with 1008", async () => {
  const { guard, webSocket } = await guardWith({ staticPrefixes: ["/"] })
  assert.deepEqual(webSocket("ws://127.0.0.1:14920/"), ["close:1008"])
  assert.deepEqual(guard.unknownLabels(), ["WS self:/"])
})

test("shared static admission keeps business and forbidden paths closed even under an exact allowlist", () => {
  for (const pathname of ["/api/listing/submit", "/api", "/cpa", "/v0/management/jobs",
    ...forbiddenPaths.privateFiles, "/node_modules/..%2f..%2fdata", "/node_modules//pkg/index.js"]) {
    assert.equal(isAllowedBrowserStaticPath({ staticPaths: [pathname], staticPrefixes: [] }, pathname), false, pathname)
  }
  assert.equal(isAllowedBrowserStaticPath({ staticPaths: ["/tests/entry.html"], staticPrefixes: [] }, "/tests/entry.html"), true)
  assert.equal(isAllowedBrowserStaticPath({ staticPaths: ["/tests/entry.html"], staticPrefixes: [] }, "/tests/other.html"), false)
})

test("public credential-expiry source requires exact registration and never a prefix", () => {
  const module = "/src/lib/credential-expiry.ts"
  const registered = { staticPaths: [module], staticPrefixes: [] }
  assert.equal(isAllowedBrowserStaticPath(registered, module), true)
  for (const prefix of ["/", "/src/", "/src/lib/", module]) {
    assert.equal(isAllowedBrowserStaticPath({ staticPaths: [], staticPrefixes: [prefix] }, module), false, prefix)
  }
  for (const pathname of ["/src/lib/", "/src/lib/credential-expiry", "/src/lib/credential-expiry.ts/",
    "/src/lib/credentials-expiry.ts", "/src/lib/Credential-expiry.ts", "/src/lib/credential-expiry.ts.map",
    `/@fs${REPO}/web${module}`, "/src/lib/./credential-expiry.ts", "/src/lib/../lib/credential-expiry.ts",
    "/src//lib/credential-expiry.ts", "/src/lib/%63redential-expiry.ts", "/src/lib/credential-expiry%2ets",
    "/src/lib%2fcredential-expiry.ts", "/src/lib/credential-expiry.ts\\data"]) {
    assert.equal(isAllowedBrowserStaticPath(registered, pathname), false, pathname)
  }
  for (const pathname of ["/src/lib/credentials-expiry.ts", "/src/lib/credential-expiry.ts.map",
    `/@fs${REPO}/web${module}`, "/src/lib/client-secret.ts", "/src/lib/.env", "/src/lib/server.pem", "/src/lib/server.key"]) {
    assert.equal(isAllowedBrowserStaticPath({ staticPaths: [pathname], staticPrefixes: ["/"] }, pathname), false, pathname)
  }
})

test("context guard reads the registered public timestamp module without widening request fences", async () => {
  const module = "/src/lib/credential-expiry.ts"
  const { guard, request } = await guardWith({ staticPaths: [module], staticPrefixes: ["/src/lib/"] })
  const allowed = await request("GET", `${ORIGIN}${module}?import&token=private-query`, { status: 200, body: "timestamp predicate" })
  assert.deepEqual(allowed.calls, ["fetch", "fulfill", "dispose"])
  assert.deepEqual(allowed.fetchOptions, [{ maxRedirects: 0 }])
  for (const [method, url] of [["GET", `${ORIGIN}${module}.map`], ["GET", `${ORIGIN}/src/lib/client-secret.ts`],
    ["POST", `${ORIGIN}${module}`], ["GET", `http://localhost:14920${module}`]] as const) {
    assert.deepEqual((await request(method, url)).calls, ["abort:blockedbyclient"], `${method} ${url}`)
  }
  guard.seal()
  assert.deepEqual((await request("GET", `${ORIGIN}${module}`)).calls, ["abort:blockedbyclient"])
  assert.deepEqual(guard.report().static, { requests: 1, bytes: Buffer.byteLength("timestamp predicate"),
    byLabel: [{ label: `GET self:${module}`, count: 1, bytes: Buffer.byteLength("timestamp predicate") }] })
  assert.equal(guard.report().unknown.attempts, 5)
  assert.equal(guard.report().business.calls, 0)

  const prefixOnly = await guardWith({ staticPrefixes: ["/src/lib/"] })
  assert.deepEqual((await prefixOnly.request("GET", `${ORIGIN}${module}`)).calls, ["abort:blockedbyclient"])
  assert.equal(prefixOnly.guard.report().static.requests, 0)
  assert.equal(prefixOnly.guard.report().unknown.attempts, 1)
})
