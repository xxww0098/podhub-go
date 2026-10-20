/** Isolated infrastructure probes only: in-memory decoy responses, literal
 * loopback sockets, no Vite startup, browser, business fixture imports, source hashes or env files. */
// Shared hostile URL data: rejection probes only, never filesystem inputs or outputs.
import forbiddenPaths from "./fixtures/mock-browser-forbidden-paths.json"
import assert from "node:assert/strict"
import { createServer, request, type OutgoingHttpHeaders } from "node:http"
import { connect } from "node:net"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { viteStaticPrefixes, type BrowserNetworkPolicy } from "./mock-browser-network"
import { createPipelineBrowserServerGuard, pipelineIsolationHeaders, PIPELINE_BROWSER_ORIGIN, PIPELINE_CSP_NONCE_PLACEHOLDER } from "./publish-pipeline-browser-server"
import { pipelineNetworkPolicy } from "./publish-pipeline-browser-static"

const repo = "/fixture-repo-that-is-not-opened"
// Only policy inventory strings and installed-package directory prefixes are inspected.
const pipelineRepo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const host = new URL(PIPELINE_BROWSER_ORIGIN).host
const paths = ["/tests/entry.html", "/tests/fixture.js", "/tests/redirect", "/tests/override", "/tests/unnonced.html", "/tests/fixture.wasm"]
function policy(): BrowserNetworkPolicy {
  return { origin: PIPELINE_BROWSER_ORIGIN, mocks: [], staticPaths: [...paths], staticPrefixes: viteStaticPrefixes(repo, `${repo}/web`) }
}
async function isolated(fixed: BrowserNetworkPolicy = policy(), repoRoot = repo) {
  const guard = createPipelineBrowserServerGuard(fixed, repoRoot)
  const reached: string[] = []
  const server = createServer((req, res) => guard.middleware(req, res, () => {
    const pathname = req.url!.split("?", 1)[0]!
    reached.push(pathname)
    if (pathname === "/tests/redirect") { res.writeHead(302, { Location: "http://127.0.0.1:1/decoy-never-requested", "Content-Length": "0" }); res.end(); return }
    if (pathname === "/tests/override") {
      res.writeHead(200, { "Cross-Origin-Embedder-Policy": "unsafe-none", "Content-Security-Policy": "default-src *" }); res.end("fixed static"); return
    }
    if (pathname.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      const html = pathname === "/tests/unnonced.html" ? "<script>unregistered()</script>"
        : `<meta property="csp-nonce" nonce="${PIPELINE_CSP_NONCE_PLACEHOLDER}"><script nonce="${PIPELINE_CSP_NONCE_PLACEHOLDER}">void 0</script>`
      res.setHeader("Content-Length", Buffer.byteLength(html)); res.setHeader("ETag", "stale-placeholder")
      res.end(html); return
    }
    if (pathname.endsWith(".wasm")) { res.setHeader("Content-Type", "application/wasm"); res.write(Buffer.from([0, 97])); res.end(Buffer.from([115, 109])); return }
    res.setHeader("Content-Type", "text/javascript"); res.end("export const fixture = true")
  }))
  server.on("upgrade", guard.rejectUpgrade)
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const port = address.port
  async function get(target: string, method = "GET", headers: OutgoingHttpHeaders = {}) {
    return new Promise<{ status: number; headers: OutgoingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, method, path: target, headers: { Host: host, ...headers }, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("error", reject)
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.setTimeout(2000, () => req.destroy(new Error("isolated fixture probe timed out")))
      req.on("error", reject); req.end()
    })
  }
  async function close() {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  return { fixed, guard, reached, get, close, port }
}

