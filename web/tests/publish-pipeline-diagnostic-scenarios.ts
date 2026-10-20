/** Visible controls only. Window evidence is read-only; original clipboard text is never read. */
import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import type { Scenario, QueueEvidence } from "./publish-pipeline-browser-contract"
import { action, readEvidence } from "./publish-pipeline-browser-scenarios"
import { waitForPage } from "./publish-pipeline-browser-wait"

export async function driveDiagnosticScenario(page: Page, scenario: Scenario, screenshot: (label: string) => Promise<void>) {
  const request = scenario === "request-400" || scenario === "request-409"
  await page.getByRole("button", { name: request ? `整块请求 ${scenario.slice(-3)}` : "停止后响应丢失", exact: true }).click()
  await action(page, "导入实际诊断样本", "import")
  await action(page, "校验与拼接", "validate-compose")
  assert.equal((await readEvidence(page)).business.length, 0)
  await page.getByRole("button", { name: "发送", exact: true }).dblclick()
  let originalAction: string | undefined
  if (!request) {
    await waitForPage(page, () => window.publishPipelineMetrics.business.some((event) => event.operation === "submit" && event.event === "held"), undefined)
    const before = (await readEvidence(page)).state as QueueEvidence
    originalAction = before.actionId
    assert.equal(before.snapshot.inFlight, 1)
    assert.equal(before.snapshot.deadlines.length, 1)
    await screenshot("loading")
    if (scenario === "diagnostic-report") await action(page, "停止", "stop")
    else if (scenario === "diagnostic-route") await action(page, "离开诊断路由", "diagnostic-route")
    else await action(page, "模拟离线", "diagnostic-offline")
    assert.deepEqual(((await readEvidence(page)).state as QueueEvidence).snapshot.deadlines, before.snapshot.deadlines)
    await action(page, "释放模拟响应或修复", "mock-release")
  }
  await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "normal-send" && entry.end !== undefined), undefined)
  const section = page.getByRole("region", { name: "实际失败行诊断" })
  const rowRemediation = section.locator(':scope > [data-slot="publish-remediation"]')
  const details = rowRemediation.locator('[data-slot="publish-diagnostic-details"]')
  await details.waitFor({ state: "attached" })
  assert.equal(await rowRemediation.count(), 1)
  assert.equal(await details.count(), 1)
  const diagnosticId = await section.getAttribute("data-diagnostic-id"), traceId = await section.getAttribute("data-trace-id")
  assert.ok(diagnosticId && traceId && /^[A-Za-z0-9_.-]{1,128}$/.test(traceId))
  assert.equal(await section.getAttribute("data-row-position"), "100")
  let evidence = await readEvidence(page)
  assert.equal(evidence.business.filter((event) => event.operation === "submit" && event.event === "dispatch").length, 1)
  assert.equal(evidence.business.filter((event) => event.operation === "submit" && event.event === "abort").length, 0)
  assert.equal((evidence.state as QueueEvidence).snapshot.counts.unknown, 1)
  if (request) {
    const status = Number(scenario.slice(-3))
    const boundary = section.locator(`[data-request-status="${status}"]`)
    assert.equal(await boundary.count(), 1)
    const requestDetails = boundary.locator('[data-slot="publish-diagnostic-details"]')
    await requestDetails.waitFor({ state: "attached" })
    assert.equal(await requestDetails.count(), 1)
    assert.equal(await boundary.getAttribute("data-request-trace"), `fixture-request-${status}`)
    assert.equal(await boundary.getAttribute("data-request-cause"), status === 400 ? "request_refusal" : "result_unconfirmed")
    await boundary.locator("summary").click()
    assert.match(await boundary.innerText(), /整块 1 件商品/)
    assert.doesNotMatch(await boundary.innerText(), /External fixture refusal|每个商品的货号都冲突/)
    await screenshot("structured-request-error")
    return
  }
  assert.equal(evidence.business.filter((event) => event.operation === "inbox").length, 0, "late closed-action errors remain held")
  await action(page, "继续", "continue")
  evidence = await readEvidence(page)
  assert.equal((evidence.state as QueueEvidence).actionId, originalAction, "Continue retains the original scheduler action")
  assert.equal((evidence.state as QueueEvidence).snapshot.counts.unknown, 1)
  assert.equal(evidence.business.filter((event) => event.operation === "submit" && event.event === "dispatch").length, 1)
  if (scenario === "diagnostic-route") await action(page, "进入诊断路由", "diagnostic-route")
  if (scenario === "diagnostic-offline") await action(page, "恢复在线", "diagnostic-offline")
  await page.waitForTimeout(1100)
  assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "inbox").length, 0, "route/online/Continue cannot claim a new window")
  await rowRemediation.locator("summary").click()
  await screenshot("error-details")
  assert.match(await details.innerText(), new RegExp(traceId))
  await action(page, "复制诊断信息", "diagnostic-copy")
  const copy = (await readEvidence(page)).native.find((entry) => entry.kind === "clipboard")!.value as {
    diagnosticId: string; traceId: string; payloadSha256: string; hasOriginal: boolean; provenance: string; exactSubmittedBytes: boolean; writeSucceeded: boolean
  }
  assert.equal(copy.diagnosticId, diagnosticId); assert.equal(copy.traceId, traceId)
  assert.equal(copy.hasOriginal, true); assert.equal(copy.provenance, "submitted_http_body")
  assert.equal(copy.exactSubmittedBytes, true); assert.equal(copy.writeSucceeded, true)
  assert.match(copy.payloadSha256, /^[a-f0-9]{64}$/)
  await action(page, "下次 inbox 拒绝一次", "diagnostic-select")
  await action(page, "上报诊断信息", "diagnostic-report")
  await waitForPage(page, () => window.publishPipelineMetrics.business.some((event) => event.operation === "inbox" && event.event === "response" && event.status === 503), undefined)
  // First explicit window's transport failed; close it before its bounded automatic retry.
  await action(page, "离开诊断路由", "diagnostic-route")
  evidence = await readEvidence(page)
  const failed = evidence.business.filter((event) => event.operation === "inbox" && event.event === "response")
  assert.equal(failed.length, 1); assert.equal(failed[0]!.status, 503); assert.deepEqual(failed[0]!.acceptedIds, [])
  assert.equal(evidence.native.filter((entry) => entry.kind === "diagnostic-report-window").length, 1)
  await page.waitForTimeout(1100)
  await action(page, "进入诊断路由", "diagnostic-route")
  assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "inbox" && event.event === "dispatch").length, 1)
  await action(page, "上报诊断信息", "diagnostic-report")
  await waitForPage(page, () => window.publishPipelineMetrics.business.some((event) => event.operation === "inbox" && event.event === "response" && event.status === 200 && event.acceptedIds?.length), undefined)
  evidence = await readEvidence(page)
  const deliveries = evidence.business.filter((event) => event.operation === "inbox" && event.event === "response")
  assert.equal(deliveries.length, 2); assert.equal(deliveries[1]!.status, 200)
  assert.deepEqual(deliveries[1]!.acceptedIds, deliveries[0]!.events!.map((event) => event.id))
  const remote = deliveries[1]!.events![0]!
  assert.equal(remote.kind, "desktop_error_log.v4"); assert.equal(remote.schemaVersion, 4)
  assert.equal(remote.diagnosticId, diagnosticId); assert.equal(remote.traceId, traceId); assert.equal(remote.payloadSha256, copy.payloadSha256)
  assert.equal(remote.platform, "ozon"); assert.equal(remote.stage, "submit"); assert.equal(remote.code, "result_unknown")
  assert.ok(remote.summary!.every((field) => Object.keys(field).every((key) => ["field", "fieldId", "valueType", "length", "enumValue"].includes(key))))
  assert.ok(evidence.native.filter((entry) => entry.kind === "diagnostic-report-window").every((entry) => (entry.value as { admitted: boolean }).admitted))
  await screenshot("explicit-report-acknowledged")
  await action(page, "测量空闲 2 秒", "idle")
  assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "inbox" && event.event === "dispatch").length, 2)
}
