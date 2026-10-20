import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { listingProjection } from "../../../tests/listing-row-fixture"
import { renderToStaticMarkup } from "react-dom/server"
import { useSourceImport } from "./use-source-import"
import { resetListingWorkbench, peekListingWorkbench, subscribeListingWorkbench } from "./workbench/listing-workbench-store"
import { createPreparationTracks } from "./prepare/preparation-tracks"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "./model/listing-row"
import { workflowActions } from "./workflow-actions"
import { stageFile } from "@/bindings/file-picker"
import { importSourcePaths, offerIdForSource, upsertImportedListingRow, createImportPaintScheduler, attachCardSchema } from "./product-instances"
import { installFetch, refusal, CARD, SCHEMA, cloudRow, stubPutSource, stagePaths } from "./product-instances-test-fixtures"

test("source filename stem is the exact Offer ID without a card prefix", () => {
  assert.equal(offerIdForSource("SZ-9CXIE0611-0027.jpg"), "SZ-9CXIE0611-0027")
  assert.equal(offerIdForSource("summer.collection.v2.webp"), "summer.collection.v2")
})

test("import rejects invalid filename identities before admission and files only valid images", async () => {
  resetListingWorkbench()
  const invalid = ["SZ-SMWX10.1-001.jpg", "has space.png", "中文.jpg", "ＡBC.jpg", "   .jpg", `${"a".repeat(51)}.jpg`]
  const valid = ["SZ-SMWX10_1-001.jpg", `${"a".repeat(50)}.png`]
  const stub = installFetch((call) => {
    if (call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    return cloudRow(call.body.source.fileName, 0, { source: call.body.source })
  })
  const restoreDevice = stubPutSource()
  const admitted: number[] = []
  const assigned: number[] = []
  try {
    const run = (names: string[]) => importSourcePaths({
      paths: names.map((name) => stageFile(new File([new Uint8Array([0])], name, { type: "image/jpeg" }))),
      cardTemplateId: CARD.id,
      importedLog: "已导入",
      admitNew: async (count) => { admitted.push(count); return count },
      storeResolver: (index) => { assigned.push(index); return "store-1" },
    })
    const rejected = await run(invalid)
    assert.equal(rejected.failures.length, invalid.length)
    assert.equal(rejected.rows.length, 0)
    assert.equal(stub.calls.length, 0)
    assert.deepEqual(admitted, [])
    const mixed = await run([invalid[0]!, valid[0]!, invalid[1]!, valid[1]!])
    assert.deepEqual(mixed.rows.map((row) => row.imageName), valid)
    assert.equal(mixed.failures.length, 2)
    assert.match(mixed.failures[0]!, /SZ-SMWX10\.1-001\.jpg.*货号.*重命名/)
    assert.deepEqual(admitted, [2])
    assert.deepEqual(assigned, [0, 1])
    assert.equal(stub.calls.filter((call) => call.method === "POST").length, 2)
  } finally {
    restoreDevice()
    stub.restore()
    resetListingWorkbench()
  }
})

test("ten source images import one row each, in stable order, with isolated failure", async () => {
  const stub = installFetch((call) => {
    if (call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    const index = Number(call.body.source.fileName.slice("image-".length, -".jpg".length))
    if (index === 4) return refusal(400, "validation", "broken source")
    return cloudRow(`workflow_instance_${index}`, index)
  })
  const restoreDevice = stubPutSource()
  try {
    const paths = stagePaths(10)
    const result = await importSourcePaths({
      paths,
      cardTemplateId: "workflow_template_card",
      importedLog: "已导入",
      storeResolver: () => "store-1",
    })

    const creates = stub.calls.filter((call) => call.url === route("listingRows"))
    assert.equal(creates.length, 10)
    const store = await import("./workbench/listing-workbench-store")
    store.resetListingWorkbench()
    const first = result.rows[0]!
    store.receiveListingProducts([{ product: result.products[first.draftId]!, readiness: listingProjection().readiness }], new Set(), store.listingWorkbenchScope())
    store.projectListingRows((current) => upsertImportedListingRow(current, new Set(), first, new Map()))
    store.projectListingSelection(() => new Set([first.id]))
    assert.equal(store.peekListingWorkbench().rows[0]!.id, first.draftId, "SSE and import use the durable identity")
    assert.equal(store.peekListingWorkbench().selectedIds[0], store.peekListingWorkbench().rows[0]!.id)
    store.resetListingWorkbench()
    // The card is read once for the prompt / template / policy every instance
    // inherits, and the coordinate's Schema once — not once per file.
    assert.equal(stub.calls.filter((call) => call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))).length, 1)
    assert.equal(stub.calls.filter((call) => call.url.startsWith(route("catalogSchema"))).length, 1)
    assert.deepEqual(creates[0]!.body, {
      cardId: "workflow_template_card",
      storeId: "store-1",
      source: { sha256: "sha-image-0.jpg", fileName: "image-0.jpg" },
    })
    assert.deepEqual(
      result.rows.map((row) => row.imageName),
      paths.map((_, index) => `image-${index}.jpg`).filter((_, index) => index !== 4),
    )
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0]!, /image-4\.jpg.*broken source/)
    assert.equal("workflow_instance_4" in result.products, false)
    assert.equal(Object.keys(result.products).length, 9)
    assert.deepEqual(result.products.workflow_instance_0?.draft.values.offer_id, {
      kind: "text",
      value: "image-0",
    })
    assert.equal(
      result.products.workflow_instance_0?.ai_prompt,
      "识图提示词",
      "an instance inherits the card's prompt; it does not carry one of its own",
    )
  } finally {
    restoreDevice()
    stub.restore()
  }
})