test("server policy snapshots fixed static inventory and refuses widened origin, prefixes or business mocks", () => {
  assert.doesNotThrow(() => createPipelineBrowserServerGuard(policy(), repo))
  for (const mutate of [
    (p: BrowserNetworkPolicy) => { p.origin = "http://localhost:14921" },
    (p: BrowserNetworkPolicy) => { p.staticPrefixes.push("/src/") },
    (p: BrowserNetworkPolicy) => { p.staticPrefixes.push("/") },
    (p: BrowserNetworkPolicy) => { p.staticPrefixes.pop() },
    (p: BrowserNetworkPolicy) => { p.staticPaths.push("/api/listing/submit") },
    (p: BrowserNetworkPolicy) => { p.staticPaths.push("/node_modules/.env") },
    (p: BrowserNetworkPolicy) => { p.mocks.push({ operation: "forbidden", method: "POST", path: "/api/x", status: 200, json: {} }) },
  ]) {
    const p = policy(); mutate(p)
    assert.throws(() => createPipelineBrowserServerGuard(p, repo), { message: "Unsafe fixture server policy" })
  }
})

test("actual pipeline policy starts with the public timestamp module and refuses credential aliases over HTTP", async () => {
  const module = "/src/lib/credential-expiry.ts"
  const fixed = pipelineNetworkPolicy(PIPELINE_BROWSER_ORIGIN, pipelineRepo)
  assert.ok(fixed.staticPaths.includes(module), "exercise the complete authored inventory, not a toy policy")
  const h = await isolated(fixed, pipelineRepo)
  try {
    const allowed = await h.get(`${module}?import&token=private-query`)
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.toString(), "export const fixture = true")
    assert.equal(allowed.headers["cross-origin-embedder-policy"], "require-corp")
    const refused = ["/src/lib/", "/src/lib/credentials-expiry.ts", "/src/lib/Credential-expiry.ts",
      `${module}.map`, `${module}/`, `/@fs${pipelineRepo}/web${module}`, "/src/lib/./credential-expiry.ts",
      "/src/lib/../lib/credential-expiry.ts", "/src//lib/credential-expiry.ts", "/src/lib/%63redential-expiry.ts",
      "/src/lib/credential-expiry%2ets", "/src/lib%2fcredential-expiry.ts", "/src/lib/credential-expiry.ts\\data",
      "/node_modules/pkg/credential-expiry.ts", "/node_modules/pkg/client-secret.ts", "/node_modules/pkg/.env",
      ...forbiddenPaths.privateFiles]
    for (const target of refused) assert.equal((await h.get(target)).status, 403, target)
    assert.deepEqual(h.reached, [module], "no alias or sensitive path reaches file lookup")
    assert.equal(h.guard.report().allowed, 1)
    assert.equal(h.guard.report().denied, refused.length)
    assert.ok(h.guard.report().byLabel.every((entry) => !/token|private-query/.test(entry.label)))
  } finally { await h.close() }
})

test("pipeline serves application fixture snapshots and rejects native crate fixture paths", async () => {
  const h = await isolated(pipelineNetworkPolicy(PIPELINE_BROWSER_ORIGIN, pipelineRepo), pipelineRepo)
  const snapshots = ["/tests/fixtures/listing-core/decorative-wall-art-schema.json", "/tests/fixtures/listing-core/ozon-publish-input.json"]
  try {
    for (const target of snapshots) assert.equal((await h.get(target)).status, 200, target)
    for (const file of ["decorative-wall-art-schema.json", "ozon-freeze-golden.json"]) {
      const target = `/@fs${pipelineRepo}/rust/crates/listing-core-wasm/tests/fixtures/ambient/${file}`
      assert.equal((await h.get(target)).status, 403, target)
    }
    assert.deepEqual(h.reached, snapshots, "native test files never reach filesystem lookup")
  } finally { await h.close() }
})

