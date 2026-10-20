import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowDraftView, WorkflowProductLifecycle } from "@/bindings/commands"
import type { ListingRow } from "./model/listing-row"
import {
  listedStockSingleStoreTargets,
  listedStockStoreId,
  listedStockTargets,
} from "./listed-stock-dialog"

const idleLifecycle: WorkflowProductLifecycle = {
  revision: 1,
  view_revision: 1,
    image_total: 0, image_completed: 0,
  stage: "awaiting_content",
  ai: "pending",
  media: "pending",
  fields: "dirty",
  images: [],
  failure_log: [],
  ai_candidates: [],
  product_videos: [],
}

function row(index: number, status: ListingRow["status"] = "sent"): ListingRow {
  return {
    id: `row-${index}`,
    draftId: `workflow_instance_${index}`,
    imageName: `SZ-000${index}.png`,
    status,
    ai: "done",
    render: "done",
    upload: "done",
    log: "发送完成",
  }
}

function listed(
  target: ListingRow,
  overrides: Partial<WorkflowProductLifecycle> = {},
  storeId = "store-1",
): WorkflowDraftView {
  return {
    draft_id: target.draftId,
    kind: "instance",
    parent_card_id: "workflow_template_1",
    display_name: target.imageName,
    schema: { description_category_id: 1, type_id: 1, language: "zh_hans", fields: [], complex_groups: [] },
    draft: {
      values: { offer_id: { kind: "text", value: `OFFER-${target.id}` } },
      complex_values: [],
    },
    validation_state: "draft",
    issues: [],
    ai_prompt_id: "prompt-1",
    ai_prompt: "",
    ai_prompt_file_name: "",
    psd_template_asset_id: "",
    psd_template_file_name: "",
    target_store_id: storeId,
    ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
    lifecycle: {
      ...idleLifecycle,
      stage: "accepted",
      ozon_sku: 123456789,
      ozon_product_id: 11,
      ...overrides,
    },
    updated_at_ms: 0,
  }
}

test("改库存 targets listed rows with a storefront identity", () => {
  const sent = row(1)
  const pending = row(2, "pending")
  const noSku = row(3)
  const drafts = {
    [sent.draftId]: listed(sent),
    [pending.draftId]: listed(pending, { ozon_sku: undefined, ozon_product_id: undefined }),
    [noSku.draftId]: listed(noSku, { ozon_sku: 0, ozon_product_id: 0 }),
  }

  const all = listedStockTargets([sent, pending, noSku], drafts, new Set(), "store-1")
  assert.deepEqual(all.map((target) => target.rowId), [sent.id])
  assert.equal(all[0]?.productId, 11)
  assert.equal(all[0]?.sku, 123456789)
  assert.equal(all[0]?.offerId, "OFFER-row-1")

  const selected = listedStockTargets(
    [sent, pending, noSku],
    drafts,
    new Set([pending.id]),
    "store-1",
  )
  assert.deepEqual(selected, [])
})

test("改库存 uses the same source-stem offer identity as send", () => {
  const sent = row(1)
  const product = listed(sent)
  delete product.draft.values.offer_id

  const targets = listedStockTargets(
    [sent],
    { [sent.draftId]: product },
    new Set(),
    "store-1",
  )
  assert.equal(targets[0]?.offerId, "SZ-0001")
})

test("改库存 refuses a mixed-store selection", () => {
  const left = row(1)
  const right = row(2)
  const drafts = {
    [left.draftId]: listed(left, {}, "store-a"),
    [right.draftId]: listed(right, {}, "store-b"),
  }
  const targets = listedStockTargets([left, right], drafts, new Set(), "store-a,store-b")
  assert.equal(targets.length, 2)
  assert.equal(listedStockStoreId(targets), undefined)
  assert.equal(listedStockStoreId(targets.slice(0, 1)), "store-a")
})

