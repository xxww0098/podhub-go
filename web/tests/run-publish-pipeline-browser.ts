/** Coordinator only: run through the supplied no-env/native sandbox wrapper.
 * Never downloads, builds, invokes a shell, or reuses an occupied server port.
 * Evidence defaults to the ignored output/publish-pipeline/browser directory;
 * --output-root selects an operator-owned artifact destination. */
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { Browser, BrowserContext } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"
import { installBrowserNetworkGuard } from "./mock-browser-network"
import { pipelineNetworkPolicy } from "./publish-pipeline-browser-static"
import { pendingDependencies, scenarios, type ScenarioResult } from "./publish-pipeline-browser-contract"
import { assertPipelineBrowserSafety, parsePipelineBrowserOptions } from "./publish-pipeline-browser-safety"
import { createPipelineBrowserServerGuard, PIPELINE_BROWSER_ORIGIN, PIPELINE_CSP_NONCE_PLACEHOLDER } from "./publish-pipeline-browser-server"
const repoRoot = path.resolve(import.meta.dirname, "../.."), webRoot = path.join(repoRoot, "web")
/** The compiled artifact sits above the Vite root, so it is served through /@fs and labelled repo-relative. */
const COMPILED_WASM_LABEL = "GET self:/@fs:wasm/dist/browser/listing-state.wasm"
const origin = PIPELINE_BROWSER_ORIGIN
let server: ViteDevServer | undefined, browser: Browser | undefined, context: BrowserContext | undefined
let serverGuard: ReturnType<typeof createPipelineBrowserServerGuard> | undefined, closing = false
let cleanupPromise: Promise<void> | undefined
const cleanupErrors: string[] = []
let activeTrace: ReturnType<typeof import("./publish-pipeline-browser-trace").createPipelineBrowserTrace> | undefined
async function evidenceHashes() {
  const { sourceHashes } = await import("./publish-pipeline-browser-evidence")
  const safety = "web/tests/publish-pipeline-browser-safety.ts"
  const serverBoundary = "web/tests/publish-pipeline-browser-server.ts"
  return { ...await sourceHashes(repoRoot), ...Object.fromEntries(await Promise.all([safety, serverBoundary].map(async (file) =>
    [file, createHash("sha256").update(await readFile(path.join(repoRoot, file))).digest("hex")]))) }
}
function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms) })]).finally(() => clearTimeout(timer))
}
function cleanup() {
  closing = true
  return cleanupPromise ??= (async () => {
    // Trace drains to its immutable artifacts before any owned page/context closes.
    if (activeTrace) await activeTrace.finish("runner cleanup before scenario finalization")
    for (const close of [() => context?.close(), () => browser?.close(), () => server?.close()]) {
      try { await bounded(Promise.resolve(close()), 5000, "cleanup") } catch { cleanupErrors.push("owned resource cleanup failed or exceeded five seconds") }
    }
  })()
}
async function start() {
  process.env.PODHUB_MOCK_GATE = "1"
  serverGuard = createPipelineBrowserServerGuard(pipelineNetworkPolicy(origin, repoRoot), repoRoot)
  const created = await createServer({ configFile: path.join(webRoot, "vite.config.ts"), root: webRoot, envDir: false, clearScreen: false, logLevel: "warn",
    appType: "mpa", publicDir: false, html: { cspNonce: PIPELINE_CSP_NONCE_PLACEHOLDER },
    server: { host: "127.0.0.1", port: 14921, strictPort: true, hmr: false, ws: false, open: false, cors: false, watch: null } })
  if (closing) { await created.close(); throw new Error("startup cancelled") }
  server = created
  assertPipelineBrowserSafety(server.config)
  serverGuard.install(server)
  await server.listen()
  if (closing) { await server.close(); throw new Error("startup cancelled") }
  const address = server.httpServer?.address()
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port !== 14921) throw new Error("strict loopback bind failed")
}

