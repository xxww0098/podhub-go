import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "playwright-core"
import { sourceFiles } from "./publish-pipeline-browser-static"
import { readEvidence } from "./publish-pipeline-browser-scenarios"
import { performanceProblems, type ScenarioResult } from "./publish-pipeline-browser-contract"
import { unobservedOperation, type RunnerOperation } from "./publish-pipeline-browser-trace"
export async function sourceHashes(repoRoot: string) {
  const paths = [...sourceFiles, "web/tests/run-publish-pipeline-browser.ts", "web/tests/publish-pipeline-browser-scenarios.ts",
    "web/tests/publish-pipeline-browser-static.ts", "web/tests/publish-pipeline-browser-evidence.ts", "web/tests/publish-pipeline-browser-contract.ts",
    "web/tests/publish-pipeline-diagnostic-scenarios.ts", "web/tests/publish-pipeline-workbench-scenarios.ts", "web/tests/publish-pipeline-browser-wait.ts",
    "web/tests/publish-pipeline-keepalive-scenarios.ts",
    "web/tests/publish-pipeline-browser-trace.ts",
    "web/tests/publish-pipeline-reconcile-scenarios.ts",
    "package.json", "web/package.json", "bun.lock", "web/tests/mock-browser-network.ts", "web/vite.config.ts", "web/vite.product-version.ts", "web/src/api/schema.d.ts",
    "rust/crates/listing-core-wasm/tests/fixtures/ambient/known-issue-manifest-golden.json"]
  return Object.fromEntries(await Promise.all(paths.map(async (file) => [file, createHash("sha256").update(await readFile(path.join(repoRoot, file))).digest("hex")])))
}
export async function newOutputDirectory(root: string) {
  await mkdir(root, { recursive: true })
  const directory = path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`)
  await mkdir(directory) // no recursive: a collision is an error
  return directory
}
export function screenshots(page: Page, directory: string, result: ScenarioResult, operation: RunnerOperation = unobservedOperation) {
  return async (label: string) => {
    return operation(`screenshot:${label}`, async () => {
      const before = (await readEvidence(page)).capturedAt
      const file = `${result.name}-${String(result.screenshots.length + 1).padStart(2, "0")}-${label}.png`
      await page.screenshot({ path: path.join(directory, file), fullPage: true, timeout: 10_000 })
      result.screenshots.push({ file, before, after: (await readEvidence(page)).capturedAt })
      result.artifacts.push(file)
    })
  }
}
export async function saveScenario(directory: string, result: ScenarioResult) {
  if (result.evidence) {
    result.performance = performanceProblems(result.evidence)
    if (result.performance.failed) result.problems.push("interaction longtask / Profiler / action completion contract failed")
    if (result.evidence.failedActions) result.problems.push(`${result.evidence.failedActions} fixture action(s) failed`)
    if (result.evidence.business.some((event) => event.category === "unexpected")) result.problems.push("page intercepted an unregistered business request")
  } else result.problems.push("no readable fixture evidence")
  if (result.network?.unknown.attempts) result.problems.push("context guard rejected unregistered network attempts")
  if (result.network?.business.calls !== 0) result.problems.push("business escaped the page mock boundary")
  if (result.console.length || result.pageErrors.length) result.problems.push("browser console error/warning or uncaught exception")
  if (result.problems.length) result.status = "failed"
  const file = `${result.name}.json`
  result.artifacts.push(file)
  await writeFile(path.join(directory, file), JSON.stringify(result, null, 2), { flag: "wx" })
}
