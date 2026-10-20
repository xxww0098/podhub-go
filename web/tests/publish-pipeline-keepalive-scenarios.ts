/** Desired keepalive contract. Current production failures remain failures. DOM actions only. */
import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import type { Scenario } from "./publish-pipeline-browser-contract"
import type { PipelineEvidence } from "./publish-pipeline-metrics"
import type { KeepaliveStateEvidence } from "./publish-pipeline-keepalive"
import { action, readEvidence } from "./publish-pipeline-browser-scenarios"
import { waitForPage } from "./publish-pipeline-browser-wait"

const ids = { row: "fixture-workbench-row", store: "fixture-workbench-store", card: "fixture-workbench-card", intent: "fixture-exact-intent" }
function latest(evidence: PipelineEvidence): KeepaliveStateEvidence {
  const entry = evidence.native.filter((item) => item.kind === "keepalive-state").at(-1)
  assert.ok(entry, "Real mounted lifecycle must record its facts")
  return entry.value as KeepaliveStateEvidence
}
const dispatches = (evidence: PipelineEvidence) => evidence.business.filter((event) => event.event === "dispatch")
function assertSameScreen(before: KeepaliveStateEvidence, after: KeepaliveStateEvidence) {
  for (const key of ["componentId", "workspaceId", "addressCardId", "cardId", "storeId", "storeConfigured", "canManage",
    "generation", "dispatchedGeneration", "handledCardId", "controlVersion", "scope", "mediaEpoch", "rowId", "revision", "viewRevision",
    "mode", "stage", "locked", "mountSetups", "mountCleanups", "openRunnerCalls", "leaveRunnerCalls"] as const) {
    assert.equal(after[key], before[key], `${key} must survive hide/return without a fixture fence mutation`)
  }
}
function assertNativeEdits(evidence: PipelineEvidence, count: number) {
  const edits = evidence.native.filter((entry) => entry.kind === "brand-native-edit")
  assert.equal(edits.length, count)
  for (const entry of edits) {
    const value = entry.value as { fact: string; cleared: string[]; handEditedKeys: string[]; manual: boolean; tagsAbsent: boolean;
      mediaPreserved: boolean; aiPreserved: boolean; sourcePreserved: boolean; otherFieldsPreserved: boolean }
    assert.equal(value.fact, "Passed"); assert.equal(value.manual, true); assert.equal(value.tagsAbsent, true)
    assert.ok(value.cleared.includes("native_search_tags")); assert.ok(value.handEditedKeys.includes("native_search_tags"))
    assert.equal(value.mediaPreserved, true); assert.equal(value.aiPreserved, true)
    assert.equal(value.sourcePreserved, true); assert.equal(value.otherFieldsPreserved, true)
  }
}
function assertNotSent(evidence: PipelineEvidence) {
  assert.equal(evidence.business.filter((event) => event.operation === "submit").length, 0)
  assert.equal(evidence.business.filter((event) => event.operation === "inbox").length, 0)
}
async function hideAndReturn(page: Page, screenshot: (label: string) => Promise<void>) {
  const before = latest(await readEvidence(page))
  assert.equal(before.active, true)
  const pane = page.locator('[data-keepalive-instance]')
  await action(page, "隐藏保活屏幕", "workbench-scope")
  const hidden = latest(await readEvidence(page))
  assert.equal(hidden.active, false); assertSameScreen(before, hidden)
  assert.equal(await pane.getAttribute("data-keepalive-active"), "false")
  assert.equal(await pane.isVisible(), false)
  assert.equal(await pane.locator('xpath=..').getAttribute("hidden"), "")
  assert.equal(await pane.locator('xpath=..').getAttribute("inert"), "")
  await screenshot("same-card-hidden")
  await action(page, "返回同一卡片保活屏幕", "workbench-scope")
  const after = latest(await readEvidence(page))
  assert.equal(after.active, true); assertSameScreen(before, after)
  assert.equal(await pane.getAttribute("data-keepalive-instance"), before.componentId)
  assert.equal(await pane.getAttribute("data-keepalive-active"), "true")
  assert.equal(await pane.isVisible(), true)
  assert.equal(after.refreshSavedFormsCalls, before.refreshSavedFormsCalls + 1, "Real activation effect must run")
  assert.equal(after.reloadOzonStoresCalls, before.reloadOzonStoresCalls + 1)
  assert.equal(after.ownerSameAsSeeded, false, "Return must use a fresh live owner")
  assert.equal(after.retiredDistinct, true)
  assert.equal(after.retiredBrandAvailable, false)
  await screenshot("same-card-returned")
}

