/**
 * Context-level network guard and ledger for mock browser fixtures.
 *
 * Installed on a fresh BrowserContext before any page exists, it sees every
 * HTTP request the context makes — pages, popups, images, dedicated workers —
 * and every WebSocket. Service Workers are blocked by the context options the
 * runner uses, so nothing can answer around this route.
 *
 * Decision order for an HTTP request:
 *   1. an exact mock (origin + method + path) is fulfilled locally → business;
 *   2. a business prefix (the Vite proxy prefixes) is never static → unknown;
 *   3. a GET on the fixture origin whose path is on the static allowlist (exact
 *      fixture paths plus the Vite runtime / installed-package / committed
 *      build-artifact prefixes; never `.scratch`, env, cpa or credential data
 *      (only the explicitly registered public timestamp module is excepted),
 *      never an encoded or ambiguous path) is read from this runner's own Vite
 *      server without
 *      following redirects and measured → static; a 3xx, a failed fetch or body
 *      read, or a failed hand-over to the page → unknown;
 *   4. anything else — other origins, other methods, other paths → unknown.
 * Every WebSocket is unknown: the gate server has no HMR socket, its pages carry
 * no Vite dev client (web/vite.config.ts) and fixtures have no business socket. Unknown requests are aborted, never continued, and
 * stay counted however the page handles the failure.
 *
 * Only method, origin class, host and path appear in labels: no query, body,
 * headers or cookies are read or reported.
 */
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import type { APIResponse, BrowserContext, Route, WebSocketRoute } from "playwright-core"

/** One business call a fixture answers locally. */
export type BusinessMock = {
  /** Stable operation name used in the report, e.g. the ROUTES key. */
  operation: string
  method: string
  /** Exact pathname on the fixture origin. */
  path: string
  status: number
  json: unknown
}

export type BrowserNetworkPolicy = {
  /** The one origin this fixture's server listens on. */
  origin: string
  /** Exact static pathnames: entry HTML, fixture module and each source / JSON / WASM file it really reads. */
  staticPaths: string[]
  /** Static pathname prefixes: the Vite runtime, installed packages and committed build artifacts (`viteStaticPrefixes`). */
  staticPrefixes: string[]
  mocks: BusinessMock[]
}

export type NetworkReport = {
  static: { requests: number; bytes: number; byLabel: { label: string; count: number; bytes: number }[] }
  business: { calls: number; byOperation: { operation: string; method: string; count: number }[] }
  unknown: { attempts: number; byLabel: { label: string; count: number }[] }
}

export type BrowserNetworkGuard = {
  /** After this, every request — even an allowlisted static one — is a late attempt: unknown. */
  seal(): void
  unknownLabels(): string[]
  report(): NetworkReport
}

/**
 * Prefixes the dev server would forward to Cloud (web/vite.config.ts proxy).
 * Checked before the static allowlist so no same-origin rule can open them.
 */
export const BUSINESS_PREFIXES = ["/api/", "/cpa/", "/v0/management"] as const

const LABEL_PATH_MAX = 120

/**
 * Paths the Vite dev server itself serves for a module page: its client and
 * React refresh runtime, virtual (`\0`) modules, installed packages, and the one
 * committed artifact tree the fixtures read from outside the Vite root.
 * `/@fs/` is limited to directories that actually exist — the node_modules
 * directories under the repo root and web root (Bun's symlink store,
 * `node_modules/.bun/…`, is served by its real path under the root one) and
 * `wasm/dist/`, which Vite maps to `/@fs/` because it lives above `web/`.
 * Never the repo itself, so no source tree, `.scratch`, env or credential file
 * can be read through `/@fs/`. Source modules and fixture files are exact
 * `staticPaths` of each fixture; only those four artifacts are read from
 * `wasm/dist/` and each is named there.
 */
export function viteStaticPrefixes(repoRoot: string, webRoot: string): string[] {
  const served = [
    path.join(repoRoot, "node_modules"),
    path.join(webRoot, "node_modules"),
    path.join(repoRoot, "wasm", "dist"),
  ]
    .filter((dir) => existsSync(dir))
    .map((dir) => `/@fs${realpathSync(dir)}/`)
  return ["/@vite/", "/@react-refresh", "/@id/__x00__", "/node_modules/", ...new Set(served)]
}

/** General deny; only the exact public timestamp module is excepted by shared admission. */
const FORBIDDEN_SEGMENTS = [/^\.scratch$/, /^\.git$/, /^cpa$/, /^\.env/, /credential|secret/i, /\.(pem|key)$/i]

/**
 * Encoded separators or dot segments, backslashes and empty segments are
 * decoded differently by the browser URL parser and the dev server's file
 * lookup, so they never qualify as static.
 */
function isAmbiguousPath(pathname: string): boolean {
  return /%2e|%2f|%5c|\\/i.test(pathname) || pathname.includes("//")
}

function isForbiddenStatic(pathname: string): boolean {
  return pathname.split("/").some((segment) => FORBIDDEN_SEGMENTS.some((pattern) => pattern.test(segment)))
}

function isBusinessPath(pathname: string): boolean {
  return BUSINESS_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix))
}

