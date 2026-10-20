/** Server-side boundary for the same fixture in automated and native browsers.
 * No source loading, mock business handlers, discovery or browser launch lives here. */
import { randomBytes } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { Server } from "node:http"
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http"
import type { Duplex } from "node:stream"
import type { Connect, ViteDevServer } from "vite"
import { isAllowedBrowserStaticPath, requestLabel, viteStaticPrefixes, type BrowserNetworkPolicy } from "./mock-browser-network"
import { assertPipelineBrowserSafety } from "./publish-pipeline-browser-safety"

export const PIPELINE_BROWSER_ORIGIN = "http://127.0.0.1:14921"
// Vite adds this to its own script/style tags and CSS nonce meta. It is replaced
// at the HTTP boundary with a fresh nonce for each HTML response, never shared.
export const PIPELINE_CSP_NONCE_PLACEHOLDER = "__podhub_pipeline_response_nonce__"
export type PipelineServerReport = {
  allowed: number; denied: number; webSockets: number
  byLabel: { label: string; status: number; count: number; bytes: number }[]
}

export function pipelineIsolationHeaders(nonce: string): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9+/]{32}$/.test(nonce)) throw new Error("Invalid fixture response nonce")
  const origin = PIPELINE_BROWSER_ORIGIN
  return Object.freeze({
    "Content-Security-Policy": [
      "default-src 'none'", "base-uri 'none'", "object-src 'none'",
      `script-src ${origin} 'nonce-${nonce}' 'wasm-unsafe-eval'`, "script-src-attr 'none'",
      `style-src ${origin} 'nonce-${nonce}'`, "style-src-attr 'none'", `font-src ${origin}`,
      // Native WASM fetch needs this exact HTTP origin. WebSocket upgrades and
      // SSE requests are also refused by the server, regardless of CSP support.
      `connect-src ${origin}`, "img-src 'none'", "media-src 'none'", "worker-src 'none'",
      "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "manifest-src 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
  })
}