test("actual pipeline policy cannot authorize the public timestamp module without its exact registration", async () => {
  const module = "/src/lib/credential-expiry.ts"
  const fixed = pipelineNetworkPolicy(PIPELINE_BROWSER_ORIGIN, pipelineRepo)
  fixed.staticPaths = fixed.staticPaths.filter((pathname) => pathname !== module)
  const h = await isolated(fixed, pipelineRepo)
  try {
    assert.equal((await h.get(module)).status, 403)
    h.fixed.staticPaths.push(module)
    assert.equal((await h.get(module)).status, 403, "registration after startup cannot widen the snapshot")
    assert.deepEqual(h.reached, [])
    assert.equal(h.guard.report().allowed, 0)
    assert.equal(h.guard.report().denied, 2)
  } finally { await h.close() }
  const prefixOnly = pipelineNetworkPolicy(PIPELINE_BROWSER_ORIGIN, pipelineRepo)
  prefixOnly.staticPaths = prefixOnly.staticPaths.filter((pathname) => pathname !== module)
  prefixOnly.staticPrefixes.push("/src/lib/")
  assert.throws(() => createPipelineBrowserServerGuard(prefixOnly, pipelineRepo), { message: "Unsafe fixture server policy" })
  for (const pathname of ["/src/lib/credentials-expiry.ts", `${module}.map`, `/@fs${pipelineRepo}/web${module}`, "/src/lib/client-secret.ts"]) {
    const altered = pipelineNetworkPolicy(PIPELINE_BROWSER_ORIGIN, pipelineRepo)
    altered.staticPaths.push(pathname)
    assert.throws(() => createPipelineBrowserServerGuard(altered, pipelineRepo), { message: "Unsafe fixture server policy" }, pathname)
  }
})

test("server static boundary admits fixed files and installed runtime paths without expanding from requests", async () => {
  const h = await isolated()
  try {
    for (const target of ["/tests/fixture.js?token=private-query", "/node_modules/fixture-package/index.js", "/@react-refresh", "/@id/__x00__fixture"]) {
      assert.equal((await h.get(target)).status, 200)
    }
    h.fixed.staticPaths.push("/tests/unregistered.js")
    assert.equal((await h.get("/tests/unregistered.js")).status, 403, "mutable caller inventory cannot widen a running guard")
    const wasm = await h.get("/tests/fixture.wasm")
    assert.deepEqual(wasm.body, Buffer.from([0, 97, 115, 109]), "static binary is never decoded or nonce-reencoded")
    assert.equal(h.guard.report().allowed, 5)
    assert.equal(h.guard.report().denied, 1)
    assert.ok(h.guard.report().byLabel.every((x) => !/token|private-query/.test(x.label)))
    assert.equal(h.guard.report().byLabel.find((x) => x.label.endsWith("/tests/fixture.wasm"))!.bytes, 4)
  } finally { await h.close() }
})

test("server refuses unsafe raw spelling, forbidden files, API, non-GET, wrong Host/Origin and SSE before downstream handlers", async () => {
  const h = await isolated()
  try {
    for (const target of ["/api", "/api/listing/submit", "/cpa", "/v0/management/jobs", "/tests/not-registered.js",
      ...forbiddenPaths.privateFiles,
      "/node_modules/credentials.json", "/node_modules/secret.txt",
      "/node_modules/../private", "/node_modules/./index.js", "/node_modules/%2e%2e/private", "/node_modules/%252e%252e/private",
      "/node_modules/pkg%2fprivate", "/node_modules/pkg%5cprivate", "/node_modules//pkg/index.js", "/node_modules/pkg\\private",
      "http://127.0.0.1:14921/tests/fixture.js", "/tests/fixture.js#fragment", "/@fs/fixture-repo-that-is-not-opened/private.ts"]) {
      assert.equal((await h.get(target)).status, 403, target)
    }
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await h.get("/tests/fixture.js", method)).status, 403, method)
    for (const headers of [{ Host: "localhost:14921" }, { Host: "127.0.0.1:14922" }, { Origin: "http://127.0.0.1:14922" }, { Origin: "null" }, { Accept: "text/event-stream" }]) {
      assert.equal((await h.get("/tests/fixture.js", "GET", headers)).status, 403)
    }
    assert.deepEqual(h.reached, [], "neither Vite/file lookup nor any business handler was reached")
    assert.equal(h.guard.report().allowed, 0)
    assert.ok(h.guard.report().denied > 30)
  } finally { await h.close() }
})

