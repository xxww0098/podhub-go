import { listingProjection } from "../../../tests/listing-row-fixture"
/**
 * The workbench thunks that became HTTP calls: catalog reads, Field Packs,
 * SKU preview, and the row-section writes behind videos and 清空生成内容.
 *
 * Each test asserts the route, the method and the projection.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { cardDraftView, listingHttp, patchListingRow, recoverListingIntent, reconcileListingCard } from "@/bindings/http-listing"
import { packsHttp } from "@/bindings/http-packs"
import { workflowActions } from "./workflow-actions"
import { cardPayload, catalogSchemaView, catalogTreeNodes } from "@/bindings/listing-projection"
import { resetCardSessions } from "./card/card-session"
import { stubOpfs, restoreOpfsTestGlobals } from "@/render/opfs-test-support"
import { putTemplate } from "@/render/opfs"
import { persistUserTemplate } from "./card/template-assets"
import {
  listingCardSaveCategoryDraft,
  listingCardSaveDefaultPrice,
  workflowPublishPause,
  workflowPublishStop,
  workflowSaveQueueState,
} from "./card/card-writes"

type Call = { url: string, method: string, body: any, headers?: Record<string, string> }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
  // Many tests below reuse the same fixture card id (`CARD.id`); without this,
  // a card session opened by an earlier test would silently answer a later
  // one instead of the fresh fixture that test's own `reply` closure sets up.
  resetCardSessions()
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers && !(init.headers instanceof Headers)
      ? Object.fromEntries(Object.entries(init.headers as Record<string, string>))
      : undefined
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers,
    }
    calls.push(call)
    const response = reply(call)
    if (response instanceof Response) return response
    return new Response(JSON.stringify({ data: response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const PACK = {
  id: "pack-1",
  name: "常用默认值",
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  library_id: null,
  author_is_self: true,
  shared: false,
  active: true,
  source: "cloud",
  updated_at_ms: 0,
}

test("a cached Schema becomes the view the field table reads, complex groups included", () => {
  const view = catalogSchemaView({
    description_category_id: 17027906,
    type_id: 91976,
    language: "zh_hans",
    fetched_at_ms: 0,
    fields: [
      {
        key: "attribute_9048",
        label: "型号名称",
        group: "基础",
        editor: "text",
        required: true,
        collection: false,
        attribute_id: "9048",
        aspect: true,
      },
      {
        key: "attribute_4191",
        label: "简介",
        group: "描述",
        editor: "text",
        required: false,
        collection: true,
        attribute_id: "4191",
        complex_id: "100001",
        complex_group_collection: true,
        dictionary_id: "1234",
        aspect: false,
        options: [{ id: "7", value: "红", info: "", picture: "" }],
      },
      { key: "offer_id", label: "货号", group: "基础", editor: "text", required: true, collection: false },
    ],
  })
  // A field with a Seller attribute id is an `attribute`; one without is a
  // fixed Listing field (`listing_core::projections::category_field_view`).
  assert.deepEqual(view.fields.map((field) => field.source), ["attribute", "attribute", "fixed"])
  assert.equal(view.fields[0]!.attribute_id, 9048)
  // Ozon's `is_aspect` survives the cache wire, and the third state survives
  // too: the third field carries no key at all (a payload written before the
  // metadata existed), and that must stay `null` — the variant rules read it
  // as "rule unknown, refresh", never as "not a variant dimension".
  assert.deepEqual(
    view.fields.map((field) => field.aspect),
    [true, false, null],
  )
  assert.equal(view.fields[1]!.constraints.dictionary_id, 1234)
  assert.deepEqual(view.fields[1]!.options, [{ id: 7, value: "红", info: "", picture: "" }])
  assert.deepEqual(view.complex_groups, [
    { complex_id: 100001, name: "描述", collection: true, field_keys: ["attribute_4191"] },
  ])
})

test("the category tree keeps its shape and an absent child list reads as none", () => {
  assert.deepEqual(
    catalogTreeNodes([
      { description_category_id: 1, category_name: "家居", type_id: 0, type_name: "", disabled: false, parent_id: null },
      { description_category_id: 1, category_name: "家居", type_id: 2, type_name: "海报", disabled: true, parent_id: 0 },
    ]),
    [
      {
        description_category_id: 1,
        category_name: "家居",
        type_id: 0,
        type_name: "",
        disabled: false,
        children: [
          {
            description_category_id: 1,
            category_name: "家居",
            type_id: 2,
            type_name: "海报",
            disabled: true,
            children: [],
          },
        ],
      },
    ],
  )
})

test("category schema uses platform credentials even when a caller supplies a Store", async () => {
  const stub = recordFetch(() => null)
  try {
    await assert.rejects(
      listingHttp.listingCardLoadCategorySchema({
        description_category_id: 17027906,
        type_id: 91976,
        language: "zh_hans",
        target_store_id: "store-uuid",
      }),
      /平台类目密钥/,
    )
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/catalog/schema?descriptionCategoryId=17027906&typeId=91976&language=zh_hans",
    ])
  } finally {
    stub.restore()
  }
})

test("dictionary search uses the platform route without a Store", async () => {
  const stub = recordFetch((call) => call.method === "POST"
    ? [{ id: "7", value: "红", info: "", picture: "" }]
    : {
        description_category_id: 11, type_id: 101, language: "default", fetched_at_ms: 0,
        fields: [{ key: "attribute_4191", label: "颜色", group: "基础", editor: "dictionary_search",
          required: false, collection: false, attribute_id: "4191", dictionary_id: "1234" }],
      })
  try {
    const options = await listingHttp.listingCardSearchCategoryDictionary({
      description_category_id: 11, type_id: 101, field_key: "attribute_4191", query: " 红色 ", limit: 200,
    })
    assert.deepEqual(options, [{ id: 7, value: "红", info: "", picture: "" }])
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/catalog/schema?descriptionCategoryId=11&typeId=101&language=default",
      "POST /api/catalog/schema/dictionary-search",
    ])
    assert.deepEqual(stub.calls[1].body, {
      attribute_id: 4191, description_category_id: 11, type_id: 101, language: "default", limit: 100, value: "红色",
    })
  } finally {
    stub.restore()
  }
})

test("card reconcile schedules by card and manual recovery uses the exact selected intent", async () => {
  const stub = recordFetch((call) => {
    if (call.url.endsWith("/reconcile")) return { scheduledCount: 2 }
    return {
      items: [{
        rowId: "row-1", created: true, intent: {
          id: "new-intent", state: "queued", client_operation_id: "op-2", updated_at_ms: 2,
        },
      }],
    }
  })
  try {
    assert.deepEqual(await reconcileListingCard("card/1"), { scheduledCount: 2 })
    const recovered = await recoverListingIntent("original-intent")
    assert.equal(recovered.operation.intent_id, "new-intent")
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "POST /api/listing/cards/card%2F1/reconcile",
      "POST /api/listing/intents/original-intent/recover",
    ])
  } finally {
    stub.restore()
  }
})

test("Field Packs are per-User routes, and a share is a POST on the Pack itself", async () => {
  const stub = recordFetch((call) => (call.url.includes("?") ? { packs: [PACK] } : PACK))
  try {
    const listed = await packsHttp.fieldPackList({
      description_category_id: 17027906,
      type_id: 91976,
      language: "zh_hans",
    })
    assert.equal(listed[0]!.library_id, undefined, "a nullable wire field is absent in the view")
    await packsHttp.fieldPackSetActive({ pack_id: "pack-1" })
    await packsHttp.fieldPackSetShared({ pack_id: "pack-1", shared: true })
    await packsHttp.fieldPackDelete({ pack_id: "pack-1" })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/field-packs?descriptionCategoryId=17027906&typeId=91976&language=zh_hans",
      "PATCH /api/field-packs/pack-1",
      "POST /api/field-packs/pack-1/share",
      "DELETE /api/field-packs/pack-1",
    ])
    assert.deepEqual(stub.calls[1]!.body, { active: true })
    assert.deepEqual(stub.calls[2]!.body, { shared: true })
    assert.equal(stub.calls[3]!.body, undefined)
  } finally {
    stub.restore()
  }
})

const ROW = {
  id: "row-1",
  card_id: "card-1",
  store_id: "store-1",
  revision: 4,
  view_revision: 1,
  projection: listingProjection(),
  content_state: "ready",
  media_state: "ready",
  validation_state: "passed",
  submission_state: "none",
  draft: { values: {}, complex_values: [] },
  validation_issues: [],
  media: { images: [], videos: [{ role: "product", origin: "managed_upload", file_name: "a.mp4", content_type: "video/mp4", size_bytes: 1, duration_ms: 1000, content_hash: "sha256:a" }] },
  ai: { candidates: [] },
  source: { assetId: "", sha256: "s", fileName: "image-1.jpg" },
  payload: {},
  updated_at_ms: 0,
}

test("removing a product video drops only the named content hash", async () => {
  const stub = recordFetch(() => ROW)
  try {
    await workflowActions.workflowRemoveVideo("row-1", "product", "sha256:a")
    assert.deepEqual(stub.calls[1]!.body.changes.media.videos, [])
  } finally {
    stub.restore()
  }
})

test("清空生成内容 uses Cloud's atomic reset and returns its row projection", async () => {
  const stub = recordFetch(() => ROW)
  try {
    const results = await workflowActions.workflowClearGeneratedContent({ draft_ids: ["row-1"] })
    assert.equal(results[0]!.draft_id, "row-1")
    assert.deepEqual(results[0]!.row, ROW)
    assert.equal(results[0]!.status?.lifecycle.ai, "ready")
    const write = stub.calls[1]!.body
    assert.deepEqual(write, {
      baseRevision: 4,
      clearGeneratedContent: true,
    })
  } finally {
    stub.restore()
  }
})

// --- Listing Cards, rows and the publish queue ------------------------------

const CARD = {
  id: "card-1",
  title: "海报卡片",
  store_id: "store-1",
  revision: 7,
  payload: {
    categoryKey: "17027906:91976:zh_hans",
    descriptionCategoryId: 17027906,
    typeId: 91976,
    language: "zh_hans",
    schemaRevision: "rev-1",
    defaults: { values: {}, complex_values: [] },
    aiPromptId: "prompt-1",
    aiPromptSha256: "sha-prompt",
    aiPrompt: "识图提示词",
    aiPromptFileName: "prompt.md",
    psdTemplateAssetId: "template-sha",
    psdTemplateSha256: "template-sha",
    psdTemplateFileName: "poster.psd",
    targetStoreId: "store-1,store-2",
    aiFieldPolicy: { allowed_field_keys: ["attribute_9048"], protected_field_keys: ["price"] },
    videos: [{
      role: "product",
      origin: "managed_upload",
      file_name: "card-a.mp4",
      content_type: "video/mp4",
      size_bytes: 12,
      duration_ms: 48_000,
      content_hash: "sha256:card-a",
    }],
    queue: { paused: false, stopAfterCurrent: false, nextPosition: 3, frozenRowIds: ["row-1"] },
  },
  updated_at_ms: 1_700_000_000_000,
}

test("cardPayload keeps unknown keys instead of reconstructing a visible-only document", () => {
  const kept = cardPayload({
    ...CARD,
    payload: { ...CARD.payload, sellerApiKey: "sk-keep", internalNotes: "author only" },
  } as typeof CARD)
  assert.equal((kept as { sellerApiKey?: string }).sellerApiKey, "sk-keep")
  assert.equal((kept as { internalNotes?: string }).internalNotes, "author only")
  assert.equal(kept.aiPrompt, "识图提示词")
})

const SCHEMA_DATA = {
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  fetched_at_ms: 0,
  fields: [
    { key: "offer_id", label: "货号", group: "基础", editor: "text", required: true, collection: false },
  ],
}

test("a live card snapshot shares projected row pages with its queue", async () => {
  const stub = recordFetch((call) => {
    if (call.url === "/api/listing/cards/card-1") return CARD
    if (call.url.startsWith("/api/listing/rows?")) {
      return call.url.includes("cursor=")
        ? { items: [{ ...ROW, id: "row-2", submission_state: "queued", projection: listingProjection({ stage: "queued" }) }] }
        : { items: [{ ...ROW, projection: listingProjection({ stage: "accepted", sku: 123 }) }], nextCursor: "rows:next" }
    }
    throw new Error(`unexpected read: ${call.url}`)
  })
  try {
    const snapshot = await workflowActions.workflowReadCardStatus("card-1")
    assert.equal(snapshot.queue.running, true)
    assert.deepEqual(snapshot.rows.map(({ draftId, status }) => [draftId, status.lifecycle.stage, status.lifecycle.ozon_sku]), [
      ["row-1", "accepted", 123], ["row-2", "queued", undefined],
    ])
    assert.equal(stub.calls.length, 3, "one card + two row pages")
  } finally {
    stub.restore()
  }
})

function cardReply(call: Call): unknown {
  if (call.url.startsWith("/api/catalog/schema")) return SCHEMA_DATA
  if (call.url.startsWith("/api/listing/rows")) return { items: [] }
  // A `PATCH` answers with the card it wrote, revision bumped — the same thing
  // `cas_patch_card` does, so the caller's projection is of the new state.
  if (call.method === "PATCH") {
    return { ...CARD, revision: CARD.revision + 1, payload: call.body.payload ?? CARD.payload }
  }
  return CARD
}

test("the card list is one page of Cloud cards projected onto the library tile", async () => {
  const stub = recordFetch(() => ({ items: [CARD] }))
  try {
    const [summary] = await listingHttp.listingCardListSavedDrafts()
    assert.equal(stub.calls[0]!.url, "/api/listing/cards?limit=100")
    assert.equal(summary!.draft_id, "card-1")
    assert.equal(summary!.display_name, "海报卡片")
    assert.equal(summary!.description_category_id, 17027906)
    // A card is bound to every Store its rows are spread across; the column
    // holds one uuid, so the list is the payload's.
    assert.equal(summary!.target_store_id, "store-1,store-2")
    assert.equal(summary!.psd_template_file_name, "poster.psd")
    assert.equal(summary!.size, undefined)
    assert.equal(summary!.price, undefined)
    assert.equal(summary!.video_count, 1)
  } finally {
    stub.restore()
  }
})

test("opening a card reads the card and fills its coordinate's Schema through platform credentials", async () => {
  const stub = recordFetch(cardReply)
  try {
    const card = await listingHttp.listingCardLoadCard("card-1")
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/cards/card-1",
      // Schema reads are platform-wide, independent of the bound Store.
      "GET /api/catalog/schema?descriptionCategoryId=17027906&typeId=91976&language=zh_hans",
    ])
    assert.equal(card.kind, "template")
    assert.equal(card.ai_prompt, "识图提示词")
    // The digest is the browser's asset id: OPFS files the template under it.
    assert.equal(card.psd_template_asset_id, "template-sha")
    assert.equal(card.schema.fields.length, 1)
    assert.deepEqual(card.ai_field_policy.allowed_field_keys, ["attribute_9048"])
    assert.equal(card.lifecycle.product_videos[0]!.file_name, "card-a.mp4")
  } finally {
    stub.restore()
  }
})

test("saving a card template is a PATCH under its own revision that keeps the queue", async () => {
  stubOpfs()
  const templateSha = await putTemplate(new Uint8Array([1, 2, 3]))
  const stub = recordFetch((call) => call.method === "GET" && call.url === "/api/listing/cards/card-1"
    ? { ...CARD, payload: { ...CARD.payload, internalNotes: "保留旧字段" } }
    : call.url === "/api/listing/templates" ? { ...call.body, ready: true }
    : cardReply(call))
  try {
    await listingCardSaveCategoryDraft({
      draft_id: "card-1",
      display_name: "改名后的卡片",
      schema: { description_category_id: 17027906, type_id: 91976, language: "zh_hans" },
      draft: { values: { offer_id: { kind: "text", value: "SZ-1" } }, complex_values: [] },
      ai_prompt_id: "prompt-1",
      ai_prompt: "新的提示词",
      ai_prompt_file_name: "new.md",
      psd_template_asset_id: templateSha,
      psd_template_file_name: "poster-2.psd",
      target_store_id: "store-1,store-2",
      ai_allowed_field_keys: ["offer_id"],
    })
    await persistUserTemplate(templateSha, "poster-2.psd", 17027906, 91976)
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/cards/card-1",
      "PATCH /api/listing/cards/card-1",
      "POST /api/listing/templates",
    ])
    const write = stub.calls[1]!.body
    assert.equal(write.baseRevision, 7, "the read is what supplies the CAS pin")
    assert.equal(write.title, "改名后的卡片")
    assert.deepEqual(write.payload.defaults.values.offer_id, { kind: "text", value: "SZ-1" })
    // `cas_patch_card` replaces the payload wholesale, so a write that dropped
    // the queue would silently unfreeze a running cohort.
    assert.deepEqual(write.payload.queue, CARD.payload.queue)
    assert.equal(write.payload.aiPrompt, "新的提示词")
    assert.equal(write.payload.aiPromptId, "prompt-1", "the selected system identity is saved")
    assert.equal(write.payload.psdTemplateSha256, templateSha)
    assert.equal(write.payload.targetStoreId, "store-1,store-2")
    assert.equal(write.payload.internalNotes, "保留旧字段")
    assert.deepEqual(write.payload.aiFieldPolicy, {
      allowed_field_keys: ["offer_id"],
      protected_field_keys: ["price"],
    })
    assert.equal(write.payload.videos[0].file_name, "card-a.mp4")
  } finally {
    for (let turn = 0; turn < 4; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    }
    stub.restore()
    await restoreOpfsTestGlobals()
  }
})

test("a row write syncs an expired category once and retries the same revision and draft", async () => {
  const row = { ...ROW, store_id: "row-store", payload: { descriptionCategoryId: 42, typeId: 73, language: "zh_hans" } }
  let writes = 0
  const body = { baseRevision: row.revision, draft: row.draft }
  const stub = recordFetch((call) => {
    if (call.method === "PATCH") return ++writes === 1
      ? new Response(JSON.stringify({ code: "schema_sync_required", error: "类目缓存未同步" }), { status: 409 })
      : { ...row, revision: row.revision + 1 }
    return call.url.startsWith("/api/catalog/schema") ? SCHEMA_DATA : row
  })
  try {
    const saved = await patchListingRow(row.id, body)
    assert.equal(saved.revision, row.revision + 1)
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      `PATCH /api/listing/rows/${row.id}`,
      `GET /api/listing/rows/${row.id}`,
      "GET /api/catalog/schema?descriptionCategoryId=42&typeId=73&language=zh_hans",
      `PATCH /api/listing/rows/${row.id}`,
    ])
    assert.deepEqual(stub.calls[0]!.body, body)
    assert.deepEqual(stub.calls.at(-1)!.body, body, "schema sync must not change the edit or its CAS fence")
  } finally {
    stub.restore()
  }
})

test("a repeated schema miss stops after one refresh and does not become a CAS retry", async () => {
  const row = { ...ROW, payload: { descriptionCategoryId: 42, typeId: 73, language: "zh_hans" } }
  const stub = recordFetch((call) => call.method === "PATCH"
    ? Response.json({ code: "schema_sync_required", error: "目录不可用" }, { status: 409 })
    : call.url.startsWith("/api/catalog/schema") ? SCHEMA_DATA : row)
  const view = {
    ...cardDraftView(CARD, { description_category_id: 42, type_id: 73, fields: [], complex_groups: [] }),
    draft_id: row.id, draft: row.draft, target_store_id: row.store_id,
  }
  try {
    await assert.rejects(workflowActions.listingRowSaveDraft(view, view), /目录不可用/)
    assert.equal(stub.calls.filter((call) => call.method === "PATCH").length, 2)
    assert.equal(stub.calls.filter((call) => call.url.startsWith("/api/catalog/schema")).length, 1)
    assert.equal(stub.calls.filter((call) => call.method === "GET" && call.url.startsWith("/api/listing/rows/")).length, 1)
  } finally {
    stub.restore()
  }
})

test("attaching a Card video writes the Card payload, never a listing row", async () => {
  const stub = recordFetch(cardReply)
  try {
    const lifecycle = await workflowActions.listingCardAttachVideo({
      draft_id: "card-1",
      metadata: {
        role: "product",
        origin: "public_url",
        file_name: "card-b.mp4",
        content_type: "video/mp4",
        size_bytes: 13,
        duration_ms: 49_000,
        public_url: "https://media.example/card-b.mp4",
        content_hash: "sha256:card-b",
      },
    })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/cards/card-1",
      "PATCH /api/listing/cards/card-1",
    ])
    assert.deepEqual(
      stub.calls[1]!.body.payload.videos.map((video: { file_name: string }) => video.file_name),
      ["card-a.mp4", "card-b.mp4"],
    )
    assert.equal(lifecycle.product_videos.length, 2)
  } finally {
    stub.restore()
  }
})

test("binding a named Card video copies that exact video into the requested Product Instance", async () => {
  const stub = recordFetch((call) => {
    if (call.url === "/api/listing/cards/card-1") return CARD
    if (call.method === "PATCH") return { ...ROW, media: call.body.changes.media }
    return ROW
  })
  try {
    const [result] = await workflowActions.listingCardAttachVideoToProducts({
      card_draft_id: "card-1",
      target_draft_ids: ["row-1"],
      role: "product",
      video_identity: "sha256:card-a",
    })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/cards/card-1",
      "GET /api/listing/rows/row-1",
      "PATCH /api/listing/rows/row-1",
    ])
    assert.equal(stub.calls[2]!.body.changes.media.videos.at(-1).file_name, "card-a.mp4")
    assert.equal(result!.lifecycle!.product_videos.at(-1)!.file_name, "card-a.mp4")
  } finally {
    stub.restore()
  }
})

test("hashless pool videos coexist and one can be removed by its public URL", async () => {
  const poolA = {
    role: "product" as const,
    origin: "public_url" as const,
    file_name: "pool-a.mp4",
    content_type: "video/mp4",
    size_bytes: 0,
    duration_ms: 20_000,
    public_url: "https://media.example/pool-a.mp4",
  }
  const poolB = { ...poolA, file_name: "pool-b.mp4", public_url: "https://media.example/pool-b.mp4" }
  let card = { ...CARD, payload: { ...CARD.payload, videos: [...CARD.payload.videos, poolA] } }
  const stub = recordFetch((call) => {
    if (call.method === "PATCH") {
      card = { ...card, revision: card.revision + 1, payload: call.body.payload }
    }
    return card
  })
  try {
    await workflowActions.listingCardAttachVideo({ draft_id: "card-1", metadata: poolB })
    await workflowActions.listingCardRemoveVideo("card-1", "product", poolA.public_url)
    assert.deepEqual(
      stub.calls[1]!.body.payload.videos.map((video: { file_name: string }) => video.file_name),
      ["card-a.mp4", "pool-a.mp4", "pool-b.mp4"],
    )
    assert.deepEqual(
      stub.calls[2]!.body.payload.videos.map((video: { file_name: string }) => video.file_name),
      ["card-a.mp4", "pool-b.mp4"],
    )
  } finally {
    stub.restore()
  }
})

test("a card with no id is created, and the column takes the first bound Store", async () => {
  stubOpfs()
  const templateSha = await putTemplate(new Uint8Array([1, 2, 3]))
  const stub = recordFetch((call) => call.url === "/api/listing/templates" ? { ...call.body, ready: true } : cardReply(call))
  try {
    await listingCardSaveCategoryDraft({
      display_name: "新卡片",
      schema: { description_category_id: 17027906, type_id: 91976, language: "zh_hans" },
      draft: { values: {}, complex_values: [] },
      ai_prompt_id: "prompt-1",
      ai_prompt: "提示词",
      ai_prompt_file_name: "prompt.md",
      psd_template_asset_id: templateSha,
      psd_template_file_name: "poster.psd",
      target_store_id: "store-2,store-3",
      ai_allowed_field_keys: [],
    })
    await persistUserTemplate(templateSha, "poster.psd", 17027906, 91976)
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "POST /api/listing/cards",
      "POST /api/listing/templates",
    ])
    assert.equal(stub.calls[0]!.body.storeId, "store-2")
    assert.equal(stub.calls[0]!.body.createMode, "blank")
    assert.equal(stub.calls[0]!.body.payload.targetStoreId, "store-2,store-3")
  } finally {
    for (let turn = 0; turn < 4; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    }
    stub.restore()
    await restoreOpfsTestGlobals()
  }
})

const newCardDraft = {
  display_name: "新卡片",
  schema: { description_category_id: 17027906, type_id: 91976, language: "zh_hans" as const },
  draft: { values: {}, complex_values: [] },
  ai_prompt_id: "prompt-1",
  ai_prompt: "提示词",
  ai_prompt_file_name: "prompt.md",
  psd_template_asset_id: "template-sha",
  psd_template_file_name: "poster.psd",
  target_store_id: "store-2",
  ai_allowed_field_keys: [] as string[],
}

test("the card list projects default sale price onto the library tile", async () => {
  const stub = recordFetch(() => ({
    items: [{
      ...CARD,
      payload: {
        ...CARD.payload,
        defaults: {
          values: {
            price: { kind: "decimal", value: 1990 },
            old_price: { kind: "decimal", value: 2490 },
          },
          complex_values: [],
        },
      },
    }],
  }))
  try {
    const [summary] = await listingHttp.listingCardListSavedDrafts()
    assert.equal(summary!.price, "1990")
    assert.equal(summary!.old_price, "2490")
  } finally {
    stub.restore()
  }
})

test("saving sale price on a supplier card patches only defaults.price", async () => {
  const supplier = {
    ...CARD,
    payload: {
      ...CARD.payload,
      supplierProductId: "product-1",
      defaults: {
        values: {
          vat: { kind: "decimal", value: 0 },
          width: { kind: "integer", value: 1 },
        },
        complex_values: [],
      },
    },
  }
  const stub = recordFetch((call) => {
    if (call.method === "PATCH") {
      return {
        ...supplier,
        revision: supplier.revision + 1,
        payload: {
          ...supplier.payload,
          defaults: call.body.payload.defaults,
        },
      }
    }
    return supplier
  })
  try {
    const saved = await listingCardSaveDefaultPrice("card-1", 1990)
    assert.equal(stub.calls[0]!.url, "/api/listing/cards/card-1")
    assert.equal(stub.calls[1]!.method, "PATCH")
    assert.deepEqual(stub.calls[1]!.body.payload, {
      defaults: { values: { price: { kind: "decimal", value: 1990 } }, complex_values: [] },
    })
    assert.equal(saved.price, "1990")
  } finally {
    stub.restore()
  }
})

test("saving sale price on a blank card patches the full payload defaults", async () => {
  const stub = recordFetch(cardReply)
  try {
    await listingCardSaveDefaultPrice("card-1", 90)
    assert.equal(stub.calls[1]!.method, "PATCH")
    assert.equal(stub.calls[1]!.body.payload.defaults.values.price.value, 90)
    assert.equal(stub.calls[1]!.body.payload.aiPromptId, "prompt-1")
  } finally {
    stub.restore()
  }
})

test("saving old price writes defaults.old_price through the same overlay", async () => {
  const supplier = {
    ...CARD,
    payload: {
      ...CARD.payload,
      supplierProductId: "product-1",
      defaults: {
        values: {
          vat: { kind: "decimal", value: 0 },
          width: { kind: "integer", value: 1 },
        },
        complex_values: [],
      },
    },
  }
  const stub = recordFetch((call) => {
    if (call.method === "PATCH") {
      return {
        ...supplier,
        revision: supplier.revision + 1,
        payload: {
          ...supplier.payload,
          defaults: call.body.payload.defaults,
        },
      }
    }
    return supplier
  })
  try {
    const saved = await listingCardSaveDefaultPrice("card-1", 2490, "old_price")
    assert.equal(stub.calls[1]!.method, "PATCH")
    assert.deepEqual(stub.calls[1]!.body.payload, {
      defaults: { values: { old_price: { kind: "decimal", value: 2490 } }, complex_values: [] },
    })
    assert.equal(saved.old_price, "2490")
  } finally {
    stub.restore()
  }
})

test("a later edit PATCH does not resend createMode", async () => {
  const stub = recordFetch(cardReply)
  try {
    await listingCardSaveCategoryDraft({
      ...newCardDraft,
      draft_id: "card-1",
      createMode: "copyCard",
    })
    assert.equal(stub.calls[0]!.method, "GET")
    assert.equal(stub.calls[1]!.method, "PATCH")
    assert.equal(stub.calls[1]!.body.createMode, undefined)
  } finally {
    stub.restore()
  }
})

test("SKU preview remains a read-only card route", async () => {
  const preview = {
    source_sku: 123,
    source_product_id: 456,
    source_offer_id: "offer-1",
    source_name: "商品",
    source_description_category_id: 17027906,
    source_type_id: 91976,
    category_matches: true,
    candidates: [],
    skipped_fields: 0,
  }
  const stub = recordFetch(() => preview)
  try {
    assert.deepEqual(
      await listingHttp.listingCardPreviewSkuImport({ draft_id: "card-1", sku: "123" }),
      preview,
    )
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "POST /api/listing/cards/card-1/sku-import/preview",
    ])
    assert.deepEqual(stub.calls[0]!.body, { sku: "123" })
  } finally {
    stub.restore()
  }
})

test("copying a card copies the recipe and never the cohort", async () => {
  const stub = recordFetch(() => ({ ...CARD, id: "card-2", revision: 1 }))
  try {
    const copy = await listingHttp.listingCardCopySavedDraft("card-1")
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "POST /api/listing/cards/card-1/copy",
    ])
    assert.equal(copy.draft_id, "card-2")
    assert.equal(copy.ai_prompt, "识图提示词")
    // A copy is one call: the rows belong to the batch that produced them, so
    // there is nothing to read back and nothing to duplicate.
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test("deleting a card and deleting a row are their own routes", async () => {
  const stub = recordFetch(() => ({ id: "card-1", deletedRows: 4 }))
  try {
    await listingHttp.listingCardDeleteSavedDraft("card-1")
    await listingHttp.listingRowDelete("row-1")
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "DELETE /api/listing/cards/card-1",
      "DELETE /api/listing/rows/row-1",
    ])
  } finally {
    stub.restore()
  }
})

test("a card's rows are read in queue order, and the queue position rides the payload", async () => {
  const rows = [0, 1].map((index) => ({
    id: `row-${index}`,
    card_id: "card-1",
    store_id: "store-1",
    revision: 1,
    view_revision: 1,
    projection: listingProjection({ stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty" }),
    content_state: "draft",
    media_state: "pending",
    validation_state: "stale",
    submission_state: "none",
    draft: { values: {}, complex_values: [] },
    validation_issues: [],
    media: { images: [], videos: [] },
    ai: { candidates: [] },
    source: { assetId: "", sha256: `sha-${index}`, fileName: `image-${index}.jpg` },
    payload: { queuePosition: index },
    updated_at_ms: 0,
  }))
  const stub = recordFetch((call) =>
    call.url.startsWith("/api/listing/rows")
      ? { items: rows }
      : call.url.startsWith("/api/listing/intents")
        ? { items: [] }
      : call.url.startsWith("/api/catalog/schema")
        ? SCHEMA_DATA
        : CARD,
  )
  try {
    const instances = await workflowActions.listingCardListProductInstances("card-1")
    assert.ok(
      stub.calls.some((call) => call.url === "/api/listing/rows?cardId=card-1&limit=100"),
    )
    assert.deepEqual(instances.map((view) => view.draft_id), ["row-0", "row-1"])
    assert.equal(instances[0]!.kind, "instance")
    assert.equal(instances[0]!.parent_card_id, "card-1")
    // The prompt, the template and the policy are the card's; the row inherits
    // them rather than storing a second copy.
    assert.equal(instances[0]!.ai_prompt, "识图提示词")
    assert.equal(instances[1]!.lifecycle.queue_position, 1)
    // Every row of a cohort is pinned to the card's coordinate, so one catalog
    // read serves them all.
    assert.equal(instances[0]!.schema.fields.length, 1)
    assert.equal(stub.calls.filter((call) => call.url.startsWith("/api/catalog")).length, 1)
  } finally {
    stub.restore()
  }
})

test("a row status refresh returns the latest OCR-filled Draft and Intent SKU", async () => {
  const recognised = {
    ...ROW,
    projection: listingProjection({ stage: "accepted", run_id: "intent-1", sku: 555, product_id: 9001 }),
    draft: {
      values: { name: { kind: "text", value: "Распознанное название" } },
      complex_values: [],
    },
  }
  const stub = recordFetch((call) =>
    call.url.startsWith("/api/listing/rows/")
      ? recognised
      : call.url.startsWith("/api/listing/intents")
        ? {
            items: [{
              id: "intent-1",
              listingRowId: "row-1",
              state: "reconciled",
              reconciliationOutcome: { found: { productId: "9001", sku: 555 } },
            }],
          }
      : call.url.startsWith("/api/catalog/schema")
        ? SCHEMA_DATA
        : CARD,
  )
  try {
    const status = await workflowActions.workflowGetProductStatus("row-1")
    assert.deepEqual(status.draft?.values.name, {
      kind: "text",
      value: "Распознанное название",
    })
    assert.equal(status.lifecycle.ozon_sku, 555)
    assert.equal(status.lifecycle.ozon_product_id, 9001)
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/rows/row-1",
    ])
  } finally {
    stub.restore()
  }
})

test("the queue is the card's document, and a pause is a PATCH of it", async () => {
  const stub = recordFetch(cardReply)
  try {
    const state = await workflowPublishPause("card-1")
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/listing/cards/card-1",
      "PATCH /api/listing/cards/card-1",
      // `running` is derived, never stored: the cohort's `submission_state` is
      // the only thing that knows whether Cloud is still publishing.
      "GET /api/listing/rows?cardId=card-1&limit=100",
    ])
    assert.equal(stub.calls[1]!.body.baseRevision, 7)
    assert.deepEqual(stub.calls[1]!.body.payload.queue, {
      paused: true,
      stopAfterCurrent: false,
      nextPosition: 3,
      frozenRowIds: ["row-1"],
      haltReason: "operator_pause",
    })
    assert.equal(state.paused, true)
    assert.equal(state.running, false)
    assert.equal(state.halt_reason, "operator_pause")
    assert.equal(state.revision, 8, "the answer carries the revision the write produced")
    assert.deepEqual(state.frozen_row_ids, ["row-1"])
  } finally {
    stub.restore()
  }
})

test("stop is pause plus stop-after-current, under the same revision fence", async () => {
  const stub = recordFetch(cardReply)
  try {
    await workflowPublishStop("card-1")
    assert.deepEqual(stub.calls[1]!.body.payload.queue, {
      paused: true,
      stopAfterCurrent: true,
      nextPosition: 3,
      frozenRowIds: ["row-1"],
      haltReason: "operator_stop",
    })
  } finally {
    stub.restore()
  }
})

test("a queue with a frozen cohort reads the rows to say whether it is running", async () => {
  const stub = recordFetch((call) =>
    call.url.startsWith("/api/listing/rows")
      ? {
          items: [
            {
              id: "row-1",
              card_id: "card-1",
              revision: 1,
              content_state: "ready",
              media_state: "ready",
              validation_state: "passed",
              submission_state: "submitting",
              draft: { values: {}, complex_values: [] },
              validation_issues: [],
              media: { images: [], videos: [] },
              ai: { candidates: [] },
              source: {},
              payload: {},
              updated_at_ms: 0,
            },
          ],
        }
      : CARD,
  )
  try {
    const state = await listingHttp.workflowLoadQueueState("card-1")
    assert.equal(state!.running, true)
    assert.equal(state!.claim_token, "", "there is no lane claim in a browser")
  } finally {
    stub.restore()
  }
})

test("a queue that never froze a cohort is not running and costs no rows read", async () => {
  const stub = recordFetch(() => ({
    ...CARD,
    payload: { ...CARD.payload, queue: { paused: false, stopAfterCurrent: false, nextPosition: 0, frozenRowIds: [] } },
  }))
  try {
    const state = await listingHttp.workflowLoadQueueState("card-1")
    assert.equal(state!.running, false)
    assert.deepEqual(stub.calls.map((call) => call.url), ["/api/listing/cards/card-1"])
  } finally {
    stub.restore()
  }
})



test("画廊导入只发送规格身份，方案读回保留服务端绑定", async () => {
  const stub = recordFetch(() => ({ id: "supplier-card", title: "数字油画 · 40×50cm", payload: { supplierProductId: "product-40", defaults: { values: {}, complex_values: [] } }, updatedAtMs: 1 }))
  try {
    const imported = await listingHttp.listingCardCreateFromSupplier("product-40")
    assert.equal(imported.id, "supplier-card")
    assert.deepEqual(stub.calls[0].body, { createMode: "fromSupplier", supplierProductId: "product-40" })
    assert.equal(stub.calls[0].method, "POST")
    assert.equal(stub.calls[0].url, "/api/listing/cards")
    const raw = { id: "supplier-card", title: "数字油画", revision: 1, payload: { supplierProductId: "product-40" }, created_at_ms: 1, updated_at_ms: 1 }
    assert.equal(cardPayload(raw).supplierProductId, "product-40")
  } finally { stub.restore() }
})


test("supplier send, pause and stop persist only the operator queue binding", async () => {
  let card = { ...CARD, payload: { ...CARD.payload, supplierProductId: "supplier-1" } }
  const stub = recordFetch((call) => {
    if (call.url.startsWith("/api/listing/rows")) return { items: [] }
    if (call.method === "PATCH") {
      assert.deepEqual(Object.keys(call.body.payload), ["queue"])
      assert.equal(call.body.title, undefined)
      assert.equal(call.body.baseRevision, card.revision)
      card = { ...card, revision: card.revision + 1, payload: { ...card.payload, ...call.body.payload } }
    }
    return card
  })
  try {
    const started = await workflowSaveQueueState({
      parent_card_id: card.id,
      paused: false,
      stop_after_current: false,
      next_position: 0,
      frozen_row_ids: ["row-selected"],
    })
    assert.deepEqual(started.frozen_row_ids, ["row-selected"])
    assert.equal(started.next_position, 0)
    assert.equal(started.target_store_id, CARD.payload.targetStoreId)
    assert.equal((await workflowPublishPause(card.id)).paused, true)
    assert.equal((await workflowPublishStop(card.id)).stop_after_current, true)
    assert.equal(stub.calls.filter((call) => call.method === "PATCH").length, 3)
    assert.deepEqual(card.payload.defaults, CARD.payload.defaults)
    assert.equal(card.payload.aiPrompt, CARD.payload.aiPrompt)
  } finally {
    stub.restore()
  }
})