test("stopped source imports keep completed rows and omit skipped images from failures", async () => {
  const painted: number[] = []
  const stub = installFetch((call) => {
    if (call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    const index = Number(call.body.source.fileName.slice("image-".length, -".jpg".length))
    return cloudRow(`workflow_instance_${index}`, index)
  })
  const restoreDevice = stubPutSource()
  try {
    // Stopping is cooperative and takes effect between files: the four already
    // in flight settle (they are paid for), and what has not started is skipped
    // rather than reported as a failure.
    const result = await importSourcePaths({
      paths: stagePaths(5),
      cardTemplateId: "workflow_template_card",
      importedLog: "已导入",
      onItem: (item) => {
        painted.push(item.inputIndex)
        void workflowActions.workflowImportSourceAssetsStop()
      },
    })

    assert.equal(result.rows.length, 4)
    assert.equal(result.cancelled, 1)
    assert.deepEqual(result.failures, [])
    assert.deepEqual(painted.sort(), [0, 1, 2, 3])
    assert.equal(stub.calls.filter((call) => call.url === route("listingRows")).length, 4)
  } finally {
    restoreDevice()
    stub.restore()
  }
})

test("the import callback publishes each item before the batch promise resolves", async () => {
  const stub = installFetch((call) => {
    if (call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    const index = Number(call.body.source.fileName.slice("image-".length, -".jpg".length))
    return cloudRow(`workflow_instance_${index}`, index)
  })
  const restoreDevice = stubPutSource()
  try {
    let returned = false
    const streamed: number[] = []
    const pending = importSourcePaths({
      paths: stagePaths(2),
      cardTemplateId: "workflow_template_card",
      importedLog: "已导入",
      onItem: (item) => {
        assert.equal(returned, false, "each item must arrive before the batch resolves")
        streamed.push(item.inputIndex)
      },
    })
    await pending
    returned = true
    assert.deepEqual(streamed.sort(), [0, 1])
  } finally {
    restoreDevice()
    stub.restore()
  }
})

test("imported rows insert after the existing prefix in queue order", () => {
  const stub = (draftId: string, id: string) =>
    ({
      id,
      draftId,
      imageName: `${draftId}.jpg`,
      status: "pending",
      ai: "idle",
      render: "idle",
      upload: "idle",
      log: "",
    }) as const
  const prefixIds = new Set(["old"])
  const positions = new Map([
    ["new-2", 2],
    ["new-1", 1],
  ])
  let rows: ListingRow[] = [stub("old", "row-old")]
  rows = upsertImportedListingRow(rows, prefixIds, stub("new-2", "row-b"), positions)
  rows = upsertImportedListingRow(rows, prefixIds, stub("new-1", "row-a"), positions)
  rows = upsertImportedListingRow(rows, prefixIds, stub("new-1", "row-a-dup"), positions)
  assert.deepEqual(
    rows.map((row) => row.draftId),
    ["old", "new-1", "new-2"],
  )
})

test("two hundred import paints collapse to one frame", async () => {
  const paints: number[][] = []
  const scheduler = createImportPaintScheduler((batch) => {
    paints.push(batch.map((item) => item.inputIndex))
  }, queueMicrotask)
  for (let index = 0; index < 200; index += 1) {
    scheduler.push({ inputIndex: index })
  }
  assert.equal(paints.length, 0, "the workbench must not commit a row per Channel message")
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve)
  })
  assert.equal(paints.length, 1)
  assert.equal(paints[0]!.length, 200)
  scheduler.push({ inputIndex: 200 })
  scheduler.flush()
  assert.equal(paints.length, 2)
  assert.deepEqual(paints[1], [200])
})

