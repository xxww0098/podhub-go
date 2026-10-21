/**
 * Default-deny network bootstrap for the workspace test script.
 *
 * The `test` script in web/package.json runs
 * `bun test --preload ./tests/network-guard.preload.ts --parallel`, so Bun
 * evaluates this file before any test module — in each isolated worker that
 * `--parallel` starts, not once for the whole run. The root `bun run test` /
 * `bun run check` reach that script through the workspaces chain. A bare
 * `bun test` without the flag is NOT guarded: a targeted direct run must pass
 * `--preload ./tests/network-guard.preload.ts` itself (web/bunfig.toml is a
 * protected file this workspace does not use for the preload).
 *
 * From then on `globalThis.fetch` is a guard:
 *
 * - `blob:` / `data:` URLs are local objects and go to the private native fetch;
 * - an exact loopback origin a test registered via `allowOrigin` — literal
 *   `127.0.0.1` or `[::1]` with the explicit port of a fake the test itself
 *   started — goes to the native fetch until revoked, with redirects never
 *   followed (a 3xx answer is recorded and rejected, Location unread);
 * - everything else — relative API paths, `localhost`, any unregistered
 *   loopback port, remote hosts, `file:` — is recorded as a violation and rejected.
 *
 * A violation is never cleared by the caller catching the rejection: the global
 * afterEach fails the test that made it, and beforeEach / afterAll plus an exit
 * hook fail the run for attempts made at module load or by late tasks. Messages
 * carry only method, protocol, host and path (no query, body or headers).
 *
 * bun test runs every file in one process. A timer scheduled by one test keeps
 * running into the next file, and a POST it makes is then recorded against
 * whichever test is current. afterEach drops timers that test started and
 * releases the shared error-delivery singleton so the later file is not blamed.
 *
 * `fetch` stays a plain writable global so the existing per-test stubs keep
 * working; whatever they save and restore is this guard, never native HTTP.
 * `WebSocket` / `EventSource` constructors are refused the same way when the
 * runtime provides them. This is not a socket firewall: node:http / node:net
 * clients and child processes are outside what a fetch preload can see.
 *
 * Tests reach the guard through `Symbol.for("podhub.network-guard")` with a
 * type-only import of `NetworkGuard` — never a value import, which would
 * install the guard itself and hide a test script that stopped preloading it.
 */

import { releaseErrorDelivery } from "@/lib/error-telemetry"

type Violation = { label: string; testSeq: number; expected: boolean; reported: boolean }
type Registration = { origin: string; testSeq: number }
type Hook = (fn: () => void) => void

export type NetworkGuard = {
  /** The deny-by-default fetch installed as `globalThis.fetch`. */
  readonly fetch: typeof fetch
  /**
   * Allow one exact loopback origin (a fake this test created) — `http(s)://127.0.0.1:<port>`
   * or `http(s)://[::1]:<port>`, explicit port, nothing else; returns the revoke.
   */
  allowOrigin(origin: string): () => void
  /** Record a request a mock handler does not know; it fails the test like a blocked fetch. */
  recordUnregistered(label: string): void
  /**
   * Guard self-tests only: run `body`, return the labels it was blocked on and
   * mark exactly those as expected. Not for business tests — an unregistered
   * attempt there must fail.
   */
  captureBlocked(body: () => Promise<void> | void): Promise<string[]>
  snapshot(): { allowedOrigins: string[]; unreported: number; total: number }
}

type GuardState = NetworkGuard & {
  violations: Violation[]
  registrations: Registration[]
  testSeq: number
  inTest: boolean
  capture: string[] | null
}

