/**
 * Mock browser runner: the network-boundary acceptance for browser fixtures.
 *
 *   bun run web/tests/run-mock-browser.ts                      # positive, must PASS
 *   bun run web/tests/run-mock-browser.ts --scenario=negative  # must FAIL with every probe caught
 *
 * It starts its own Vite dev server from web/vite.config.ts in mock-gate mode
 * (PODHUB_MOCK_GATE=1: no env files, no Cloud proxy, no HMR socket, no Vite
 * dev client in served HTML, no console forwarding, no dependency discovery or
 * warmup) on exactly 127.0.0.1:14920 with strictPort —
 * an occupied port is an error, never a server to reuse. The only route this
 * runner adds to that server is a controlled local redirect (REDIRECT_PATH →
 * REDIRECT_TARGET_PATH) for the negative scenario; its target counts every hit
 * and must stay at 0, proving a static 3xx is never followed. It launches an already-installed Chrome (`channel: "chrome"`, or
 * PODHUB_BROWSER_EXECUTABLE) without downloading anything, opens a fresh
 * ephemeral context with Service Workers blocked, installs the context-level
 * guard (tests/mock-browser-network.ts) and only then creates the page.
 *
 * Service Worker blocking is checked, not assumed: Playwright's block turns
 * `register()` into an async no-op, so the page reports the real return,
 * registrations and controller, and the runner adds the context's own view
 * (workers announced during the run and `context.serviceWorkers()` at the end)
 * and the ledger reads of the probe's script path, which must all be 0.
 *
 * Output: one JSON evidence object on stdout (static reads with bytes, business
 * calls answered by mocks, unknown attempts — labels are method/origin/path
 * only) and one `[mock-network]` verdict line on stderr.
 *
 * Exit codes: 0 PASS · 1 FAIL — the guard saw unregistered attempts or the
 * positive check failed (the expected result of the negative scenario) ·
 * 2 ERROR — setup failed, or a negative probe escaped / was never observed;
 * not guard evidence either way · 3 overall timeout · 130/143 signal. Every exit
 * path first closes this run's page, context, browser and server with bounded
 * waits; nothing else is touched.
 */
// Shared hostile URL data: rejection probes only, never filesystem inputs or outputs.
import forbiddenPaths from "./fixtures/mock-browser-forbidden-paths.json"
import { realpathSync } from "node:fs"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { createServer, type Plugin, type ViteDevServer } from "vite"

import { ROUTES } from "../src/api/routes.ts"
import {
  installBrowserNetworkGuard,
  requestLabel,
  viteStaticPrefixes,
  type BrowserNetworkPolicy,
  type NetworkReport,
} from "./mock-browser-network.ts"
import type { MockNetworkPlan, MockNetworkResult, MockNetworkWindow, NegativeProbe } from "./mock-network.browser.ts"

type Scenario = MockNetworkPlan["scenario"]

const HOST = "127.0.0.1"
const PORT = 14920
const ORIGIN = `http://${HOST}:${PORT}`
const WEB_ROOT = path.resolve(import.meta.dirname, "..")
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
const ENTRY = "/tests/mock-network.html"
const FIXTURE_MODULE = "/tests/mock-network.browser.ts"
/** The one source module the fixture imports (`@/api/routes`; its schema import is type-only). */
const ROUTES_MODULE = "/src/api/routes.ts"
/** The committed artifact lives above the Vite root, so the dev server serves it through /@fs. */
const WASM_PATH = `/@fs${realpathSync(REPO_ROOT)}/wasm/dist/browser/listing-state.wasm`
const FIXTURE_JSON_PATH = "/tests/fixtures/listing-core/decorative-wall-art-schema.json"
/** Allowlisted static path whose answer is a 302: the guard must refuse it, not follow it. */
const REDIRECT_PATH = "/tests/mock-network-redirect"
const REDIRECT_TARGET_PATH = "/tests/mock-network-redirect-target"
/** Absent script the negative Service Worker probe registers; a blocked context never requests it. */
const SERVICE_WORKER_SCRIPT_PATH = "/tests/mock-network-sw.js"
/** The gate plugin in web/vite.config.ts that strips the injected Vite dev client. */
const NO_DEV_CLIENT_PLUGIN = "podhub-mock-gate-without-dev-client"
const DEV_CLIENT_LABEL = "GET self:/@vite/client"
/** Label the guard records for the artifact: requestLabel strips the /@fs repo prefix. */
const WASM_LABEL = `GET self:/@fs:wasm/dist/browser/listing-state.wasm`
const BUSINESS_MARKER = "mock-network-bootstrap"
/** RFC 2606 reserved name: resolves nowhere even if a request slipped past the guard. */
const PROBE_HOST = "mock-network-probe.invalid"

