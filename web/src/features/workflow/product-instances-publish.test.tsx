import assert from "node:assert/strict"
import test from "node:test"
import { composeBlockedBySignedOut, fieldInvalidRowPatch, publishFailureStaysOnRow } from "./product-instances"

test("remaining workflow wiring checks pending action-level coverage", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./workflow-screen.tsx", import.meta.url), "utf8")
  const library = await readFile(new URL("./workflow-screen-library.ts", import.meta.url), "utf8")
  const stream = await readFile(new URL("./workflow-screen-stream.ts", import.meta.url), "utf8")
  const capabilities = await readFile(new URL("./workflow-publish-capabilities.ts", import.meta.url), "utf8")
  const preparation = await readFile(new URL("./prepare/use-preparation.ts", import.meta.url), "utf8")
  const publish = await readFile(new URL("./submit/use-publish-queue.ts", import.meta.url), "utf8")
  const imports = await readFile(new URL("./use-source-import.ts", import.meta.url), "utf8")
  // Toolbar-to-hook JSX wiring still needs mounted screen coverage.
  assert.equal(source.match(/runAiRows\(/g)?.length, 2)
  assert.equal(source.match(/runRenderRows\(/g)?.length, 1)
  assert.equal(source.match(/runDeliverRows\(/g)?.length, 1)
  assert.match(source, /onRunAiRows=\{\(ids\) => void runAiRows\(ids\)\}/)
  assert.match(source, /onRunRenderRows=\{\(ids\) => \{\s*if \(templateReady\) void runRenderRows\(ids\)/)
  assert.match(source, /onRunDeliverRows=\{\(ids\) => void runDeliverRows\(ids\)\}/)
  const openRunner = library.slice(library.indexOf("async function openRunner("), library.indexOf("async function restoreTemplatePsd"))
  assert.match(openRunner, /await Promise\.all\(\[\s*restoreTemplatePsd\(/)
  assert.ok(openRunner.indexOf("restoreTemplatePsd(") < openRunner.indexOf('setMode("runner")'))
  assert.match(imports, /LIVE_IMPORT = "live:import"/)
  assert.match(imports, /正在导入源图/)
  assert.match(imports, /workflowImportSourceAssetsStop/)
  assert.match(imports, /label: stopping \? "停止中" : "停止导入"/)
  // The signed-out refusal lives in publish-policy's preflight, fed the cached overview.
  assert.match(publish, /publishPreflight\(clicked, selection, peekAccountOverview\(\)\)/)
  assert.match(
    source,
    /removeWorkbenchRows\(ids, \{ flushRowsFor, forgetRows \}\)/,
    "the production delete control uses optimistic removal with durable deletion",
  )
  assert.doesNotMatch(
    source,
    /队列运行或暂停期间不能删除商品/,
    "a paused send queue must not trap settled rows the operator is allowed to remove",
  )
  assert.doesNotMatch(
    source,
    /请完成后再删除/,
    "preparation in flight must not refuse a delete",
  )
  const restore = stream.slice(stream.indexOf("function restoreProductInstances"))
  assert.match(restore, /connectListingCardStream/)
  assert.doesNotMatch(restore, /workflowPrepare|workflowRecognize|runGuidedPreparation|runAiRows/)

  const sendStart = publish.indexOf("async function startPublish(")
  const sendEnd = publish.indexOf("async function pausePublish()", sendStart)
  const sendSource = publish.slice(sendStart, sendEnd)
  assert.ok(sendStart >= 0 && sendEnd > sendStart)
  assert.equal(publish.match(/workflowActions\.workflowSend\(/g)?.length, 1)
  assert.doesNotMatch(publish, /workflowPublishStart\(/)
  assert.doesNotMatch(source, /workflowPublishStart\(/)
  assert.match(publish, /workflowPublishPause\(/)
  assert.match(publish, /workflowPublishStop\(/)
  assert.match(publish, /async function resumePublish\(\)/)
  assert.doesNotMatch(
    publish,
    /reconcileListingCard\(cardTemplateId\)/,
    "resume must start from the local receipt state without scheduling reconciliation",
  )
  assert.match(
    source,
    /onPauseQueue=\{\(\) => \{ publishControlVersion.current\+\+; void pausePublish\(\)/,
    "the production workbench must expose the Cloud pause command",
  )
  assert.match(
    publish,
    /cancelInFlightIntentsForDrafts\(/,
    "停止后续发送 must soft-cancel Cloud intents, not only the local lane",
  )
  assert.match(
    publish,
    /cancelInFlightIntentForDraft\(/,
    "per-row 取消发送 must soft-cancel that draft's Cloud intent",
  )
  assert.doesNotMatch(publish, /async function sendRows\(/)
  assert.doesNotMatch(publish, /async function sendRow\(/)
  assert.doesNotMatch(publish, /async function awaitPublishedRow\(/)
  assert.doesNotMatch(
    source,
    /setQueuePaused\(Boolean\(queueState\?\.paused \|\| queueState\?\.running\)\)/,
  )
  assert.ok(
    sendSource.indexOf("publishPreflight(clicked, selection, peekAccountOverview())") >= 0 &&
    sendSource.indexOf("publishPreflight(clicked, selection, peekAccountOverview())") <
      sendSource.indexOf("workflowActions.workflowSend("),
    "sign-in admission must precede the Cloud start verb",
  )
  assert.ok(
    sendSource.indexOf("flushAutosave()") <
      sendSource.indexOf("workflowActions.workflowSend("),
    "send-click assembly must persist the on-screen fields before Cloud overlays and composes",
  )
  assert.match(
    sendSource,
    /仍有字段没有保存到云端，请重试保存后再发送/,
  )
  assert.doesNotMatch(sendSource, /allowed_actions\.includes\("publish"\)/)

  const openStart = library.indexOf("async function openRunner(")
  const openEnd = library.indexOf("async function restoreTemplatePsd(", openStart)
  const openSource = library.slice(openStart, openEnd)
  assert.match(openSource, /const generation = \+\+runnerGeneration\.current/)
  assert.match(openSource, /setPsdAsset\(undefined\)/)
  assert.match(openSource, /restoreProductInstances\(card, generation\)/)
  assert.doesNotMatch(source, /listingCardPreviewImport/)
  const restoreSource = stream.slice(stream.indexOf("function restoreProductInstances("))
  const restoreStatusIndex = restoreSource.indexOf("renderOpfs.workflowRestoreProductInstances(")
  assert.ok(restoreStatusIndex >= 0, "restoring local assets remains independent of receipt state")
  assert.doesNotMatch(
    restoreSource,
    /reconcileListingCard\(card\.draft_id\)/,
    "restoring local assets must not schedule a reconciliation",
  )
  // All three verbs admit only rows whose Product Instance is already durable,
  // and they pass through one gate rather than three copies of it — a verb that
  // grew its own admission check is a verb that can forget one. The map is read
  // through a getter at admission, so a batch sees the instance a concurrent
  // import just committed.
  const batch = await readFile(new URL("./batch-operation.ts", import.meta.url), "utf8")
  const listing = await readFile(new URL("../../bindings/http-listing.ts", import.meta.url), "utf8")
  assert.equal(batch.match(/rowsReadyForPreparation\(targets, drafts\)/g)?.length, 1)
  // `admitDurableRows` appears twice: its definition and the one call in
  // `runWorkflowOperationBatch`, which every verb goes through.
  assert.equal(batch.match(/admitDurableRows\(/g)?.length, 2)
  assert.equal(batch.match(/const drafts = deps\.drafts\(\)/g)?.length, 1)
  assert.doesNotMatch(batch, /listingQueueSubmitFields|listingCardSubmitImport|submitProductRow/)
  assert.doesNotMatch(listing, /listingCardSubmitImport|WorkflowSubmitRequest/)
  assert.match(listing, /patchListingRow/)
  assert.doesNotMatch(capabilities, /repairAndSubmitListingRow|recover/)
  assert.doesNotMatch(publish, /repairAndSubmitListingRow/)
  assert.match(source, /brandRepairCapability: publishCapabilities\?\.brandRepair/)
  assert.match(
    source,
    /useUnknownRelease\(\s*busy \|\| repairInFlight, publishCapabilities\?\.unknownRelease, publishCapabilities\?\.inspectUnknownRows\)/,
  )
  assert.match(capabilities, /native.clearSearchTags/)
  assert.match(capabilities, /patchListingRow/)
  assert.match(capabilities, /readListingRowFresh/)
  assert.match(capabilities, /native.revalidate/)
  // SSR callback tests do not run the inactive-card effect.
  assert.match(preparation, /retainActivePreparationProgress/)
  assert.match(publish, /取消发送/)
  assert.match(
    publish,
    /cancelInFlightIntentForDraft\(/,
  )
  assert.match(batch, /deps\.settleProgress\(/)
})

test("field-invalid publish stays on the row and does not look like a tab change", () => {
  assert.equal(
    publishFailureStaysOnRow({ code: "workflow_publish_fields_invalid", message: "缺标题" }),
    true,
  )
  assert.equal(publishFailureStaysOnRow({ code: "workflow_publish_media_missing" }), false)
  const patch = fieldInvalidRowPatch({
    code: "workflow_publish_fields_invalid",
    message: "缺标题",
  })
  assert.equal(patch.status, "failed")
  assert.match(patch.log, /缺标题/)
})

test("card create is blocked when nobody is signed in", () => {
  assert.equal(composeBlockedBySignedOut(undefined), true)
  assert.equal(composeBlockedBySignedOut({ session: { authenticated: false } }), true)
  assert.equal(composeBlockedBySignedOut({ session: { authenticated: true } }), false)
})