test("改库存 opens the largest same-store group from a mixed selection", () => {
  const a1 = row(1)
  const a2 = row(2)
  const a3 = row(3)
  const b1 = row(4)
  const drafts = {
    [a1.draftId]: listed(a1, {}, "store-a"),
    [a2.draftId]: listed(a2, {}, "store-a"),
    [a3.draftId]: listed(a3, {}, "store-a"),
    [b1.draftId]: listed(b1, {}, "store-b"),
  }
  const mixed = listedStockTargets([a1, a2, a3, b1], drafts, new Set(), "store-a,store-b")
  assert.equal(listedStockStoreId(mixed), undefined)
  const single = listedStockSingleStoreTargets(mixed)
  assert.equal(listedStockStoreId(single), "store-a")
  assert.deepEqual(single.map((target) => target.rowId), [a1.id, a2.id, a3.id])
})


test("accepted receipt without SKU resolves inventory identity from its store snapshot", () => {
  const target = row(1)
  const product = listed(target, { stage: "accepted", ozon_sku: undefined, ozon_product_id: undefined })
  const before = structuredClone(product)
  const readSnapshot = () => ({
    products: [
      { offerId: "OTHER", productId: 20, sku: 999 },
      { offerId: "OFFER-row-1", productId: 21, sku: 5852410522 },
    ],
  } as ReturnType<typeof import("@/features/products/product-snapshot-store").readProductSnapshot>)
  const stores: string[] = []
  const targets = listedStockTargets([target], { [target.draftId]: product }, new Set([target.id]), "store-2", (storeId) => {
    stores.push(storeId)
    return readSnapshot()
  })
  assert.deepEqual(stores, ["store-1"])
  assert.deepEqual(targets, [{ rowId: target.id, storeId: "store-1", offerId: "OFFER-row-1", productId: 21, sku: 5852410522 }])
  assert.deepEqual(product, before, "inventory resolution must not mutate accepted receipt")
})


test("stock snapshot must match both exact offer and any known product identity", () => {
  const target = row(1)
  const product = listed(target, { stage: "accepted", ozon_sku: undefined, ozon_product_id: 11 })
  for (const products of [
    [{ offerId: "OFFER-row-10", productId: 11, sku: 123 }],
    [{ offerId: "OFFER-row-1", productId: 12, sku: 123 }],
    [{ offerId: "OFFER-row-1", productId: 11, sku: 123 }, { offerId: "OFFER-row-1", productId: 11, sku: 456 }],
  ]) {
    const readSnapshot = () => ({ products } as ReturnType<typeof import("@/features/products/product-snapshot-store").readProductSnapshot>)
    assert.deepEqual(listedStockTargets([target], { [target.draftId]: product }, new Set(), "store-1", readSnapshot), [])
  }
  assert.deepEqual(listedStockTargets([target], { [target.draftId]: product }, new Set(), "store-1", () => null), [])
})

test("unsubmitted rows cannot inherit an existing product's inventory identity", () => {
  const target = row(1, "pending")
  const products = [
    undefined,
    ...(["awaiting_content", "ready_to_publish", "queued", "submitting", "publish_rejected", "outcome_unknown"] as const)
      .map((stage) => listed(target, { stage, ozon_sku: undefined, ozon_product_id: undefined })),
  ]
  for (const product of products) {
    const drafts = product ? { [target.draftId]: product } : {}
    let reads = 0
    const readSnapshot = () => {
      reads++
      return {
        products: [
          { offerId: "OFFER-row-1", productId: 21, sku: 5852410522 },
          { offerId: "SZ-0001", productId: 22, sku: 5852410523 },
        ],
      } as ReturnType<typeof import("@/features/products/product-snapshot-store").readProductSnapshot>
    }
    assert.deepEqual(listedStockTargets([target], drafts, new Set(), "store-1", readSnapshot), [])
    assert.equal(reads, 0, "unsubmitted rows must not resolve inventory from an offer collision")
  }
})