const RUN_TIMEOUT_MS = 120_000
const LAUNCH_TIMEOUT_MS = 30_000
const PAGE_TIMEOUT_MS = 45_000
const LATE_DELAY_MS = 150
const SETTLE_MS = 1_000
const CLEANUP_STEP_MS = 5_000

const resources: { server?: ViteDevServer; browser?: Browser; context?: BrowserContext; page?: Page } = {}
let cleaning: Promise<void> | null = null
/** Requests that reached the redirect target by any means (browser, route.fetch follow). Must stay 0. */
let redirectTargetHits = 0

function log(line: string) {
  console.error(`[mock-network] ${line}`)
}

function describeError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).split("\n", 1)[0].slice(0, 300)
}

function bounded<T>(label: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scenarioFromArgs(args: string[]): Scenario {
  const value = args.find((arg) => arg.startsWith("--scenario="))?.slice("--scenario=".length) ?? "positive"
  if (value !== "positive" && value !== "negative") throw new Error(`unknown --scenario=${value}; use positive or negative`)
  return value
}

/** Leak paths the negative scenario attempts. Same-origin paths come from the route authority. */
function negativeProbes(): NegativeProbe[] {
  return [
    { kind: "fetch", url: `${ORIGIN}${ROUTES.health}` },
    { kind: "fetch", url: `${ORIGIN}${ROUTES.listingSubmit}`, method: "POST" },
    { kind: "fetch", url: `${ORIGIN}/cpa/v1/models` },
    { kind: "fetch", url: `${ORIGIN}/v0/management/config` },
    { kind: "fetch", url: `${ORIGIN}/tests/uploads/probe.bin`, method: "PUT" },
    { kind: "fetch", url: `${ORIGIN}${REDIRECT_PATH}?next=probe` },
    // Static-boundary probes. None names a real secret: each path is either an
    // ordinary source file or absent, so even an escape would expose nothing.
    { kind: "fetch", url: `${ORIGIN}/@fs${REPO_ROOT}/web/src/api/routes.ts` },
    // The artifact prefix is anchored at wasm/dist: its parent and an encoded
    // traversal out of it are refused even though the artifact itself is admitted.
    { kind: "fetch", url: `${ORIGIN}/@fs${REPO_ROOT}/wasm/README.md` },
    { kind: "fetch", url: `${ORIGIN}/@fs${REPO_ROOT}/wasm/dist/..%2f..%2fweb/src/api/routes.ts` },
    { kind: "fetch", url: `${ORIGIN}/@fs${REPO_ROOT}/node_modules/.env.mock-network-probe` },
    { kind: "fetch", url: `${ORIGIN}${forbiddenPaths.absentTraversalProbe}` },
    { kind: "fetch", url: `https://${PROBE_HOST}/v1/probe` },
    { kind: "image", url: `https://${PROBE_HOST}/pixel.png` },
    { kind: "popup", url: `https://${PROBE_HOST}/popup` },
    { kind: "worker-fetch", url: `${ORIGIN}${ROUTES.listingRows}` },
    { kind: "worker-fetch", url: `https://${PROBE_HOST}/worker` },
    { kind: "websocket", url: `ws://${HOST}:${PORT}/` },
    { kind: "websocket", url: `wss://${PROBE_HOST}/socket` },
    { kind: "service-worker", url: `${ORIGIN}${SERVICE_WORKER_SCRIPT_PATH}` },
    { kind: "late-fetch", url: `${ORIGIN}${ROUTES.listingEvents}` },
  ]
}

/** Labels the guard must record for the negative plan. Service Worker registration is blocked before any request. */
function expectedUnknown(probes: NegativeProbe[]): string[] {
  return probes
    .filter((probe) => probe.kind !== "service-worker")
    .map((probe) => {
      const label = requestLabel(probe.kind === "websocket" ? "WS" : (probe.method ?? "GET"), probe.url, ORIGIN, REPO_ROOT)
      return new URL(probe.url).pathname === REDIRECT_PATH ? `${label} redirect:302` : label
    })
}

/**
 * Exact files the bootstrap fixture reads — not every /src module or fixture.
 * A later fixture declares its own real module set. REDIRECT_PATH is static
 * only in the negative scenario, where it proves a static 3xx is not followed.
 */
function policyFor(scenario: Scenario): BrowserNetworkPolicy {
  const fixtureFiles = [ENTRY, FIXTURE_MODULE, ROUTES_MODULE, WASM_PATH, FIXTURE_JSON_PATH]
  return {
    origin: ORIGIN,
    staticPaths: scenario === "negative" ? [...fixtureFiles, REDIRECT_PATH] : fixtureFiles,
    staticPrefixes: viteStaticPrefixes(REPO_ROOT, WEB_ROOT),
    mocks:
      scenario === "positive"
        ? [{ operation: "listingSubmit", method: "POST", path: ROUTES.listingSubmit, status: 202, json: { fixture: BUSINESS_MARKER } }]
        : [],
  }
}

/** Runner-only routes on the gate server: one local 302 and its counted target. Nothing else is added. */
function redirectProbePlugin(): Plugin {
  return {
    name: "podhub-mock-network-redirect-probe",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?", 1)[0]
        if (pathname === REDIRECT_PATH) {
          response.statusCode = 302
          response.setHeader("location", `${REDIRECT_TARGET_PATH}?token=mock-network-probe`)
          response.end()
          return
        }
        if (pathname === REDIRECT_TARGET_PATH) {
          redirectTargetHits += 1
          response.statusCode = 200
          response.end("redirect target reached")
          return
        }
        next()
      })
    },
  }
}