test("server replaces Vite's HTML nonce per response and keeps exact isolation headers on allowed and denied responses", async () => {
  const h = await isolated()
  try {
    const first = await h.get("/tests/entry.html"), second = await h.get("/tests/entry.html")
    assert.equal(first.status, 200); assert.equal(second.status, 200)
    const nonce = /nonce-([A-Za-z0-9+/]{32})/.exec(String(first.headers["content-security-policy"]))![1]!
    assert.match(first.body.toString(), new RegExp(`nonce="${nonce.replace(/[+]/g, "\\+")}"`))
    assert.doesNotMatch(first.body.toString(), /__podhub_pipeline_response_nonce__/)
    assert.notEqual(first.headers["content-security-policy"], second.headers["content-security-policy"])
    assert.equal(first.headers.etag, undefined)
    for (const response of [first, await h.get("/api/x"), await h.get("/tests/override")]) {
      assert.equal(response.headers["cross-origin-opener-policy"], "same-origin")
      assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp")
      assert.equal(response.headers["cross-origin-resource-policy"], "same-origin")
      assert.equal(response.headers["x-content-type-options"], "nosniff")
      assert.equal(response.headers["referrer-policy"], "no-referrer")
      assert.equal(response.headers["cache-control"], "no-store")
      assert.equal(response.headers["x-frame-options"], "DENY")
      assert.doesNotMatch(String(response.headers["content-security-policy"]), /unsafe-none|default-src \*/)
    }
    const missing = await h.get("/tests/unnonced.html")
    assert.equal(missing.status, 403); assert.equal(missing.body.toString(), "Fixture HTML nonce contract refused")
  } finally { await h.close() }
})

test("CSP uses exact static/WASM origin and nonce without broad eval, external sources, workers, frames, images or forms", () => {
  const headers = pipelineIsolationHeaders("a".repeat(32))
  assert.equal(Object.isFrozen(headers), true)
  const csp = headers["Content-Security-Policy"]!
  const directives = Object.fromEntries(csp.split("; ").map((d) => { const [key, ...values] = d.split(" "); return [key, values.join(" ")] }))
  assert.equal(directives["script-src"], `${PIPELINE_BROWSER_ORIGIN} 'nonce-${"a".repeat(32)}' 'wasm-unsafe-eval'`)
  assert.equal(directives["connect-src"], PIPELINE_BROWSER_ORIGIN)
  assert.equal(directives["style-src"], `${PIPELINE_BROWSER_ORIGIN} 'nonce-${"a".repeat(32)}'`)
  for (const key of ["default-src", "base-uri", "object-src", "script-src-attr", "style-src-attr", "img-src", "media-src", "worker-src", "frame-src", "frame-ancestors", "form-action", "manifest-src"]) {
    assert.equal(directives[key], "'none'", key)
  }
  assert.doesNotMatch(csp, /\*|'unsafe-eval'|'unsafe-inline'|blob:|data:|ws:|wss:/)
  assert.throws(() => pipelineIsolationHeaders("bad nonce; default-src *"))
})

test("server redirects are refused with no Location and upgrades receive 403 instead of a WebSocket connection", async () => {
  const h = await isolated()
  try {
    const redirect = await h.get("/tests/redirect")
    assert.equal(redirect.status, 403); assert.equal(redirect.headers.location, undefined)
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: h.port })
      let text = ""
      socket.setTimeout(2000, () => socket.destroy(new Error("isolated upgrade timed out")))
      socket.on("error", reject); socket.on("data", (data: Buffer) => { text += data.toString() }); socket.on("close", () => resolve(text))
      socket.on("connect", () => socket.write(`GET /tests/fixture.js?private-query=hidden HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: Zml4dHVyZS1vbmx5\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    })
    assert.match(answer, /^HTTP\/1\.1 403 Forbidden\r\n/)
    assert.match(answer, /Content-Security-Policy:/)
    assert.doesNotMatch(answer, /101 Switching|private-query|hidden/)
    assert.equal(h.guard.report().webSockets, 1)
    assert.equal(h.guard.report().denied, 2)
    assert.deepEqual(h.reached, ["/tests/redirect"])
  } finally { await h.close() }
})
