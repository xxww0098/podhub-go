/** DOM-only driver. evaluate/wait predicates only read recorded evidence. */
import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import type { ActionName, PipelineEvidence } from "./publish-pipeline-metrics"
import type { Scenario, QueueEvidence } from "./publish-pipeline-browser-contract"
import { driveDiagnosticScenario } from "./publish-pipeline-diagnostic-scenarios"
import { driveWorkbenchScenario } from "./publish-pipeline-workbench-scenarios"
import { driveKeepaliveScenario } from "./publish-pipeline-keepalive-scenarios"
import { driveReconcileScenario } from "./publish-pipeline-reconcile-scenarios"
import { waitForPage } from "./publish-pipeline-browser-wait"
import { unobservedOperation, type RunnerOperation } from "./publish-pipeline-browser-trace"
export const readEvidence = (page: Page): Promise<PipelineEvidence> => page.evaluate(() => window.publishPipelineMetrics)
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true })
export async function action(page: Page, label: string, name: ActionName) {
  const before = (await readEvidence(page)).actions.length
  await button(page, label).click()
  await waitForPage(page, ({ before, name }) => window.publishPipelineMetrics.actions.some((entry) => entry.id > before && entry.name === name && entry.end !== undefined), { before, name }, { timeout: 60_000 })
  const entry = (await readEvidence(page)).actions.find((entry) => entry.id > before && entry.name === name)!
  assert.equal(entry.status, "passed", `${name} action failed`)
}
const dispatches = (e: PipelineEvidence) => e.business.filter((event) => event.event === "dispatch" && event.operation === "submit")
const state = (e: PipelineEvidence) => e.state as QueueEvidence
export async function driveScenario(page: Page, scenario: Scenario, screenshot: (label: string) => Promise<void>, operation: RunnerOperation = unobservedOperation) {
  await operation("initial-ready", async () => {
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 45_000 })
    await waitForPage(page, () => window.publishPipelineMetrics.readyAt !== undefined, undefined)
  })
  await operation("initial-idle", () => page.waitForTimeout(2000))
  await screenshot("empty")
  if (scenario.startsWith("admission-") || scenario.startsWith("reconcile-")) return driveReconcileScenario(page, scenario, screenshot, operation)
  if (scenario.startsWith("diagnostic-") || scenario.startsWith("request-")) return driveDiagnosticScenario(page, scenario, screenshot)
  if (scenario === "brand-keepalive-return" || scenario === "unknown-keepalive-return") return driveKeepaliveScenario(page, scenario, screenshot)
  if (scenario.startsWith("brand-") || scenario.startsWith("unknown-")) return driveWorkbenchScenario(page, scenario, screenshot)
  if (scenario === "wb-error-coordinates") return driveWbErrorCoordinates(page, screenshot)
  if (scenario === "wb" || scenario === "wb-empty" || scenario === "wb-characteristics") {
    if (scenario === "wb-empty") await page.getByRole("checkbox", { name: "模拟目录尚未采集" }).check()
    await action(page, "导入 WB 预览记录", "wb-import")
    await action(page, "打开 WB 类目", "wb-open")
    if (scenario === "wb-empty") await screenshot("empty-catalog")
    if (scenario === "wb" || scenario === "wb-characteristics") await page.getByRole("textbox", { name: "首个变体货号" }).fill("")
    await action(page, "本地校验与预览", "wb-edit-validate")
    await page.locator('[data-slot="publish-remediation"] summary').first().click()
    await screenshot("error")
    let e = await readEvidence(page)
    const previews = () => e.native.filter((item) => item.kind === "wb-preview").map((item) => item.value as { issues: { code: string }[]; group: boolean; bytes: number; settled: boolean })
    assert.ok(previews().at(-1)!.issues.some((issue) => issue.code === (scenario === "wb-empty" ? "catalog_unavailable" : "vendor_code_required")))
    assert.equal(previews().at(-1)!.group, false)
    if (scenario === "wb" || scenario === "wb-characteristics") {
      await page.getByRole("textbox", { name: "首个变体货号" }).fill("FIXTURE-WB")
      await action(page, "本地校验与预览", "wb-edit-validate")
      e = await readEvidence(page)
      assert.deepEqual(previews().at(-1)!.issues, [])
      assert.ok(previews().at(-1)!.group && previews().at(-1)!.bytes > 0 && previews().at(-1)!.settled)
      await screenshot("success")
    }
    if (scenario === "wb-characteristics") {
      for (const [sample, characteristicId] of [["blank", 100], ["unknown", 9999], ["max-count", 100], ["number-type", 200]] as const) {
        await page.getByRole("combobox", { name: "WB 原生特征样本" }).selectOption(sample)
        await action(page, "本地校验与预览", "wb-edit-validate")
        e = await readEvidence(page)
        const native = e.native.filter((entry) => entry.kind === "wb-preview").at(-1)!.value as { issues: { code: string; characteristicId: number | null }[]; nativeCalls: number; group: boolean; bytes: number }
        assert.equal(native.nativeCalls, 1); assert.equal(native.group, false); assert.equal(native.bytes, 0); assert.ok(native.issues.length > 0)
        assert.ok(native.issues.some((issue) => issue.characteristicId === characteristicId))
        await screenshot(`native-characteristic-${sample}`)
      }
      await page.getByRole("combobox", { name: "WB 原生特征样本" }).selectOption("valid")
      await action(page, "本地校验与预览", "wb-edit-validate")
      e = await readEvidence(page)
      const native = e.native.filter((entry) => entry.kind === "wb-preview").at(-1)!.value as { issues: unknown[]; nativeCalls: number; group: boolean; bytes: number }
      assert.equal(native.nativeCalls, 1); assert.deepEqual(native.issues, []); assert.equal(native.group, true); assert.ok(native.bytes > 0)
    }
    assert.equal(await button(page, "WB 发送尚未开通").isDisabled(), true)
    assert.equal(e.business.filter((event) => event.event === "dispatch").length, 1)
    assert.equal(e.business.find((event) => event.event === "dispatch")!.category, "C")
    assert.equal(dispatches(e).length, 0)
    assert.equal(e.business.filter((event) => event.operation === "inbox").length, 0)
    assert.ok(e.native.filter((entry) => entry.kind === "wb-preview").every((entry) => (entry.value as { nativeCalls: number }).nativeCalls === 1))
    await action(page, "显式刷新 WB 类目", "wb-refresh")
    assert.equal((await readEvidence(page)).business.filter((event) => event.event === "dispatch").length, 2)
    await action(page, "测量空闲 2 秒", "idle")
    return
  }
  const label = ({ local: "受理成功", accepted: "受理成功", stop: "在途停止", unknown: "第二块断网", schema: "Schema 修复", media: "媒体修复", late: "切方案迟到" } as Partial<Record<Scenario, string>>)[scenario]
  assert.ok(label, "Every scenario must have an explicit DOM driver")
  await operation("pre-import", () => operation("scenario-selection", () => button(page, label).click()))
  await operation("initial-import", () => action(page, "导入 1000 行", "import"))
  await action(page, "编辑首行价格", "single-edit")
  await action(page, "校验与拼接", "validate-compose")
  let e = await readEvidence(page)
  assert.equal(state(e).rowCount, 1000)
  for (const destination of ["fixture-a", "fixture-b"]) assert.equal(state(e).rows.filter((row) => row.destination === destination).length, 500)
  assert.equal(e.business.length, 0, "import/edit/native build must have zero business calls")
  assert.deepEqual(e.native.find((entry) => entry.kind === "validate-compose")!.value, { requested: 1000, prepared: 1000, blocked: 0 })
  if (scenario === "local") { await action(page, "测量空闲 2 秒", "idle"); return }
  const repairing = scenario === "schema" || scenario === "media"
  if (repairing) await page.getByRole("checkbox", { name: "仅发送首块修复样本（100 行）" }).check()
  await page.getByRole("checkbox", { name: "保持首块响应以取证" }).check()
  // Two actual pointer clicks; the disabled control must not re-enter admission.
  await button(page, "发送").dblclick()
  await waitForPage(page, (minimum) => window.publishPipelineMetrics.business.filter((entry) => entry.operation === "submit" && entry.event === "held").length >= minimum, repairing ? 1 : 2)
  await screenshot("loading")
  if (scenario === "stop" || scenario === "late") {
    const before = await readEvidence(page)
    const deadlines = state(before).snapshot.deadlines
    assert.equal(deadlines.length, 2)
    for (const deadline of deadlines) assert.ok(deadline - (before.timeOrigin + before.capturedAt) > 140_000 && deadline - (before.timeOrigin + before.capturedAt) <= 150_000)
    if (scenario === "stop") {
      await button(page, "停止").click()
      await page.locator('main[data-phase="stopping"]').waitFor()
      e = await readEvidence(page)
      assert.deepEqual(state(e).snapshot.deadlines, deadlines)
      assert.equal(await button(page, "发送").isDisabled(), true)
      assert.equal(await button(page, "继续").isDisabled(), true)
      assert.equal(await button(page, "停止").isDisabled(), true)
      const stop = e.actions.find((entry) => entry.name === "stop")!
      const observed = e.queues.find((entry) => entry.at >= stop.start && (entry.value as QueueEvidence).snapshot.phase === "stopping")!
      assert.ok(observed.at - stop.start < 100, "same-frame Stop observation")
    } else {
      await button(page, "切换方案并关闭原作用域").click()
      await page.locator('main[data-closed="true"]').waitFor()
      assert.equal(await page.locator("tbody tr").count(), 0)
    }
    assert.equal(dispatches(await readEvidence(page)).length, 2)
    await button(page, "释放模拟响应或修复").click()
  }
  if (scenario !== "stop" && scenario !== "late") await button(page, "释放模拟响应或修复").click()
  if (scenario === "schema" || scenario === "media") {
    await waitForPage(page, () => window.publishPipelineMetrics.business.some((entry) => entry.event === "held" && (entry.path === "/api/catalog/schemas/fixture" || entry.category === "fixture-media")), undefined)
    await page.locator('[data-slot="publish-remediation"] summary').first().click()
    await screenshot("error")
    await button(page, "释放模拟响应或修复").click()
  }
  await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "normal-send" && entry.end !== undefined), undefined, { timeout: 90_000 })
  e = await readEvidence(page)
  assert.equal(e.actions.find((entry) => entry.name === "normal-send")!.status, "passed")
  const sent = dispatches(e)
  assert.ok(sent.every((entry) => entry.rowIds!.length <= 100 && entry.requestBytes! <= 7.5 * 1024 * 1024))
  let peak = 0
  const active = new Map<number, string>()
  for (const event of e.business.filter((event) => event.operation === "submit")) {
    if (event.event === "dispatch") { assert.ok(![...active.values()].includes(event.destination!)); active.set(event.request, event.destination!); peak = Math.max(peak, active.size) }
    else if (event.event === "response" || event.event === "rejection") active.delete(event.request)
  }
  assert.equal(peak, repairing ? 1 : 2); assert.equal(active.size, 0)
  assert.equal(e.business.filter((event) => event.operation === "submit" && event.event === "abort").length, 0)
  if (scenario === "stop" || scenario === "late") {
    assert.equal(sent.length, 2)
    assert.equal(state(e).snapshot.phase, "paused")
    assert.equal(state(e).rows.filter((row) => row.state === "accepted").length, scenario === "stop" ? 200 : 0)
    assert.equal(state(e).rows.filter((row) => row.state === "ready").length, 800)
  } else if (scenario === "unknown") {
    assert.equal(sent.filter((event) => event.destination === "fixture-a").length, 2)
    assert.equal(sent.filter((event) => event.destination === "fixture-b").length, 5)
    assert.deepEqual(state(e).snapshot.counts, { accepted: 600, pending: 0, rejected: 0, unknown: 100 })
    assert.equal(state(e).rows.filter((row) => row.destination === "fixture-a" && row.state === "ready").length, 300)
    const diagnostic = page.getByRole("region", { name: "实际失败行诊断" })
    assert.equal(await diagnostic.getAttribute("data-row-position"), "100", "select real unknown row beyond the first twenty")
    await waitForPage(page, () => document.querySelector('[aria-label="实际失败行诊断"]')?.getAttribute("data-diagnostic-id"), undefined)
    await screenshot("error")
    await action(page, "核对结果", "query")
    await action(page, "继续", "continue")
    const after = await readEvidence(page)
    assert.equal(dispatches(after).length, 7)
    assert.equal(state(after).snapshot.counts.unknown, 100)
    assert.deepEqual(after.business.filter((event) => event.operation === "intents" && event.event === "dispatch").map((event) => event.destination), ["fixture-a"])
    assert.deepEqual(after.native.find((entry) => entry.kind === "missing-identity-query")!.value, { rows: 100, returned: 0, applied: false })
  } else {
    assert.equal(state(e).snapshot.counts.accepted, repairing ? 100 : 1000)
    assert.equal(sent.length, scenario === "accepted" ? 10 : 2)
    if (scenario === "schema" || scenario === "media") {
      const responses = e.business.filter((event) => event.operation === "submit" && event.event === "response" && event.destination === "fixture-a")
      assert.deepEqual(responses[0]!.rowIds, responses[1]!.rowIds)
      assert.notDeepEqual(responses[0]!.draftHashes, responses[1]!.draftHashes)
      if (scenario === "schema") {
        assert.ok(responses[0]!.schemaRevisions!.every((revision) => revision !== "fixture-refreshed"))
        assert.ok(responses[1]!.schemaRevisions!.every((revision) => revision === "fixture-refreshed"))
      } else { assert.equal(responses[0]!.renewedMedia, false); assert.equal(responses[1]!.renewedMedia, true) }
      assert.equal(e.business.filter((event) => event.event === "dispatch" && event.operation === scenario).length, 1)
      assert.equal(state(e).parents!.reduce((sum, parent) => sum + parent.budget.submits, 0), 2)
      assert.equal(state(e).parents!.reduce((sum, parent) => sum + parent.budget[scenario], 0), 1)
    }
    await screenshot("success")
  }
  assert.ok(state(e).parents!.every((parent) => parent.budget.submits <= 6 && parent.budget.schema <= 1 && parent.budget.media <= 1))
  await action(page, "测量空闲 2 秒", "idle")
}