/** Shared pathname admission; origin, method and raw HTTP spelling are checked by each boundary. */
export function isAllowedBrowserStaticPath(
  policy: Pick<BrowserNetworkPolicy, "staticPaths" | "staticPrefixes">,
  pathname: string,
): boolean {
  // This public source contains only a timestamp predicate. Prefixes cannot authorize it.
  if (pathname === "/src/lib/credential-expiry.ts") return policy.staticPaths.includes(pathname)
  return !isBusinessPath(pathname) && !isAmbiguousPath(pathname) && !isForbiddenStatic(pathname)
    && (policy.staticPaths.includes(pathname) || policy.staticPrefixes.some((prefix) => pathname.startsWith(prefix)))
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

/**
 * `kind` is the HTTP method or `WS`. "self" means the fixture's host:port (either
 * scheme family); the allow decisions themselves compare exact origins.
 */
export function requestLabel(kind: string, rawUrl: string, origin: string, repoRoot?: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `${kind} invalid-url`
  }
  const fsPrefix = repoRoot ? `/@fs${repoRoot}/` : null
  const pathname = fsPrefix && url.pathname.startsWith(fsPrefix) ? `/@fs:${url.pathname.slice(fsPrefix.length)}` : url.pathname
  const where = url.host === new URL(origin).host ? "self:" : `cross:${url.protocol}//${url.host}`
  return `${kind} ${where}${pathname.slice(0, LABEL_PATH_MAX)}`
}

export async function installBrowserNetworkGuard(
  context: BrowserContext,
  policy: BrowserNetworkPolicy,
  repoRoot: string,
): Promise<BrowserNetworkGuard> {
  const staticLedger = new Map<string, { count: number; bytes: number }>()
  const businessLedger = new Map<string, { operation: string; method: string; count: number }>()
  const unknownLedger = new Map<string, { count: number }>()
  let sealed = false

  const unknown = (label: string) => {
    const entry = unknownLedger.get(label) ?? { count: 0 }
    entry.count += 1
    unknownLedger.set(label, entry)
  }
  const business = (mock: BusinessMock) => {
    const key = `${mock.operation} ${mock.method}`
    const entry = businessLedger.get(key) ?? { operation: mock.operation, method: mock.method, count: 0 }
    entry.count += 1
    businessLedger.set(key, entry)
  }
  const staticRead = (label: string, bytes: number) => {
    const entry = staticLedger.get(label) ?? { count: 0, bytes: 0 }
    entry.count += 1
    entry.bytes += bytes
    staticLedger.set(label, entry)
  }

  // Pathname only: a query never changes the decision, and forbidden or ambiguous paths lose to any allowlist entry.
  const isStatic = (pathname: string) => isAllowedBrowserStaticPath(policy, pathname)

  const refuse = async (route: Route, label: string) => {
    unknown(label)
    // Recorded first: a page that already closed cannot turn the attempt into a silent pass.
    await route.abort("blockedbyclient").catch(() => {})
  }

  // The only pass-through: this runner's own gate-mode Vite server, measured.
  // Redirects are not followed (maxRedirects: 0): a 3xx is unknown and aborted,
  // its Location and body never read or reported. A failed fetch or body read
  // is unknown (`static-read-failed`), and so is a failed hand-over to the page
  // (`static-fulfill-failed`): only a fulfilled read is measured as static. The
  // APIResponse is disposed on every path once it has been fetched.
  const passStatic = async (route: Route, label: string) => {
    let response: APIResponse
    try {
      response = await route.fetch({ maxRedirects: 0 })
    } catch {
      await refuse(route, `${label} static-read-failed`)
      return
    }
    const release = () => response.dispose().catch(() => {})
    const status = response.status()
    if (isRedirectStatus(status)) {
      await release()
      await refuse(route, `${label} redirect:${status}`)
      return
    }
    let body: Buffer
    try {
      body = await response.body()
    } catch {
      await release()
      await refuse(route, `${label} static-read-failed`)
      return
    }
    try {
      await route.fulfill({ response, body })
    } catch {
      await release()
      await refuse(route, `${label} static-fulfill-failed`)
      return
    }
    staticRead(label, body.byteLength)
    await release()
  }

  const handle = async (route: Route) => {
    const request = route.request()
    const method = request.method()
    const label = requestLabel(method, request.url(), policy.origin, repoRoot)
    const url = new URL(request.url())
    if (!sealed && url.origin === policy.origin) {
      const mock = policy.mocks.find((entry) => entry.method === method && entry.path === url.pathname)
      if (mock) {
        business(mock)
        await route.fulfill({ status: mock.status, contentType: "application/json", body: JSON.stringify(mock.json) })
        return
      }
      if (method === "GET" && !isBusinessPath(url.pathname) && isStatic(url.pathname)) {
        await passStatic(route, label)
        return
      }
    }
    await refuse(route, label)
  }

  const refuseSocket = (socket: WebSocketRoute) => {
    unknown(requestLabel("WS", socket.url(), policy.origin, repoRoot))
    void socket.close({ code: 1008, reason: "mock-network guard" }).catch(() => {})
  }

  await context.route(() => true, handle)
  await context.routeWebSocket(() => true, refuseSocket)

  return {
    seal() {
      sealed = true
    },
    unknownLabels() {
      return [...unknownLedger.keys()]
    },
    report() {
      const staticEntries = [...staticLedger].map(([label, entry]) => ({ label, ...entry }))
      const businessEntries = [...businessLedger.values()].map((entry) => ({ ...entry }))
      const unknownEntries = [...unknownLedger].map(([label, entry]) => ({ label, count: entry.count }))
      return {
        static: {
          requests: staticEntries.reduce((sum, entry) => sum + entry.count, 0),
          bytes: staticEntries.reduce((sum, entry) => sum + entry.bytes, 0),
          byLabel: staticEntries,
        },
        business: {
          calls: businessEntries.reduce((sum, entry) => sum + entry.count, 0),
          byOperation: businessEntries,
        },
        unknown: {
          attempts: unknownEntries.reduce((sum, entry) => sum + entry.count, 0),
          byLabel: unknownEntries,
        },
      }
    },
  }
}