export async function driveKeepaliveScenario(page: Page,
  scenario: Extract<Scenario, "brand-keepalive-return" | "unknown-keepalive-return">,
  screenshot: (label: string) => Promise<void>) {
  const brand = scenario === "brand-keepalive-return"
  await action(page, "选择真实 ScreenPane 保活夹具", "workbench-configure")
  assert.equal(dispatches(await readEvidence(page)).length, 0, "Selecting/mounting must not request business data")
  const section = page.getByRole("region", { name: "保活屏幕生产动作" })
  await section.getByRole("combobox", { name: "保活外部事实" }).selectOption(brand ? "brand" : "unknown")
  if (brand) await section.getByRole("checkbox", { name: "保持保活原生编辑后的等待" }).check()
  await waitForPage(page, () => window.publishPipelineMetrics.actions.filter((entry) => entry.name === "workbench-configure")
    .every((entry) => entry.end !== undefined && entry.status === "passed"), undefined)
  await action(page, "明确载入保活工作台夹具", "workbench-load")
  await section.locator("summary").first().click()
  await screenshot("seeded-error")
  let evidence = await readEvidence(page), current = latest(evidence)
  assert.deepEqual(dispatches(evidence).map((event) => [event.method, event.operation, event.category]), [["GET", "schema", "C"]])
  assert.equal(current.workspaceId, 1); assert.equal(current.cardId, ids.card); assert.equal(current.addressCardId, ids.card)
  assert.equal(current.handledCardId, ids.card); assert.equal(current.rowId, ids.row); assert.equal(current.storeId, ids.store)
  assert.equal(current.mode, "runner"); assert.equal(current.storeConfigured, true); assert.equal(current.canManage, true)
  assert.equal(current.generation, current.dispatchedGeneration); assert.equal(current.controlVersion, 0)
  assert.ok(current.mountSetups >= 2 && current.mountCleanups >= 1, "Actual root StrictMode must replay resident effects")
  assert.ok(current.setups >= 2 && current.cleanups >= 1, "The production capability hook must actually replay")
  assert.equal(current.retiredDistinct, true); assert.equal(current.retiredBrandAvailable, false)
  assert.equal(current.ownerSameAsSeeded, true); assert.equal(current.liveBrandAvailable, brand)
  assert.equal(current.revision, 1); assert.equal(current.viewRevision, 1)
  assertNotSent(evidence)

  if (brand) {
    assert.equal(current.stage, "publish_rejected")
    const beforeRepair = evidence.actions.length
    await section.getByRole("button", { name: "修复品牌字段", exact: true }).click()
    try {
      await waitForPage(page, () => window.publishPipelineMetrics.native.some((entry) => entry.kind === "brand-native-held"), undefined)
      // The actual op2 result is held throughout BOTH navigation edges.
      assert.equal((await readEvidence(page)).actions.find((entry) => entry.id > beforeRepair && entry.name === "brand-repair")?.end, undefined)
      await screenshot("native-edit-held")
      await hideAndReturn(page, screenshot)
      assert.equal((await readEvidence(page)).actions.find((entry) => entry.id > beforeRepair && entry.name === "brand-repair")?.end, undefined)
    } finally {
      // Release and settle even if a screen-identity assertion fails.
      await action(page, "释放保活原生编辑等待", "mock-release")
      await waitForPage(page, (before) => window.publishPipelineMetrics.actions.some((entry) => entry.id > before
        && entry.name === "brand-repair" && entry.end !== undefined), beforeRepair, { timeout: 60_000 })
    }
    evidence = await readEvidence(page); current = latest(evidence)
    assertNativeEdits(evidence, 1); assertNotSent(evidence)
    assert.equal(evidence.business.filter((event) => event.operation === "row-patch").length, 0,
      "Old repair must never PATCH after an intervening inactive screen")
    assert.equal(evidence.business.filter((event) => event.operation === "row-read").length, 0)
    assert.deepEqual(dispatches(evidence).map((event) => event.operation), ["schema"])
    assert.equal(current.stage, "publish_rejected"); assert.equal(current.revision, 1); assert.equal(current.viewRevision, 1)
    assert.equal(current.nativeTagsCleared, false)
    assert.equal(evidence.native.filter((entry) => entry.kind === "keepalive-native-validation").length, 0)
    assert.equal(evidence.actions.find((entry) => entry.id > beforeRepair && entry.name === "brand-repair")!.status, "passed")
    assert.equal(current.ownerSameAsSeeded, false, "Old completion must snapshot the current resident owner")
    assert.equal(current.retiredDistinct, true); assert.equal(current.retiredBrandAvailable, false)
    assert.equal(current.liveBrandAvailable, true, "Fresh explicit repair must be available on the live owner")
    await screenshot("old-repair-revoked")
    await section.getByRole("checkbox", { name: "保持保活原生编辑后的等待" }).uncheck()
    await waitForPage(page, () => window.publishPipelineMetrics.actions.filter((entry) => entry.name === "workbench-configure")
      .every((entry) => entry.end !== undefined && entry.status === "passed"), undefined)
    // Inactivity remounted the normal remediation with its default collapsed details.
    const remediation = section.locator('details[data-slot="publish-remediation"]')
    assert.equal(await remediation.count(), 1)
    if (await remediation.getAttribute("open") === null) await remediation.locator("summary").click()
    assert.equal(await remediation.getAttribute("open"), "")
    await waitForPage(page, () => window.publishPipelineMetrics.actions.filter((entry) => entry.name === "diagnostic-details")
      .every((entry) => entry.end !== undefined && entry.status === "passed"), undefined)
    const repairButton = remediation.getByRole("button", { name: "修复品牌字段", exact: true })
    assert.equal(await repairButton.isVisible(), true); assert.equal(await repairButton.isEnabled(), true)
    // A fresh explicit action uses the resumed live production owner, without a fixture factory/reset.
    await action(page, "修复品牌字段", "brand-repair")
    evidence = await readEvidence(page); current = latest(evidence)
    assertNativeEdits(evidence, 2)
    assert.deepEqual(dispatches(evidence).map((event) => [event.method, event.operation]),
      [["GET", "schema"], ["PATCH", "row-patch"], ["GET", "row-read"]])
    const saved = evidence.business.find((event) => event.operation === "row-patch" && event.event === "response")!
    assert.equal(saved.baseRevision, 1); assert.equal(saved.revision, 2); assert.equal(saved.viewRevision, 2)
    assert.equal(current.stage, "ready_to_publish"); assert.equal(current.revision, 2); assert.equal(current.viewRevision, 2)
    assert.equal(current.ready, true); assert.equal(current.nativeTagsCleared, true)
    assert.equal(await section.getByRole("button", { name: "修复品牌字段", exact: true }).count(), 0)
    const validations = evidence.native.filter((entry) => entry.kind === "keepalive-native-validation")
    assert.equal(validations.length, 2); assert.ok(validations.every((entry) => (entry.value as { fact: string }).fact === "Passed"))
    assertNotSent(evidence)
    await screenshot("fresh-repair-not-sent")
    return
  }

  assert.equal(current.stage, "outcome_unknown"); assert.equal(current.locked, true)
  await action(page, "核对原 Intent", "unknown-inspect")
  evidence = await readEvidence(page); current = latest(evidence)
  const candidate = { intentId: ids.intent, rowId: ids.row, storeId: ids.store, revision: 1, operationId: "fixture-original-operation" }
  assert.deepEqual(current.unknownCandidate, candidate)
  const inspected = dispatches(evidence).filter((event) => event.operation === "intents")
  assert.equal(inspected.length, 1); assert.equal(inspected[0]!.destination, ids.store)
  assert.deepEqual(inspected[0]!.rowIds, [ids.row]); assert.equal(inspected[0]!.latestPerRow, true); assert.equal(inspected[0]!.limit, 100)
  const release = section.getByRole("button", { name: "核对后释放 1 件商品的确切未确认 Intent", exact: true })
  assert.equal(await release.count(), 1)
  await hideAndReturn(page, screenshot)
  evidence = await readEvidence(page); current = latest(evidence)
  assertNotSent(evidence)
  assert.equal(evidence.business.filter((event) => event.operation === "release").length, 0)
  assert.equal(evidence.business.filter((event) => event.operation === "row-read").length, 0)
  assert.deepEqual(dispatches(evidence).map((event) => event.operation), ["schema", "intents"])
  assert.equal(current.unknownCandidate, null, "Old exact-Intent candidate must remain revoked after screen return")
  assert.equal(await release.count(), 0)
  assert.equal(current.locked, true); assert.equal(current.stage, "outcome_unknown")
  await screenshot("old-candidate-revoked")
  await action(page, "核对原 Intent", "unknown-inspect")
  assert.deepEqual(latest(await readEvidence(page)).unknownCandidate, candidate, "Only fresh explicit inspection restores authority")
  await release.click()
  await page.getByRole("dialog", { name: "释放 1 件商品的确切未确认 Intent？", exact: true }).waitFor()
  await screenshot("fresh-confirmation")
  await action(page, "已核对，释放原 Intent", "unknown-release")
  evidence = await readEvidence(page); current = latest(evidence)
  assert.deepEqual(dispatches(evidence).map((event) => [event.method, event.operation]),
    [["GET", "schema"], ["GET", "intents"], ["GET", "intents"], ["POST", "release"], ["GET", "intents"], ["GET", "row-read"]])
  const released = evidence.business.find((event) => event.operation === "release" && event.event === "response")!
  assert.deepEqual(released.releasedIntentIds, [ids.intent])
  for (const event of dispatches(evidence).filter((event) => event.operation === "intents" || event.operation === "release")) {
    assert.equal(event.destination, ids.store); assert.deepEqual(event.rowIds, [ids.row])
    if (event.operation === "intents") { assert.equal(event.latestPerRow, true); assert.equal(event.limit, 100) }
  }
  const fresh = evidence.business.find((event) => event.operation === "row-read" && event.event === "response")!
  assert.equal(fresh.contentUnchanged, true); assert.equal(fresh.revision, 1); assert.equal(fresh.viewRevision, 2)
  assert.equal(current.locked, false); assert.equal(current.stage, "ready_to_publish")
  assert.equal(current.revision, 1); assert.equal(current.viewRevision, 2); assert.equal(current.ready, true)
  const validations = evidence.native.filter((entry) => entry.kind === "keepalive-native-validation")
  assert.equal(validations.length, 1); assert.equal((validations[0]!.value as { fact: string }).fact, "Passed")
  assertNotSent(evidence)
  await screenshot("fresh-release-not-sent")
}