const GUARD_KEY = Symbol.for("podhub.network-guard")
const LOCAL_PROTOCOLS = new Set(["blob:", "data:"])
// Literal loopback addresses only: `localhost` or any other name would need DNS.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]"])
// Bun fetch options that pick another destination than the URL (a Unix socket or a proxy).
const DESTINATION_OPTIONS = ["unix", "proxy"] as const
const PATH_LABEL_MAX = 96
const MARKER = "[network-guard]"
const globals = globalThis as unknown as Record<string | symbol, unknown>

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function pathOnly(raw: string): string {
  return raw.split(/[?#]/, 1)[0].slice(0, PATH_LABEL_MAX)
}

/** Public label: method, protocol, host and path. Query, fragment and userinfo are dropped. */
function safeLabel(method: string, raw: string): string {
  const url = parseUrl(raw)
  if (!url) return `${method} relative:${pathOnly(raw)}`
  if (LOCAL_PROTOCOLS.has(url.protocol)) return `${method} ${url.protocol}`
  return `${method} ${url.protocol}//${url.host}${pathOnly(url.pathname)}`
}

function requestParts(input: Parameters<typeof fetch>[0], init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string") return { url: input, method: (init?.method ?? "GET").toUpperCase() }
  if (input instanceof URL) return { url: input.href, method: (init?.method ?? "GET").toUpperCase() }
  return { url: input.url, method: (init?.method ?? input.method).toUpperCase() }
}

/**
 * The exact origin `raw` spells, or null. `raw` must already be its own origin
 * (no path, userinfo, trailing slash or alternative spelling such as `127.1`),
 * on a literal loopback host, with an explicit port — so a default-port alias
 * (`http://127.0.0.1`, `:80`, `:443`) never opens anything.
 */
function exactLoopbackOrigin(raw: string): string | null {
  const url = parseUrl(raw)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null
  if (!LOOPBACK_HOSTNAMES.has(url.hostname) || url.port === "" || url.origin !== raw) return null
  return url.origin
}

function destinationOption(init?: RequestInit): string | null {
  if (!init) return null
  const options = init as Record<string, unknown>
  return DESTINATION_OPTIONS.find((name) => options[name] !== undefined) ?? null
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400 && response.status !== 304)
}

function summarize(violations: Violation[]): string {
  const counts = new Map<string, number>()
  for (const violation of violations) counts.set(violation.label, (counts.get(violation.label) ?? 0) + 1)
  return [...counts].map(([label, count]) => `${label} ×${count}`).join("; ")
}

function install(): GuardState {
  const nativeFetch = globalThis.fetch.bind(globalThis)

  const record = (label: string) => {
    const expected = state.capture !== null
    state.capture?.push(label)
    state.violations.push({ label, testSeq: state.inTest ? state.testSeq : 0, expected, reported: expected })
  }

  const guardedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { url, method } = requestParts(input, init)
    const parsed = parseUrl(url)
    if (parsed && LOCAL_PROTOCOLS.has(parsed.protocol)) return nativeFetch(input, init)
    // Exact origin only: a registered 127.0.0.1:<port> does not open localhost:<port> or another port.
    const origin = parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.origin : null
    const label = safeLabel(method, url)
    if (origin && state.registrations.some((registration) => registration.origin === origin)) {
      const option = destinationOption(init)
      if (!option) return fetchAllowed(input, init, label)
      return refuse(`${label} option:${option}`)
    }
    return refuse(label)
  }) as typeof fetch

  const refuse = (label: string) => {
    record(label)
    return Promise.reject(new TypeError(`${MARKER} blocked unregistered network attempt: ${label}`))
  }

  // Redirects are never followed, whatever the caller or a Request object asks:
  // the Location target — even another allowed origin — gets no request. The
  // 3xx is recorded like any unregistered attempt; Location and body are not read.
  const fetchAllowed = async (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, label: string) => {
    const response = await nativeFetch(new Request(input, { ...init, redirect: "manual" }), { redirect: "manual" })
    if (!isRedirect(response)) return response
    await response.body?.cancel().catch(() => {})
    const redirected = `${label} redirect:${response.status}`
    record(redirected)
    throw new TypeError(`${MARKER} blocked redirect from an allowed origin, not followed: ${redirected}`)
  }

  const state: GuardState = {
    fetch: guardedFetch,
    violations: [],
    registrations: [],
    testSeq: 0,
    inTest: false,
    capture: null,
    allowOrigin(origin) {
      if (exactLoopbackOrigin(origin) === null) {
        throw new Error(`${MARKER} allowOrigin needs one exact loopback http(s) origin with its port, got ${safeLabel("-", origin)}`)
      }
      const registration = { origin, testSeq: state.inTest ? state.testSeq : 0 }
      state.registrations.push(registration)
      return () => {
        state.registrations = state.registrations.filter((entry) => entry !== registration)
      }
    },
    recordUnregistered(label) {
      record(pathOnly(label))
    },
    async captureBlocked(body) {
      if (state.capture !== null) throw new Error(`${MARKER} captureBlocked does not nest`)
      const labels: string[] = []
      state.capture = labels
      try {
        await body()
      } finally {
        state.capture = null
      }
      return labels
    },
    snapshot() {
      return {
        allowedOrigins: state.registrations.map((registration) => registration.origin),
        unreported: state.violations.filter((violation) => !violation.reported).length,
        total: state.violations.length,
      }
    },
  }

  globalThis.fetch = guardedFetch
  refuseConstructor("WebSocket", record)
  refuseConstructor("EventSource", record)
  refuseBunFetch(guardedFetch)
  return state
}

/** Replace a present network constructor with one that records and throws; absent ones stay absent. */
function refuseConstructor(name: "WebSocket" | "EventSource", record: (label: string) => void) {
  if (typeof globals[name] !== "function") return
  const refused = function (url: string | URL) {
    const label = safeLabel(name, String(url))
    record(label)
    throw new TypeError(`${MARKER} blocked unregistered network attempt: ${label}`)
  }
  Object.defineProperty(globalThis, name, { value: refused, writable: true, configurable: true })
}