/** Reject before URL normalization or Vite file resolution; queries are never logged. */
function rawPath(raw: string): string | null {
  if (!raw.startsWith("/") || /[\x00-\x20\x7f#\\]/.test(raw)) return null
  const pathname = raw.split("?", 1)[0]!
  if (pathname.includes("%") || pathname.includes("//") || pathname.split("/").some((part) => part === "." || part === "..")) return null
  return pathname
}

/** The one artifact tree the fixture reads: it lives above the Vite root and is served through `/@fs`. */
function artifactPrefix(repoRoot: string): string | null {
  const root = path.join(repoRoot, "wasm", "dist")
  return existsSync(root) ? `/@fs${realpathSync(root)}/` : null
}

export function createPipelineBrowserServerGuard(policy: BrowserNetworkPolicy, repoRoot: string) {
  const expected = viteStaticPrefixes(repoRoot, `${repoRoot}/web`).sort()
  const artifacts = artifactPrefix(repoRoot)
  if (policy.origin !== PIPELINE_BROWSER_ORIGIN || policy.mocks.length
    || JSON.stringify([...policy.staticPrefixes].sort()) !== JSON.stringify(expected)
    || !policy.staticPaths.every((p) => rawPath(p) === p && isAllowedBrowserStaticPath(policy, p))) {
    throw new Error("Unsafe fixture server policy")
  }
  // A path served above the Vite root is admitted only as an exact file under the
  // committed artifact tree: never the repo, its source tree or its wasm parent.
  // The prefix is never enough on its own, so the fixture must also carry the
  // artifacts it claims to serve once that tree exists.
  if (!policy.staticPaths.every((p) => !p.startsWith("/@fs") || (artifacts !== null && p.startsWith(artifacts)))
    || (artifacts !== null && !policy.staticPaths.some((p) => p.startsWith(artifacts)))) {
    throw new Error("Unsafe fixture server policy")
  }
  // Snapshot only the fixed inventory strings; a caller cannot widen a live server.
  const paths = { staticPaths: [...policy.staticPaths], staticPrefixes: [...policy.staticPrefixes] }
  const host = new URL(PIPELINE_BROWSER_ORIGIN).host
  const ledger = new Map<string, { label: string; status: number; count: number; bytes: number }>()
  let allowed = 0, denied = 0, webSockets = 0
  function record(label: string, status: number, bytes: number) {
    const key = `${label} ${status}`
    const boundedKey = ledger.has(key) || ledger.size < 100 ? key : "other attempts"
    const entry = ledger.get(boundedKey) ?? { label: boundedKey === key ? label : "other attempts", status: boundedKey === key ? status : 0, count: 0, bytes: 0 }
    entry.count++; entry.bytes += bytes; ledger.set(boundedKey, entry)
  }
  function admission(req: IncomingMessage): { pathname: string | null; reason: string | null } {
    const pathname = rawPath(req.url ?? "")
    if (req.headers.host !== host || req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === "host").length !== 1) return { pathname, reason: "host" }
    if (req.headers.origin !== undefined && req.headers.origin !== PIPELINE_BROWSER_ORIGIN) return { pathname, reason: "origin" }
    if (req.method !== "GET") return { pathname, reason: "method" }
    if (req.headers.upgrade !== undefined || /text\/event-stream/i.test(req.headers.accept ?? "")) return { pathname, reason: "stream" }
    if (pathname === null || !isAllowedBrowserStaticPath(paths, pathname)) return { pathname, reason: "path" }
    return { pathname, reason: null }
  }
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const nonce = randomBytes(24).toString("base64")
    const headers = pipelineIsolationHeaders(nonce)
    const { pathname, reason } = admission(req)
    const label = pathname ? requestLabel(req.method ?? "UNKNOWN", `${PIPELINE_BROWSER_ORIGIN}${pathname}`, PIPELINE_BROWSER_ORIGIN, repoRoot) : "invalid-path"
    let responseDenied = reason !== null, bytes = 0
    const applyHeaders = () => { for (const [name, value] of Object.entries(headers)) res.setHeader(name, value) }
    applyHeaders()
    // Apply again at commit: downstream Vite headers cannot replace isolation;
    // even an allowlisted directory's redirect cannot make the browser follow it.
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status: number, messageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[], supplied?: OutgoingHttpHeaders | OutgoingHttpHeader[]) => {
      const values = typeof messageOrHeaders === "string" ? supplied : messageOrHeaders
      if (Array.isArray(values)) {
        for (let i = 0; i < values.length; i += 2) {
          const name = values[i], value = values[i + 1]
          if (typeof name !== "string" || value === undefined) throw new Error("Invalid static response headers")
          res.setHeader(name, value)
        }
      } else if (values) {
        for (const [name, value] of Object.entries(values)) if (value !== undefined) res.setHeader(name, value)
      }
      if (status >= 300 && status < 400 && status !== 304) {
        status = 403; responseDenied = true
        res.removeHeader("Location"); res.removeHeader("Content-Length")
      }
      applyHeaders()
      return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status)
    }
    const end = res.end.bind(res)
    res.end = (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
      if (!res.headersSent && /text\/html/i.test(String(res.getHeader("Content-Type") ?? ""))) {
        const html = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null
        if (html?.includes(PIPELINE_CSP_NONCE_PLACEHOLDER)) {
          chunk = html.replaceAll(PIPELINE_CSP_NONCE_PLACEHOLDER, nonce)
          res.removeHeader("Content-Length"); res.removeHeader("ETag")
        } else {
          responseDenied = true; res.statusCode = 403; chunk = "Fixture HTML nonce contract refused"
          res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.removeHeader("Content-Length")
        }
      }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304) {
        responseDenied = true; res.statusCode = 403; chunk = "Fixture redirect refused"
        res.removeHeader("Location"); res.removeHeader("Content-Length")
      }
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : Buffer.isBuffer(chunk) ? chunk.byteLength : 0
      if (typeof chunk === "function") { const done = chunk; return end(() => done()) }
      return typeof encodingOrCallback === "string" ? end(chunk, encodingOrCallback, callback) : end(chunk, encodingOrCallback)
    }
    // Streamed static assets are measured too; no content is retained.
    const write = res.write.bind(res)
    res.write = (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : Buffer.isBuffer(chunk) ? chunk.byteLength : 0
      return typeof encodingOrCallback === "string" ? write(chunk, encodingOrCallback, callback) : write(chunk, encodingOrCallback)
    }
    let recorded = false
    const settled = (finished: boolean) => {
      if (recorded) return
      recorded = true
      if (!finished) responseDenied = true
      if (responseDenied) denied++; else allowed++
      record(`${label}${reason ? ` denied:${reason}` : responseDenied ? " denied:response" : ""}`, finished ? res.statusCode : 0, bytes)
    }
    res.once("finish", () => settled(true))
    res.once("close", () => settled(false))
    if (reason) { res.statusCode = 403; res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end("Fixture network boundary refused"); return }
    next()
  }
  function rejectUpgrade(_req: IncomingMessage, socket: Duplex): void {
    denied++; webSockets++
    // No request target, query or headers are copied into this response/ledger.
    record("WS refused", 403, 0)
    const headers = pipelineIsolationHeaders(randomBytes(24).toString("base64"))
    socket.end(`HTTP/1.1 403 Forbidden\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}Connection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
  }
  return {
    middleware, rejectUpgrade,
    install(server: ViteDevServer): void {
      assertPipelineBrowserSafety(server.config)
      if (!(server.httpServer instanceof Server) || server.httpServer.listening || server.config.server.host !== "127.0.0.1" || server.config.server.port !== 14921
        || server.config.server.strictPort !== true || server.config.server.cors !== false || server.config.appType !== "mpa"
        || server.config.html?.cspNonce !== PIPELINE_CSP_NONCE_PLACEHOLDER || server.httpServer.listenerCount("upgrade")) {
        throw new Error("Unsafe fixture server installation")
      }
      // Connect exposes stack in its installed public types. Prepend after Vite
      // creation, before listen, so even its CORS/invalid-request handlers are fenced.
      server.middlewares.stack.unshift({ route: "", handle: middleware })
      server.httpServer.on("upgrade", rejectUpgrade)
      server.httpServer.requestTimeout = 30_000
      server.httpServer.headersTimeout = 15_000
    },
    report(): PipelineServerReport { return { allowed, denied, webSockets, byLabel: [...ledger.values()].map((entry) => ({ ...entry })) } },
  }
}
