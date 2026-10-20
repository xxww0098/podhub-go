import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import type { ListingRow } from "../model/listing-row"
import {
  createPreparationTracks,
  preparationRunning,
  preparationTracksForCard,
  rowPreparing,
} from "../prepare/preparation-tracks"
import { workflowActions } from "../workflow-actions"
import { instance, needsPreparation, row } from "./workbench-test-fixtures"

test("guided preparation reaches Cloud when the card has no PSD", async () => {
  const { usePreparation } = await import("../prepare/use-preparation")
  const { patchListingWorkbench, resetListingWorkbench } = await import("./listing-workbench-store")
  const target = row(1)
  const stored = instance(target)
  stored.psd_template_asset_id = ""
  stored.psd_template_file_name = ""
  resetListingWorkbench()
  patchListingWorkbench({ rows: [target], productDrafts: { [stored.draft_id]: stored } })
  let actions!: ReturnType<typeof usePreparation>
  let calls = 0
  const original = workflowActions.workflowPrepare
  workflowActions.workflowPrepare = async request => {
    calls += 1
    assert.deepEqual(request.row_ids, [stored.draft_id])
    return [{ row_id: stored.draft_id, outcome: "start", blockers: [], product: {
      target_store_id: "store-1",
      lifecycle: { ...stored.lifecycle, ai: "ready" }, readiness: needsPreparation,
    } }]
  }
  function Harness() {
    actions = usePreparation({
      active: true, ready: true, psdTemplateAssetId: "", psdAsset: undefined,
      setPsdAsset() {}, psdAssetTemplateIdRef: { current: "" },
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false },
    })
    return null
  }
  try {
    renderToStaticMarkup(<Harness />)
    await actions.runGuidedPreparation([target.id])
    assert.equal(calls, 1, "the media prerequisite cannot suppress recognition")
  } finally { workflowActions.workflowPrepare = original; resetListingWorkbench() }
})

test("a background preparation releases its own claims without repainting the open card", async () => {
  const { usePreparation } = await import("../prepare/use-preparation")
  const { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } = await import("./listing-workbench-store")
  const targets = [row(101), row(102), row(103)]
  const cardRows = [targets.slice(0, 2), targets.slice(2)]
  const cardIds = ["background-claims-A", "background-claims-B"]
  let unsubscribeView = () => {}
  const tracks = cardIds.map(preparationTracksForCard)
  const preparationTracks = { current: tracks[0]! }
  const guidedPreparationLock = { current: false }
  const pending = new Map<string, (results: WorkflowOperationRowResult[]) => void>()
  const streamed = new Map<string, (result: WorkflowOperationRowResult) => void>()
  const calls: string[][] = []
  const original = workflowActions.workflowPrepare
  workflowActions.workflowPrepare = (request, onRow) => {
    calls.push(request.row_ids)
    streamed.set(request.row_ids[0]!, onRow)
    return new Promise(resolve => pending.set(request.row_ids[0]!, resolve))
  }
  let actions!: ReturnType<typeof usePreparation>
  function Harness() {
    actions = usePreparation({
      active: true, ready: true, psdTemplateAssetId: "", psdAsset: undefined,
      setPsdAsset() {}, psdAssetTemplateIdRef: { current: "" }, preparationTracks,
      guidedPreparationLock,
    })
    return null
  }
  function open(index: number) {
    // SSR does not run effects; attach the same tracker subscription as the view.
    unsubscribeView()
    tracks[index] = preparationTracksForCard(cardIds[index]!)
    preparationTracks.current = tracks[index]!
    guidedPreparationLock.current = false
    resetListingWorkbench()
    patchListingWorkbench({ rows: cardRows[index]!, productDrafts: Object.fromEntries(cardRows[index]!.map(target => [target.draftId, instance(target)])), activity: tracks[index]!.snapshot() })
    unsubscribeView = tracks[index]!.subscribe(activity => patchListingWorkbench({ activity }))
  }
  const result = (target: ListingRow): WorkflowOperationRowResult => ({ row_id: target.draftId, outcome: "start", blockers: [], product: {
      target_store_id: "store-1",
      lifecycle: { ...instance(target).lifecycle, ai: "ready" }, readiness: needsPreparation,
    } })
  const finish = (index: number) => {
    pending.get(cardRows[index]![0]!.draftId)?.(cardRows[index]!.map(result))
  }
  let a: Promise<void> | undefined
  let b: Promise<void> | undefined
  try {
    open(0)
    renderToStaticMarkup(<Harness />)
    a = actions.runGuidedPreparation(cardRows[0]!.map(row => row.id))
    open(1)
    b = actions.runGuidedPreparation(cardRows[1]!.map(row => row.id))
    assert.deepEqual(calls, cardRows.map(rows => rows.map(row => row.draftId)))
    open(0)
    assert.ok(preparationRunning(peekListingWorkbench().activity), "returning to A restores its active claim")
    await actions.runGuidedPreparation([targets[0]!.id])
    assert.equal(calls.length, 2, "returning to A must not start its row twice")
    open(1)
    const before = peekListingWorkbench()
    streamed.get(targets[0]!.draftId)!(result(targets[0]!))
    assert.deepEqual(peekListingWorkbench(), before)
    assert.equal(rowPreparing(tracks[0]!.snapshot(), targets[0]!.id), false, "a streamed completed row releases before A's batch tail")
    assert.equal(rowPreparing(tracks[0]!.snapshot(), targets[1]!.id), true, "A's other row keeps its claim")
    finish(0)
    await a
    assert.deepEqual(peekListingWorkbench(), before, "A's completion must not change B's rows, activity or progress")
    assert.equal(preparationRunning(tracks[0]!.snapshot()), false, "A must release its claims after leaving its UI scope")
    assert.equal(preparationRunning(tracks[1]!.snapshot()), true)
    finish(1)
    await b
    assert.equal(preparationRunning(tracks[1]!.snapshot()), false)
    assert.equal(preparationRunning(peekListingWorkbench().activity), false, "returning to B still observes its old batch releasing")
    assert.notEqual(preparationTracksForCard(cardIds[0]!), tracks[0], "an idle card must leave the retained registry")
    assert.notEqual(preparationTracksForCard(cardIds[1]!), tracks[1])
  } finally {
    unsubscribeView()
    finish(0); finish(1)
    await Promise.allSettled([a, b])
    workflowActions.workflowPrepare = original
    resetListingWorkbench()
  }
})