async function startServer(): Promise<void> {
  // The config file reads this at load time; the runner is always the gate.
  process.env.PODHUB_MOCK_GATE = "1"
  const server = await createServer({
    configFile: path.join(WEB_ROOT, "vite.config.ts"),
    root: WEB_ROOT,
    envDir: false,
    clearScreen: false,
    logLevel: "warn",
    plugins: [redirectProbePlugin()],
    server: { host: HOST, port: PORT, strictPort: true, hmr: false, ws: false, open: false },
  })
  resources.server = server
  const proxy = server.config.server.proxy
  if (server.config.envDir !== false || (proxy && Object.keys(proxy).length > 0)) {
    throw new Error("web/vite.config.ts did not apply the mock gate (envDir:false and no Cloud proxy)")
  }
  // Not overridden inline above, so these read what web/vite.config.ts itself decided in gate mode.
  const warmed = server.config.server.warmup?.clientFiles?.length ?? 0
  if (server.config.optimizeDeps.noDiscovery !== true || warmed > 0) {
    throw new Error("web/vite.config.ts did not apply the mock gate (no dependency discovery, no warmup)")
  }
  if (server.config.server.forwardConsole.enabled || !server.config.plugins.some((plugin) => plugin.name === NO_DEV_CLIENT_PLUGIN)) {
    throw new Error("web/vite.config.ts did not apply the mock gate (no console forwarding, no Vite dev client in HTML)")
  }
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string" || address.port !== PORT || address.address !== HOST) {
    throw new Error(`gate server is not bound to exactly ${HOST}:${PORT}`)
  }
}

async function launchBrowser(): Promise<void> {
  const executablePath = process.env.PODHUB_BROWSER_EXECUTABLE
  try {
    resources.browser = await chromium.launch({
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
    })
  } catch (error) {
    throw new Error(`dependency block: no usable installed browser (set PODHUB_BROWSER_EXECUTABLE; nothing is downloaded): ${describeError(error)}`)
  }
}

/** The context's own view of Service Workers; every count must be 0. */
type ContextServiceWorkers = { atStart: number; announced: number; atEnd: number }