async function serve(outputRoot: string): Promise<void> {
  // Deliberately independent of evidence helpers: those hash/import the business
  // closure. Native infrastructure serving must never open that closure itself.
  await mkdir(outputRoot, { recursive: true })
  const directory = path.join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`)
  await mkdir(directory)
  const startArtifact = path.join(directory, "serve-start.json"), reportArtifact = path.join(directory, "serve-report.json")
  const report = { mode: "serve", url: `${origin}/tests/publish-pipeline.html`, pid: process.pid, directory, startArtifact, reportArtifact,
    startedAt: new Date().toISOString(), stoppedAt: null as string | null, status: "starting", setupErrors: [] as string[],
    pending: pendingDependencies, fullGoalAcceptance: false, businessAcceptance: false, cleanupErrors }
  let finished = false
  const terminate = async (code: number, status: string) => {
    if (finished) return
    finished = true; report.status = status; report.stoppedAt = new Date().toISOString()
    await cleanup()
    try {
      await bounded(writeFile(reportArtifact, JSON.stringify({ ...report, serverNetwork: serverGuard?.report() ?? null }, null, 2), { flag: "wx" }), 5000, "serve artifact")
    } catch { report.setupErrors.push("serve report write failed or exceeded five seconds"); code = 2 }
    console.log(JSON.stringify({ mode: "serve", pid: process.pid, status, report: reportArtifact, fullGoalAcceptance: false, businessAcceptance: false }))
    process.exit(cleanupErrors.length ? 2 : code)
  }
  process.once("SIGINT", () => void terminate(130, "SIGINT"))
  process.once("SIGTERM", () => void terminate(143, "SIGTERM"))
  try {
    await bounded(start(), 45_000, "startup")
    if (finished) return
    report.status = "listening"
    await bounded(writeFile(startArtifact, JSON.stringify(report, null, 2), { flag: "wx" }), 5000, "serve startup artifact")
    if (finished) return
    console.log(JSON.stringify(report))
    // The owned HTTP server keeps this process alive; there is no browser or
    // business scenario execution, idle expiry, hash read or acceptance result.
  } catch {
    report.setupErrors.push("safe fixture server startup failed")
    await terminate(2, "failed")
  }
}
async function main() {
  const options = parsePipelineBrowserOptions(process.argv.slice(2))
  const outputRoot = path.resolve(options.outputRoot ?? path.join(repoRoot, "output/publish-pipeline/browser"))
  if (options.mode === "serve") { await serve(outputRoot); return }
  const selected = options.scenario
  if (selected !== "all" && !scenarios.some((name) => name === selected)) throw new Error("Unknown scenario")
  const { newOutputDirectory, screenshots, saveScenario } = await import("./publish-pipeline-browser-evidence")
  const { driveScenario, readEvidence } = await import("./publish-pipeline-browser-scenarios")
  const { waitForPage } = await import("./publish-pipeline-browser-wait")
  const { createPipelineBrowserTrace, unobservedOperation, PIPELINE_TRACE_LATE_DRAIN_MS } = await import("./publish-pipeline-browser-trace")
  const traceEnabled = process.env.PUBLISH_PIPELINE_TRACE === "1"
  const { chromium } = await import("playwright-core")
  const directory = await newOutputDirectory(outputRoot)
  const results: ScenarioResult[] = scenarios.map((name) => ({ name, status: "pending", problems: ["not exercised"], artifacts: [], screenshots: [], console: [], pageErrors: [] }))
  const report = { runner: "publish-pipeline", origin, directory, selected, traceMode: traceEnabled ? "chrome-cdp" : "disabled", browserVersion: "unavailable", startedAt: new Date().toISOString(),
    hashesBefore: {} as Record<string, string>, hashesAfter: {} as Record<string, string>, setupErrors: [] as string[], scenarios: results,
    pending: pendingDependencies, cleanupErrors, serverNetwork: null as ReturnType<NonNullable<typeof serverGuard>["report"]> | null,
    executionSuccess: false, implementedMatrixComplete: false, fullGoalAcceptance: false, status: "incomplete" }
  let finished = false
  const save = async () => { await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" }) }
  const terminate = async (code: number, reason: string) => {
    if (finished) return
    finished = true; report.setupErrors.push(reason)
    await cleanup(); await save(); process.exit(code)
  }
  const watchdog = setTimeout(() => void terminate(3, "total run exceeded 600 seconds"), 600_000)
  process.once("SIGINT", () => void terminate(130, "interrupted"))
  process.once("SIGTERM", () => void terminate(143, "terminated"))
  try {
    report.hashesBefore = await evidenceHashes()
    await bounded(start(), 45_000, "startup")
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 30_000 })
    report.browserVersion = browser!.version()
    for (const name of scenarios) {
      const result = results.find((entry) => entry.name === name)!
      if (selected !== "all" && selected !== name) { result.problems.push("not selected / not exercised"); continue }
      result.problems = []
      context = await browser!.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1100 } })
      let workers = 0
      context.on("serviceworker", () => workers++)
      const guard = await installBrowserNetworkGuard(context, pipelineNetworkPolicy(origin, repoRoot), repoRoot)
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      page.on("pageerror", (error) => result.pageErrors.push(error.message))
      page.on("console", (message) => { if (["error", "warning", "warn"].includes(message.type()) || /react.*warning|warning.*react/i.test(message.text())) result.console.push({ type: message.type(), text: message.text() }) })
      const trace = traceEnabled ? createPipelineBrowserTrace(page, () => context!.newCDPSession(page), { directory, name, artifacts: result.artifacts, problems: result.problems }) : undefined
      activeTrace = trace
      const operation = trace?.operation ?? unobservedOperation
      try {
        if (trace) await trace.start()
        await operation("navigation", () => page.goto(`${origin}/tests/publish-pipeline.html`, { waitUntil: "load", timeout: 45_000 }))
        await operation("complete-scenario", () => bounded(driveScenario(page, name, screenshots(page, directory, result, operation), operation), 100_000, name))
        // Export uses the same readonly source as the runner, through a real DOM action.
        await operation("scenario-export", async () => {
          const download = page.waitForEvent("download", { timeout: 10_000 })
          await page.getByRole("button", { name: "导出测量 JSON", exact: true }).click()
          await (await download).saveAs(path.join(directory, `${name}-export.json`))
          result.artifacts.push(`${name}-export.json`)
          await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "evidence-export" && entry.end !== undefined), undefined)
        })
        result.status = "passed"
      } catch (error) { result.status = "failed"; result.problems.push(error instanceof Error ? error.message : String(error)) }
      finally {
        try {
          if (trace) await operation("late-observer-drain", () => page.waitForTimeout(PIPELINE_TRACE_LATE_DRAIN_MS))
          result.evidence = await operation("final-evidence-read", () => bounded(readEvidence(page), 5000, "evidence read"))
        } catch { /* bootstrap failure stays a failure; trace operation records the failed boundary */ }
        if (trace) await trace.finish()
        activeTrace = undefined
        if (workers || context.serviceWorkers().length) result.problems.push("Service Worker observed")
        try { await bounded(context.close(), 5000, "scenario context cleanup") } catch { result.problems.push("context cleanup failed") }
        guard.seal(); result.network = guard.report()
        if (!result.network.static.byLabel.some((entry) => entry.label === COMPILED_WASM_LABEL && entry.bytes > 0)) result.problems.push("no measured compiled WASM load")
        await saveScenario(directory, result)
        context = undefined
      }
    }
    report.hashesAfter = await evidenceHashes()
    if (JSON.stringify(report.hashesBefore) !== JSON.stringify(report.hashesAfter)) report.setupErrors.push("source changed during evidence run")
    report.executionSuccess = results.filter((result) => result.status !== "pending").every((result) => result.status === "passed") && report.setupErrors.length === 0
    report.implementedMatrixComplete = results.length === scenarios.length && results.every((result) => result.status === "passed")
  } catch (error) { report.setupErrors.push(error instanceof Error ? error.message : String(error)) }
  finally { clearTimeout(watchdog); await cleanup(); report.serverNetwork = serverGuard?.report() ?? null }
  if (finished) return
  finished = true
  if (report.serverNetwork?.denied) { report.setupErrors.push("server boundary refused network attempts"); report.executionSuccess = false }
  if (cleanupErrors.length) report.executionSuccess = false
  await save()
  console.log(JSON.stringify({ directory, report: path.join(directory, "report.json"), executionSuccess: report.executionSuccess, implementedMatrixComplete: report.implementedMatrixComplete, fullGoalAcceptance: false, status: "incomplete" }))
  // 0 means this complete independent matrix passed, never full-goal acceptance.
  process.exit(report.setupErrors.length ? 2 : report.executionSuccess && report.implementedMatrixComplete ? 0 : 1)
}
await main().catch(async (error) => { console.error(String(error)); await cleanup(); process.exit(2) })