test("stopping selected preparation before admission leaves the other batch running", async () => {
  const { renderOpfs } = await import("@/bindings/render-opfs")
  const { usePreparation } = await import("../prepare/use-preparation")
  const { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } = await import("./listing-workbench-store")
  const targets = [row(111), row(112)]
  const preparationTracks = { current: createPreparationTracks() }
  const original = { restore: renderOpfs.workflowRestoreTemplatePsd, slice: workflowActions.workflowSlice,
    stop: workflowActions.workflowAnalyzeAssetsStop, cancel: listingHttp.operationsCancelPrepare }
  let release!: () => void
  const template = new Promise<void>(resolve => { release = resolve })
  const localStops: unknown[] = []
  const cloudStops: string[][] = []
  const sent: string[][] = []
  renderOpfs.workflowRestoreTemplatePsd = async () => {
    await template
    return { asset_id: "template", asset: { handle: "template", file_name: "test.psd" }, summary: {
      handle: "template", file_name: "test.psd", canvas: { width: 1, height: 1, bits_per_channel: 8 },
      features: { layers: 0, groups: 0, smart_objects: 0, masks: 0, warped_smart_objects: 0, blend_modes: {} },
      top_groups: [], slots: [], capabilities: [],
    } }
  }
  workflowActions.workflowSlice = async request => {
    sent.push(request.row_ids)
    return request.row_ids.map(row_id => ({ row_id, outcome: "start", blockers: [], product: {
      target_store_id: "store-1",
      lifecycle: { ...instance(targets.find(row => row.draftId === row_id)!).lifecycle, media: "rendered" },
      readiness: needsPreparation,
    } }))
  }
  workflowActions.workflowAnalyzeAssetsStop = async (...args: unknown[]) => { localStops.push(args[0]) }
  listingHttp.operationsCancelPrepare = async request => {
    cloudStops.push(request.draft_ids)
    return { attempted: request.draft_ids.length, cancelled: request.draft_ids.length }
  }
  let actions!: ReturnType<typeof usePreparation>
  function Harness() {
    actions = usePreparation({
      active: true, ready: true, psdTemplateAssetId: "template", psdAsset: undefined,
      setPsdAsset() {}, psdAssetTemplateIdRef: { current: "" }, preparationTracks,
      guidedPreparationLock: { current: false },
    })
    return null
  }
  let a: Promise<void> | undefined
  let b: Promise<void> | undefined
  try {
    resetListingWorkbench()
    patchListingWorkbench({ rows: targets, productDrafts: Object.fromEntries(targets.map(row => [row.draftId, instance(row)])) })
    renderToStaticMarkup(<Harness />)
    a = actions.runRenderRows([targets[0]!.id])
    b = actions.runRenderRows([targets[1]!.id])
    patchListingWorkbench({ selectedIds: [targets[1]!.id] })
    actions.stopPreparation()
    assert.deepEqual(localStops, [[targets[1]!.draftId]], "local stop receives the selected durable row identity")
    assert.deepEqual(cloudStops, localStops, "local and Cloud stop target the same rows")
    assert.equal(peekListingWorkbench().guidedPreparation.stopRequested, false, "stopping selected B must leave Stop available for A")
    release()
    await Promise.all([a, b])
    assert.deepEqual(sent, [[targets[0]!.draftId]], "stopping B must not cancel A's pre-admission work")
    assert.equal(preparationRunning(preparationTracks.current.snapshot()), false)
  } finally {
    release()
    await Promise.allSettled([a, b])
    renderOpfs.workflowRestoreTemplatePsd = original.restore
    workflowActions.workflowSlice = original.slice
    workflowActions.workflowAnalyzeAssetsStop = original.stop
    listingHttp.operationsCancelPrepare = original.cancel
    resetListingWorkbench()
  }
})
