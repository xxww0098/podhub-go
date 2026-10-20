import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import type { PageFunction } from "playwright-core/types/structs"
import { waitForPage } from "./publish-pipeline-browser-wait"

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function pagePort() {
  const calls: { predicate: unknown; arg: unknown }[] = []
  let inFlight = 0, peak = 0, forbiddenCalls = 0
  const page = {
    async evaluate<R, Arg>(predicate: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
      if (typeof predicate !== "function") throw new Error("String evaluation is forbidden")
      calls.push({ predicate, arg }); inFlight++; peak = Math.max(peak, inFlight)
      try { return await Reflect.apply(predicate, undefined, [arg]) }
      finally { inFlight-- }
    },
    waitForFunction() { forbiddenCalls++; throw new Error("Deferred browser evaluation is forbidden") },
  }
  return { page, calls, peak: () => peak, forbiddenCalls: () => forbiddenCalls }
}

test("host wait preserves predicate and argument until truthy without waitForFunction", async () => {
  const port = pagePort(), arg = { minimum: 3 }
  let polls = 0
  const predicate = ({ minimum }: typeof arg) => ++polls >= minimum
  await waitForPage(port.page, predicate, arg, { timeout: 2000 })
  assert.equal(port.calls.length, 3)
  assert.ok(port.calls.every((call) => call.predicate === predicate && call.arg === arg))
  assert.equal(port.forbiddenCalls(), 0)
  await pause(48)
  assert.equal(port.calls.length, 3, "successful wait schedules no further reads")
})

test("host wait preserves non-boolean truthiness and undefined arguments", async () => {
  const port = pagePort(), values = [undefined, 0, "", "fixture-diagnostic-id"]
  await waitForPage(port.page, () => values.shift(), undefined, { timeout: 2000 })
  assert.equal(port.calls.length, 4)
  assert.ok(port.calls.every((call) => call.arg === undefined))
})

test("host wait permits only one pending evaluation", async () => {
  const port = pagePort()
  let polls = 0
  await waitForPage(port.page, async () => { await pause(24); return ++polls === 3 }, undefined, { timeout: 2000 })
  assert.equal(port.calls.length, 3)
  assert.equal(port.peak(), 1)
})

test("host wait deadline rejects false predicates and stops polling", async () => {
  const port = pagePort()
  await assert.rejects(waitForPage(port.page, () => false, undefined, { timeout: 30 }), /timed out after 30ms/)
  const count = port.calls.length
  assert.ok(count > 0)
  await pause(48)
  assert.equal(port.calls.length, count)
})

test("host wait deadline bounds an in-flight evaluation and ignores its late success", async () => {
  const port = pagePort()
  let release!: (ready: boolean) => void
  const pending = new Promise<boolean>((resolve) => { release = resolve })
  await assert.rejects(waitForPage(port.page, () => pending, undefined, { timeout: 30 }), /timed out after 30ms/)
  assert.equal(port.calls.length, 1)
  release(true)
  await pause(48)
  assert.equal(port.calls.length, 1)
})

test("host wait consumes late evaluation rejection after its deadline without new reads", async () => {
  const port = pagePort()
  let rejectRead!: (error: Error) => void
  const pending = new Promise<boolean>((_, reject) => { rejectRead = reject })
  await assert.rejects(waitForPage(port.page, () => pending, undefined, { timeout: 30 }), /timed out after 30ms/)
  rejectRead(new Error("closed page read"))
  await pause(48)
  assert.equal(port.calls.length, 1)
})

test("host wait propagates the original evaluation error and stops polling", async () => {
  const port = pagePort(), failure = new Error("fixture evaluation failed")
  let polls = 0
  await assert.rejects(waitForPage(port.page, () => { if (++polls === 2) throw failure; return false }, undefined, { timeout: 2000 }),
    (error) => error === failure)
  await pause(48)
  assert.equal(port.calls.length, 2)
})

test("host wait propagates a synchronous page-port error", async () => {
  const failure = new Error("page unavailable")
  await assert.rejects(waitForPage({ evaluate() { throw failure } }, () => true, undefined), (error) => error === failure)
})

test("host wait refuses unbounded deadlines and string predicates before evaluating", async () => {
  const port = pagePort()
  for (const timeout of [0, -1, NaN, Infinity]) {
    await assert.rejects(waitForPage(port.page, () => true, undefined, { timeout }), RangeError)
  }
  await assert.rejects(Reflect.apply(waitForPage, undefined, [port.page, "true", undefined]), TypeError)
  assert.equal(port.calls.length, 0)
})

test("all sixteen runner waits use the host helper with unchanged timeout and serve boundaries", async () => {
  const names = ["publish-pipeline-browser-scenarios.ts", "publish-pipeline-diagnostic-scenarios.ts", "publish-pipeline-workbench-scenarios.ts", "run-publish-pipeline-browser.ts"]
  const sources = await Promise.all(names.map((name) => readFile(new URL(name, import.meta.url), "utf8")))
  // wb-error-coordinates adds one wb-edit-validate wait using the helper's 15_000ms default.
  assert.deepEqual(sources.map((source) => (source.match(/await waitForPage\(page,/g) ?? []).length), [7, 4, 4, 1])
  for (const source of sources) assert.doesNotMatch(source, /\.waitForFunction\s*\(/)
  assert.equal((sources.join("\n").match(/timeout: 60_000/g) ?? []).length, 1)
  assert.equal((sources.join("\n").match(/timeout: 90_000/g) ?? []).length, 1)
  const runner = sources[3]!, helper = await readFile(new URL("publish-pipeline-browser-wait.ts", import.meta.url), "utf8")
  assert.match(runner, /page\.setDefaultTimeout\(15_000\)/)
  assert.match(helper, /\{ timeout = 15_000 \}/)
  assert.doesNotMatch(helper, /\.waitForFunction\s*\(|\beval\s*\(|\bnew\s+Function\b/)
  const serveReturn = runner.indexOf('if (options.mode === "serve") { await serve(outputRoot); return }')
  assert.ok(serveReturn >= 0)
  assert.ok(runner.indexOf('await import("./publish-pipeline-browser-wait")') > serveReturn)
  assert.doesNotMatch(runner.slice(0, serveReturn), /import.*publish-pipeline-browser-wait/)
})