type ScenarioOutcome = {
  result: MockNetworkResult
  serviceWorkers: ContextServiceWorkers
  report: () => NetworkReport
  unknownLabels: () => string[]
}

async function runScenario(scenario: Scenario): Promise<ScenarioOutcome> {
  const context = await resources.browser!.newContext({ serviceWorkers: "block", acceptDownloads: false })
  resources.context = context
  const serviceWorkers: ContextServiceWorkers = { atStart: context.serviceWorkers().length, announced: 0, atEnd: 0 }
  context.on("serviceworker", () => {
    serviceWorkers.announced += 1
  })
  const guard = await installBrowserNetworkGuard(context, policyFor(scenario), REPO_ROOT)
  const page = await context.newPage()
  resources.page = page

  await page.goto(`${ORIGIN}${ENTRY}`, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS })
  await page.waitForFunction(() => (window as unknown as MockNetworkWindow).__mockNetworkReady === true, undefined, {
    timeout: PAGE_TIMEOUT_MS,
  })
  const plan: MockNetworkPlan =
    scenario === "positive"
      ? { scenario, businessMarker: BUSINESS_MARKER }
      : { scenario, probes: negativeProbes(), lateDelayMs: LATE_DELAY_MS }
  const result = await bounded(
    "fixture run",
    page.evaluate((input) => (window as unknown as MockNetworkWindow).__mockNetworkRun!(input), plan),
    PAGE_TIMEOUT_MS,
  )
  // Late attempts must land in the ledger before teardown stops the fixture's timers.
  await sleep(SETTLE_MS)
  serviceWorkers.atEnd = context.serviceWorkers().length
  await bounded("fixture teardown", page.evaluate(() => (window as unknown as MockNetworkWindow).__mockNetworkTeardown?.()), CLEANUP_STEP_MS)
  guard.seal()
  return { result, serviceWorkers, report: () => guard.report(), unknownLabels: () => guard.unknownLabels() }
}

/**
 * Service Worker problems, empty when blocking held. Every run needs a clean
 * context and 0 reads of the probe script (static or unknown); the negative run
 * additionally needs the page's own evidence to show the blocked path was
 * exercised with no registration or controller.
 */
function serviceWorkerProblems(scenario: Scenario, outcome: ScenarioOutcome, report: NetworkReport): string[] {
  const { atStart, announced, atEnd } = outcome.serviceWorkers
  const scriptLabel = `GET self:${SERVICE_WORKER_SCRIPT_PATH}`
  const scriptReads = [...report.static.byLabel, ...report.unknown.byLabel]
    .filter((entry) => entry.label === scriptLabel || entry.label.startsWith(`${scriptLabel} `))
    .reduce((sum, entry) => sum + entry.count, 0)
  const problems = [
    atStart + announced + atEnd === 0 ? null : `context saw Service Workers (start=${atStart} announced=${announced} end=${atEnd})`,
    scriptReads === 0 ? null : `Service Worker script requested ${scriptReads} time(s)`,
  ]
  const page = outcome.result.serviceWorker
  if (scenario === "negative" && !page) problems.push("page reported no Service Worker evidence")
  if (scenario === "negative" && page) {
    // Playwright's block resolves register() to undefined; anything else did not take the blocked path.
    if (page.registerReturned !== "undefined") problems.push(`register() returned ${page.registerReturned}, not the blocked no-op`)
    if (page.registrations !== 0) problems.push(`page registrations=${page.registrations ?? "unreadable"}`)
    if (page.controlled) problems.push("page is controlled by a Service Worker")
  }
  return problems.filter((problem): problem is string => problem !== null)
}

function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    const steps: [string, () => Promise<unknown> | undefined][] = [
      ["close context", () => resources.context?.close()],
      ["close browser", () => resources.browser?.close()],
      ["close gate server", () => resources.server?.close()],
    ]
    for (const [label, step] of steps) {
      try {
        const work = step()
        if (work) await bounded(label, work, CLEANUP_STEP_MS)
      } catch (error) {
        log(`cleanup: ${describeError(error)}`)
      }
    }
  })()
  return cleaning
}