type WbPreviewEvidence = {
  recordId: string; inputVariants: number; nativeCalls: number; settled: boolean; group: boolean; bytes: number; variants: number
  issues: { platform: string; stage: string; code: string; field: string; scope: "material" | "group" | "variant"; characteristicId: number | null; variantIndex: number | null }[]
}
/** Visible inputs and real native preview only; evaluate is a read-only evidence lookup. */
async function driveWbErrorCoordinates(page: Page, screenshot: (label: string) => Promise<void>) {
  const native = async () => (await readEvidence(page)).native.filter((entry) => entry.kind === "wb-preview").at(-1)!.value as WbPreviewEvidence
  const select = async (label: string, sample: string) => {
    const before = await readEvidence(page)
    await page.getByRole("combobox", { name: label, exact: true }).selectOption(sample)
    await waitForPage(page, (id) => window.publishPipelineMetrics.actions.some((entry) => entry.id > id && entry.name === "wb-edit-validate" && entry.end !== undefined), before.actions.length)
    const after = await readEvidence(page)
    assert.equal(after.actions.find((entry) => entry.id > before.actions.length && entry.name === "wb-edit-validate")!.status, "passed")
    assert.equal(after.business.length, before.business.length, "selecting a config/material sample never performs HTTP")
    assert.equal(after.native.length, before.native.length, "editing does not implicitly run a native preview")
  }
  const region = page.getByRole("region", { name: "WB 原生校验问题", exact: true })
  const assertDetails = async (expected: { scope: WbPreviewEvidence["issues"][number]["scope"]; field: string; index: number | null; characteristic: number | null }[]) => {
    const result = await native()
    assert.equal(result.nativeCalls, 1); assert.equal(result.settled, true)
    assert.equal(result.inputVariants, 2); assert.equal(result.group, false); assert.equal(result.bytes, 0)
    assert.deepEqual(result.issues.map((issue) => ({ scope: issue.scope, field: issue.field, index: issue.variantIndex, characteristic: issue.characteristicId })), expected)
    const details = region.locator('[data-slot="publish-remediation"]')
    assert.equal(await details.count(), expected.length)
    for (const [index, issue] of expected.entries()) {
      const detail = details.nth(index)
      if (await detail.getAttribute("open") === null) await detail.locator("summary").click()
      assert.notEqual(await detail.getAttribute("open"), null)
      const scopeText = await detail.locator("dd").nth(1).innerText()
      const steps = await detail.locator("ol").innerText()
      assert.ok(scopeText.includes(`商品组 ${result.recordId}`))
      assert.doesNotMatch(scopeText, /仅此商品行/)
      if (issue.scope === "variant") {
        assert.ok(scopeText.includes(`第 ${issue.index! + 1} 个变体`))
        assert.ok(scopeText.includes(`原生序号 ${issue.index}`))
        assert.ok(steps.includes(`第 ${issue.index! + 1} 个变体`))
        if (issue.index === 1) assert.doesNotMatch(scopeText + steps, /第 1 个变体/)
      } else {
        assert.doesNotMatch(scopeText, /第 \d+ 个变体/)
        assert.match(scopeText, issue.scope === "material" ? /所用 WB 类目材料.*共用该材料/ : /整组/)
      }
      if (issue.characteristic !== null) {
        assert.ok(scopeText.includes(`characteristic ${issue.characteristic}`))
        assert.ok(steps.includes(`characteristic ${issue.characteristic}`))
      }
      assert.equal(await detail.getByRole("button").count(), 0, "native field errors do not gain repair/send/release actions")
    }
  }
  const assertRecovered = async () => {
    const result = await native()
    assert.equal(result.nativeCalls, 1); assert.equal(result.settled, true); assert.deepEqual(result.issues, [])
    assert.equal(result.inputVariants, 2); assert.equal(result.variants, 2); assert.equal(result.group, true); assert.ok(result.bytes > 0)
    assert.equal(await region.locator('[data-slot="publish-remediation"]').count(), 0)
    assert.equal(await button(page, "WB 发送尚未开通").isDisabled(), true)
  }
  await action(page, "导入 WB 预览记录", "wb-import")
  await select("WB 有序变体定位样本", "valid")
  await select("WB 类目材料样本", "blank-default")
  assert.equal((await readEvidence(page)).business.length, 0)
  await action(page, "打开 WB 类目", "wb-open")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertDetails([{ scope: "material", field: "characteristic", index: null, characteristic: 100 }])
  await screenshot("material-native-scope")
  await select("WB 类目材料样本", "valid")
  await action(page, "显式刷新 WB 类目", "wb-refresh")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertRecovered()
  await screenshot("material-recovered")

  await select("WB 有序变体定位样本", "second-only")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertDetails([{ scope: "variant", field: "characteristic", index: 1, characteristic: 100 }])
  await screenshot("second-only-native-coordinate")
  await select("WB 有序变体定位样本", "both")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertDetails([{ scope: "variant", field: "characteristic", index: 0, characteristic: 100 },
    { scope: "variant", field: "characteristic", index: 1, characteristic: 100 }])
  assert.notEqual(await region.locator("details").nth(0).locator("dd").nth(1).innerText(), await region.locator("details").nth(1).locator("dd").nth(1).innerText())
  await screenshot("both-native-coordinates")
  await select("WB 有序变体定位样本", "group")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertDetails([{ scope: "group", field: "subject", index: null, characteristic: null }])
  await screenshot("group-native-scope")
  await select("WB 有序变体定位样本", "variant")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertDetails([{ scope: "variant", field: "vendor_code", index: 1, characteristic: null }])
  assert.match(await region.innerText(), /货号 vendorCode/)
  await screenshot("variant-native-scope")
  await select("WB 有序变体定位样本", "valid")
  await action(page, "本地校验与预览", "wb-edit-validate")
  await assertRecovered()
  await screenshot("coordinates-recovered")
  const beforeComponents = await readEvidence(page)
  await action(page, "运行 WB 方案组件检查", "wb-edit-validate")
  const evidence = await readEvidence(page)
  const mounted = evidence.native.find((entry) => entry.kind === "wb-mounted-remediation-checks")!.value as {
    results: { name: string; status: string; issues: { scope: string; variantIndex: number | null; characteristicId: number | null }[] }[]
  }
  assert.equal(mounted.results.length, 7); assert.equal(new Set(mounted.results.map((result) => result.name)).size, 7)
  assert.ok(mounted.results.every((result) => result.status === "passed"))
  assert.deepEqual(mounted.results[0]!.issues.map((issue) => [issue.scope, issue.variantIndex, issue.characteristicId]), [["variant", 1, 100]])
  assert.deepEqual(mounted.results[1]!.issues.map((issue) => [issue.scope, issue.variantIndex, issue.characteristicId]), [["variant", 0, 100], ["variant", 1, 100]])
  assert.equal(evidence.business.length, beforeComponents.business.length, "mounted native/component checks use zero HTTP")
  assert.deepEqual(evidence.business.filter((event) => event.event === "dispatch").map((event) => [event.method, event.operation, event.category]),
    [["GET", "wb-catalog", "C"], ["GET", "wb-catalog", "C"]])
  assert.equal(evidence.business.filter((event) => ["submit", "intents", "release", "inbox"].includes(event.operation)).length, 0)
  assert.equal(await button(page, "WB 发送尚未开通").isDisabled(), true)
  assert.equal(await page.locator('[role="alert"]').count(), 0)
  await action(page, "测量空闲 2 秒", "idle")
}
