/** Production hooks and native results, exercised through visible fixture controls. */
import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import type { Scenario } from "./publish-pipeline-browser-contract"
import { action, readEvidence } from "./publish-pipeline-browser-scenarios"
import { waitForPage } from "./publish-pipeline-browser-wait"
const workbenchIds = { row: "fixture-workbench-row", store: "fixture-workbench-store", intent: "fixture-exact-intent" }

const latest = async (page: Page) => (await readEvidence(page)).native.filter((entry) => entry.kind === "workbench-state").at(-1)!.value as {
  stage: string; revision: number; viewRevision: number; locked: boolean; ready: boolean; nativeTagsCleared: boolean
}
export async function driveWorkbenchScenario(page: Page, scenario: Scenario, screenshot: (label: string) => Promise<void>) {
  const brand = scenario.startsWith("brand")
  const mode = brand ? scenario === "brand-no-action" || scenario === "brand-stale-revision" ? scenario : "brand"
    : scenario === "unknown-release" || scenario === "unknown-stale-context" ? "unknown" : scenario
  await page.getByRole("combobox", { name: "工作台外部事实" }).selectOption(mode)
  if (scenario === "brand-stop" || scenario === "brand-scope") await page.getByRole("checkbox", { name: "保持原生标签编辑后的等待" }).check()
  await waitForPage(page, (count) => {
    const configuration = window.publishPipelineMetrics.actions.filter((entry) => entry.name === "workbench-configure")
    return configuration.length === count && configuration.every((entry) => entry.end !== undefined && entry.status === "passed")
  }, scenario === "brand-stop" || scenario === "brand-scope" ? 2 : 1)
  await action(page, "明确载入工作台夹具", "workbench-load")
  const section = page.getByRole("region", { name: "生产工作台动作" })
  await section.locator("summary").first().click()
  await screenshot("error")
  const first = await readEvidence(page)
  assert.equal(first.business.filter((event) => event.event === "dispatch").length, 1)
  assert.equal(first.business.find((event) => event.event === "dispatch")!.category, "C")
  assert.equal(first.business.filter((event) => event.operation === "inbox").length, 0)
  if (brand) {
    const repair = section.getByRole("button", { name: "修复品牌字段", exact: true })
    if (scenario === "brand-no-action" || scenario === "brand-stale-revision") {
      assert.equal(await repair.count(), 0)
      assert.equal((await latest(page)).revision, 1)
      assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "row-patch").length, 0)
      await screenshot("blocked-action")
      return
    }
    assert.equal(await repair.count(), 1)
    await repair.click()
    if (scenario === "brand-stop" || scenario === "brand-scope") {
      await waitForPage(page, () => window.publishPipelineMetrics.native.some((entry) => entry.kind === "brand-native-held"), undefined)
      await screenshot("loading")
      if (scenario === "brand-stop") await action(page, "停止工作台动作", "workbench-stop")
      else await action(page, "离开工作台作用域", "workbench-scope")
      assert.equal(await repair.count(), 0)
      await action(page, "释放原生编辑等待", "mock-release")
    }
    await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "brand-repair" && entry.end !== undefined), undefined)
    const evidence = await readEvidence(page), current = await latest(page)
    const edits = evidence.native.filter((entry) => entry.kind === "brand-native-edit")
    assert.equal(edits.length, 1)
    const edited = edits[0]!.value as { fact: string; cleared: string[]; handEditedKeys: string[]; manual: boolean; tagsAbsent: boolean;
      mediaPreserved: boolean; aiPreserved: boolean; sourcePreserved: boolean; otherFieldsPreserved: boolean }
    assert.equal(edited.fact, "Passed"); assert.equal(edited.manual, true); assert.equal(edited.tagsAbsent, true)
    assert.ok(edited.cleared.includes("native_search_tags")); assert.ok(edited.handEditedKeys.includes("native_search_tags"))
    assert.equal(edited.mediaPreserved, true); assert.equal(edited.aiPreserved, true)
    assert.equal(edited.sourcePreserved, true); assert.equal(edited.otherFieldsPreserved, true)
    const writes = evidence.business.filter((event) => event.operation === "row-patch" && event.event === "dispatch")
    if (scenario === "brand-stop" || scenario === "brand-scope") {
      assert.equal(writes.length, 0); assert.equal(current.revision, 1); assert.equal(current.stage, "publish_rejected")
      if (scenario === "brand-scope") {
        await action(page, "返回工作台作用域", "workbench-scope")
        assert.equal(await repair.count(), 0)
        assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "row-patch").length, 0)
      }
    } else {
      assert.equal(writes.length, 1)
      assert.deepEqual(evidence.business.filter((event) => event.event === "dispatch").map((event) => [event.method, event.operation]),
        [["GET", "schema"], ["PATCH", "row-patch"], ["GET", "row-read"]])
      const saved = evidence.business.find((event) => event.operation === "row-patch" && event.event === "response")!
      assert.equal(saved.baseRevision, 1); assert.equal(saved.revision, 2); assert.equal(saved.viewRevision, 2)
      assert.equal(current.revision, 2); assert.equal(current.viewRevision, 2); assert.equal(current.nativeTagsCleared, true)
      assert.equal(current.stage, "ready_to_publish"); assert.equal(current.ready, true)
      assert.equal(await repair.count(), 0)
      const validations = evidence.native.filter((entry) => entry.kind === "workbench-native-validation")
      assert.equal(validations.length, 2)
      assert.ok(validations.every((entry) => (entry.value as { fact: string }).fact === "Passed"))
      await screenshot("native-repaired-not-sent")
    }
    assert.equal(evidence.business.filter((event) => event.operation === "submit").length, 0)
    assert.equal(evidence.business.filter((event) => event.operation === "inbox").length, 0)
    return
  }
  assert.equal(await section.getByRole("button", { name: "修复品牌字段", exact: true }).count(), 0)
  await action(page, "核对原 Intent", "unknown-inspect")
  let evidence = await readEvidence(page)
  const inspect = evidence.business.filter((event) => event.operation === "intents" && event.event === "dispatch")
  assert.equal(inspect.length, 1); assert.equal(inspect[0]!.destination, workbenchIds.store)
  assert.deepEqual(inspect[0]!.rowIds, [workbenchIds.row]); assert.equal(inspect[0]!.latestPerRow, true); assert.equal(inspect[0]!.limit, 100)
  const open = page.getByRole("button", { name: "核对后释放 1 件商品的确切未确认 Intent", exact: true })
  if (scenario === "unknown-no-resident") {
    assert.equal(await open.count(), 0); assert.equal((await latest(page)).locked, true)
    assert.equal(evidence.business.filter((event) => event.operation === "release").length, 0)
    assert.deepEqual(evidence.business.filter((event) => event.event === "dispatch").map((event) => event.operation), ["schema", "intents"])
    await screenshot("resident-session-missing-manual")
    return
  }
  await open.click()
  await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "unknown-confirm" && entry.end !== undefined), undefined)
  await page.getByRole("dialog", { name: "释放 1 件商品的确切未确认 Intent？", exact: true }).waitFor()
  await screenshot("confirmation")
  if (scenario === "unknown-stale-context") {
    await page.getByRole("button", { name: "取消", exact: true }).click()
    await action(page, "离开工作台作用域", "workbench-scope")
    await action(page, "返回工作台作用域", "workbench-scope")
    assert.equal(await open.count(), 0)
    assert.equal(await page.getByRole("button", { name: "已核对，释放原 Intent", exact: true }).count(), 0)
    assert.equal((await latest(page)).locked, true)
    assert.equal((await readEvidence(page)).business.filter((event) => event.operation === "release").length, 0)
    await screenshot("old-proof-revoked")
    return
  }
  await action(page, "已核对，释放原 Intent", "unknown-release")
  evidence = await readEvidence(page)
  const releases = evidence.business.filter((event) => event.operation === "release" && event.event === "dispatch")
  assert.equal(releases.length, 1)
  assert.deepEqual(releases[0]!.rowIds, [workbenchIds.row]); assert.equal(releases[0]!.destination, workbenchIds.store)
  const current = await latest(page)
  if (scenario === "unknown-missing-id") {
    assert.deepEqual(evidence.business.find((event) => event.operation === "release" && event.event === "response")!.releasedIntentIds, [])
    assert.equal(inspect.length, 1)
    assert.equal(evidence.business.filter((event) => event.operation === "intents" && event.event === "dispatch").length, 1)
    assert.equal(evidence.business.filter((event) => event.operation === "row-read").length, 0)
    assert.equal(current.locked, true); assert.equal(current.stage, "outcome_unknown")
  } else {
    assert.deepEqual(evidence.business.find((event) => event.operation === "release" && event.event === "response")!.releasedIntentIds, [workbenchIds.intent])
    assert.deepEqual(evidence.business.filter((event) => event.event === "dispatch").map((event) => [event.method, event.operation]),
      [["GET", "schema"], ["GET", "intents"], ["POST", "release"], ["GET", "intents"], ["GET", "row-read"]])
    if (scenario === "unknown-readback-failed") {
      assert.equal(current.locked, true); assert.equal(current.stage, "outcome_unknown"); assert.equal(current.viewRevision, 1)
      assert.equal(evidence.native.filter((entry) => entry.kind === "workbench-native-validation").length, 0)
    } else {
      assert.equal(current.locked, false); assert.equal(current.stage, "ready_to_publish")
      assert.equal(current.revision, 1); assert.equal(current.viewRevision, 2); assert.equal(current.ready, true)
      const fresh = evidence.business.find((event) => event.operation === "row-read" && event.event === "response")!
      assert.equal(fresh.contentUnchanged, true); assert.equal(fresh.revision, 1); assert.equal(fresh.viewRevision, 2)
      const validations = evidence.native.filter((entry) => entry.kind === "workbench-native-validation")
      assert.equal(validations.length, 1); assert.equal((validations[0]!.value as { fact: string }).fact, "Passed")
    }
  }
  assert.equal(evidence.business.filter((event) => event.operation === "submit").length, 0, "release never submits")
  assert.equal(evidence.business.filter((event) => event.operation === "inbox").length, 0)
  await screenshot(scenario === "unknown-release" ? "released-validated-not-sent" : "locked-after-missing-proof")
}