async function finish(code: number): Promise<never> {
  await cleanup()
  process.exit(code)
}

type Verdict = { exitCode: 0 | 1 | 2; line: string; missingUnknown: string[] }

function judge(scenario: Scenario, outcome: ScenarioOutcome, report: NetworkReport): Verdict {
  const { result } = outcome
  const serviceWorker = serviceWorkerProblems(scenario, outcome, report)
  if (scenario === "positive") {
    const staticLabels = new Set(report.static.byLabel.map((entry) => entry.label))
    const problems = [
      result.ok ? null : `page check failed (${result.failure ?? "no reason"})`,
      report.unknown.attempts === 0 ? null : `${report.unknown.attempts} unknown attempt(s)`,
      staticLabels.has(DEV_CLIENT_LABEL) ? "the Vite dev client was served to the gate page" : null,
      staticLabels.has(WASM_LABEL) ? null : "WASM was not read as a measured static asset",
      staticLabels.has(`GET self:${FIXTURE_JSON_PATH}`) ? null : "fixture JSON was not read as a measured static asset",
      report.business.calls === 1 ? null : `expected 1 mocked business call, saw ${report.business.calls}`,
      redirectTargetHits === 0 ? null : `redirect target reached ${redirectTargetHits} time(s)`,
      ...serviceWorker,
    ].filter((problem): problem is string => problem !== null)
    return problems.length === 0
      ? { exitCode: 0, line: `PASS unknown=0 static=${report.static.requests}/${report.static.bytes}B business=${report.business.calls}`, missingUnknown: [] }
      : { exitCode: 1, line: `FAIL ${problems.join("; ")}`, missingUnknown: [] }
  }
  const expected = expectedUnknown(negativeProbes())
  const seen = new Set(outcome.unknownLabels())
  const missingUnknown = expected.filter((label) => !seen.has(label))
  // Any of these means a probe escaped or never ran: never a PASS, never guard evidence.
  const escapes = [
    result.ok ? null : `page saw a real answer (${result.failure ?? "?"})`,
    missingUnknown.length === 0 ? null : `${missingUnknown.length} probe(s) not observed by the guard`,
    report.business.calls === 0 ? null : `${report.business.calls} business call(s) answered`,
    redirectTargetHits === 0 ? null : `static redirect followed to its target ${redirectTargetHits} time(s)`,
    ...serviceWorker.map((problem) => `Service Worker block not proven: ${problem}`),
  ].filter((escape): escape is string => escape !== null)
  if (escapes.length > 0) {
    return { exitCode: 2, line: `ERROR negative scenario escaped or was not exercised: ${escapes.join("; ")}`, missingUnknown }
  }
  return {
    exitCode: 1,
    line: `FAIL unknown=${report.unknown.attempts} — all ${expected.length} negative probes caught although the page swallowed them (expected for --scenario=negative)`,
    missingUnknown,
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    log(`ERROR run exceeded ${RUN_TIMEOUT_MS}ms`)
    void finish(3)
  }, RUN_TIMEOUT_MS)
  process.once("SIGINT", () => void finish(130))
  process.once("SIGTERM", () => void finish(143))

  let scenario: Scenario = "positive"
  let outcome: ScenarioOutcome
  try {
    scenario = scenarioFromArgs(process.argv.slice(2))
    await startServer()
    await launchBrowser()
    outcome = await runScenario(scenario)
  } catch (error) {
    clearTimeout(watchdog)
    log(`ERROR ${scenario}: ${describeError(error)}`)
    return finish(2)
  }
  await cleanup()
  clearTimeout(watchdog)

  const report = outcome.report()
  const verdict = judge(scenario, outcome, report)
  console.log(
    JSON.stringify(
      {
        runner: "mock-network",
        origin: ORIGIN,
        scenario,
        exitCode: verdict.exitCode,
        page: outcome.result,
        contextServiceWorkers: outcome.serviceWorkers,
        network: report,
        missingUnknown: verdict.missingUnknown,
        redirectTargetHits,
      },
      null,
      2,
    ),
  )
  log(verdict.line)
  process.exit(verdict.exitCode)
}

await main()