/** `Bun.fetch` is a second handle on the native client; point it at the guard when the runtime allows. */
function refuseBunFetch(guardedFetch: typeof fetch) {
  const bun = globals.Bun as Record<string, unknown> | undefined
  if (!bun || typeof bun.fetch !== "function") return
  try {
    Object.defineProperty(bun, "fetch", { value: guardedFetch, writable: true, configurable: true })
  } catch {
    // A non-configurable Bun.fetch cannot be replaced; web code never calls it
    // (it targets the browser), so the global fetch guard remains the boundary.
  }
}

function failUnreported(violations: Violation[], where: string): void {
  if (violations.length === 0) return
  for (const violation of violations) violation.reported = true
  throw new Error(`${MARKER} FAIL: ${violations.length} unregistered network attempt(s) ${where}, caught or not: ${summarize(violations)}`)
}

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)
const nativeSetInterval = globalThis.setInterval.bind(globalThis)
const nativeClearInterval = globalThis.clearInterval.bind(globalThis)
type Timer = ReturnType<typeof setTimeout>
const timersBySeq = new Map<number, Set<Timer>>()
const intervalsBySeq = new Map<number, Set<Timer>>()

function track(bucket: Map<number, Set<Timer>>, seq: number, id: Timer) {
  let set = bucket.get(seq)
  if (!set) {
    set = new Set()
    bucket.set(seq, set)
  }
  set.add(id)
}

function untrack(id: Timer) {
  for (const bucket of [timersBySeq, intervalsBySeq]) {
    for (const set of bucket.values()) set.delete(id)
  }
}

function clearOwned(seq: number) {
  for (const id of timersBySeq.get(seq) ?? []) nativeClearTimeout(id)
  for (const id of intervalsBySeq.get(seq) ?? []) nativeClearInterval(id)
  timersBySeq.delete(seq)
  intervalsBySeq.delete(seq)
}

function installTimerFence(guard: GuardState) {
  const seqNow = () => (guard.inTest ? guard.testSeq : 0)
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const seq = seqNow()
    let id!: Timer
    id = nativeSetTimeout(() => {
      timersBySeq.get(seq)?.delete(id)
      if (typeof fn === "function") Reflect.apply(fn, globalThis, args)
    }, ms)
    track(timersBySeq, seq, id)
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id) => {
    untrack(id as Timer)
    nativeClearTimeout(id)
  }) as typeof clearTimeout
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const seq = seqNow()
    const id = nativeSetInterval(fn, ms, ...args)
    track(intervalsBySeq, seq, id as unknown as Timer)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id) => {
    untrack(id as Timer)
    nativeClearInterval(id)
  }) as typeof clearInterval
}

const existing = globals[GUARD_KEY] as GuardState | undefined
if (!existing) {
  const guard = install()
  globals[GUARD_KEY] = guard
  installTimerFence(guard)
  await registerHooks(guard)
}

/**
 * Global hooks come from `bun:test`: preload-level hooks there apply to every
 * test in the file, and Bun's node:test (what the suites import) runs on the
 * same runner. The specifier is a variable so tsc — which only has node types —
 * does not try to resolve it.
 */
async function registerHooks(guard: GuardState) {
  const specifier: string = "bun:test"
  const hooks = (await import(specifier)) as { beforeEach: Hook; afterEach: Hook; afterAll: Hook }

  hooks.beforeEach(() => {
    guard.testSeq += 1
    guard.inTest = true
    failUnreported(
      guard.violations.filter((violation) => !violation.reported),
      "outside any test (module load or a late task of an earlier test)",
    )
  })

  hooks.afterEach(() => {
    // Drop the shared inbox timer before the next file's test is current.
    releaseErrorDelivery()
    clearOwned(guard.testSeq)
    guard.inTest = false
    const leaked = guard.registrations.filter((registration) => registration.testSeq === guard.testSeq)
    guard.registrations = guard.registrations.filter((registration) => registration.testSeq !== guard.testSeq)
    failUnreported(
      guard.violations.filter((violation) => !violation.reported && violation.testSeq === guard.testSeq),
      "in this test",
    )
    if (leaked.length > 0) throw new Error(`${MARKER} FAIL: ${leaked.length} allowed origin(s) not revoked by the test that registered them`)
  })

  hooks.afterAll(() => {
    const leaked = guard.registrations.length
    guard.registrations = []
    failUnreported(
      guard.violations.filter((violation) => !violation.reported),
      "outside any test (module load or a late task)",
    )
    if (leaked > 0) throw new Error(`${MARKER} FAIL: ${leaked} file-level allowed origin(s) not revoked`)
  })

  // Anything arriving after the last hook still fails the process.
  process.on("exit", () => {
    const late = guard.violations.filter((violation) => !violation.reported)
    if (late.length === 0) return
    process.exitCode = 1
    console.error(`${MARKER} FAIL: ${late.length} unregistered network attempt(s) after the last test hook: ${summarize(late)}`)
  })
}