test("an imported product without fields reuses the card schema", () => {
  const cardSchema = {
    description_category_id: 1,
    type_id: 2,
    fields: [{ key: "name", attribute_id: 1 }],
    complex_groups: [{ id: 9 }],
  }
  const slim = {
    draft_id: "workflow_instance_1",
    schema: {
      description_category_id: 1,
      type_id: 2,
      fields: [],
      complex_groups: [],
    },
  }
  const attached = attachCardSchema(
    slim as unknown as WorkflowDraftView,
    cardSchema as unknown as import("@/bindings/commands").CategorySchemaView,
  )
  assert.equal(attached.schema.fields.length, 1)
  assert.equal(attached.schema.complex_groups.length, 1)
})

test("the import callback creates selected PNG and JPEG rows and waits for preparation", async () => {
  resetListingWorkbench()
  const busy: boolean[] = []
  let flushed = false
  let hook!: ReturnType<typeof useSourceImport>
  function Capture() {
    hook = useSourceImport({
      cardTemplateId: CARD.id,
      schema: { description_category_id: 17027906, type_id: 91976, fields: [], complex_groups: [] },
      boundStoreIds: ["store-1"], customStoreQuotas: {},
      preparationTracks: { current: createPreparationTracks() },
      flushAutosave: async () => { flushed = true; return true },
      setBusy: (value) => busy.push(value),
    })
    return null
  }
  // SSR supplies Hook refs. Invoke the real action; no mounted effects are claimed.
  renderToStaticMarkup(<Capture />)
  const stub = installFetch((call) => {
    assert.equal(flushed, true, "pending edits settle before import reaches Cloud")
    if (call.method === "GET" && call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.method === "GET" && call.url.startsWith(route("catalogSchema"))) return SCHEMA
    assert.equal(`${call.method} ${call.url}`, "POST /api/listing/rows", "import dispatches no preparation or Seller work")
    const index = Number(call.body.source.fileName.slice("image-".length, -".jpg".length))
    return cloudRow(`workflow_instance_${index}`, index, { source: call.body.source })
  })
  const restoreDevice = stubPutSource()
  let storeCommits = 0
  const unsubscribe = subscribeListingWorkbench((state) => {
    if (state.rows.length) storeCommits += 1
  })
  try {
    const paths = stagePaths(2)
    paths[0] = stageFile(new File([new Uint8Array([0])], "image-0.png", { type: "image/png" }))
    assert.equal(await hook.importSourceSelection(paths), true)
    const state = peekListingWorkbench()
    assert.deepEqual(state.rows.map((row) => row.imageName), ["image-0.png", "image-1.jpg"])
    assert.deepEqual(state.rows.map((row) => row.draftId), ["workflow_instance_0", "workflow_instance_1"])
    assert.deepEqual(state.selectedIds, state.rows.map((row) => row.id))
    assert.equal(Object.keys(state.productDrafts).length, 2)
    assert.equal(storeCommits, 1, "one RAF batch commits products, rows, and selection together")
    for (const row of state.rows) {
      assert.equal(row.log, "已导入，等待确认后开始准备")
      assert.equal(row.status, "pending")
      assert.equal(row.ai, "idle")
      assert.equal(row.render, "idle")
      assert.equal(row.upload, "idle")
    }
    assert.equal(stub.calls.filter((call) => call.method === "POST").length, 2)
    assert.deepEqual(busy, [true, false])
  } finally {
    unsubscribe()
    restoreDevice()
    stub.restore()
    resetListingWorkbench()
  }
})

test("a cold Category Schema cache is synced once, then the create is retried", async () => {
  let refused = false
  const stub = installFetch((call) => {
    if (call.url.startsWith(route("listingCardsById", { id: "placeholder" }).replace("placeholder", ""))) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    if (!refused) {
      refused = true
      return refusal(409, "schema_sync_required", "该类目尚未同步")
    }
    return cloudRow("workflow_instance_0", 0)
  })
  const restoreDevice = stubPutSource()
  try {
    const result = await importSourcePaths({
      paths: stagePaths(1),
      cardTemplateId: "workflow_template_card",
      importedLog: "已导入",
      storeResolver: () => "store-1",
    })

    assert.equal(result.failures.length, 0)
    assert.equal(result.rows.length, 1)
    // Sync then retry, once: the SPA never mints a Schema Revision, so the only
    // answer to a cache miss is to fill the cache through the card's Store
    // — and a second miss means no Store is bound to fill it.
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`).slice(-3),
      ["POST /api/listing/rows", "GET /api/catalog/schema", "POST /api/listing/rows"],
    )
  } finally {
    restoreDevice()
    stub.restore()
  }
})
