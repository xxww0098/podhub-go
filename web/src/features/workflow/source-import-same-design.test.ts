/**
 * 同源多规格导入：一次暂存、逐卡建档、稳定创建键与共同店铺。
 *
 * Cloud is stubbed at the HTTP boundary (the established import-test seam), so
 * what is asserted is this module's own contract: the bytes are staged once for
 * the whole batch, every size keeps its own Card context, one design shares one
 * Store, and a retry replays the same create keys instead of minting new ones.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { device } from "./prepare/execution-context"
import { stageFile } from "@/bindings/file-picker"
import { CARD, SCHEMA, cloudRow, installFetch, refusal } from "./product-instances-test-fixtures"
import type { SourceImportItemOutcome } from "./product-instances"
import { resetListingWorkbench } from "./workbench/listing-workbench-store"
import {
  importSameDesignSizes,
  sameDesignCreateKey,
  sameDesignGroups,
  sameDesignKey,
  sameDesignRequestFingerprint,
} from "./source-import-same-design"

const CARD_BY_ID = route("listingCardsById", { id: "placeholder" }).replace("placeholder", "")

/** OPFS is browser-only; the batch writes through this seam. */
function countPuts(): { puts: string[], restore: () => void } {
  const original = device.putSource
  const puts: string[] = []
  device.putSource = (async (_bytes: Uint8Array, fileName: string) => {
    puts.push(fileName)
    return `sha-${fileName}`
  }) as typeof device.putSource
  return { puts, restore: () => { device.putSource = original } }
}

/** One Cloud row create, in the envelope shape the create key answers with. */
function rowCreate(fileName: string, created: boolean, index = 0): Response {
  return new Response(
    JSON.stringify({
      data: cloudRow(`row-${fileName}`, index, {
        source: { assetId: "", sha256: `sha-${fileName}`, fileName },
      }),
      created,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

function cardReply(productId: unknown) {
  return {
    id: `card-${String(productId)}`,
    title: "卡",
    storeId: "store-1",
    revision: 1,
    payload: CARD.payload,
    updatedAtMs: 0,
  }
}

function threeSizes(paths: string[]) {
  return paths.map((path, index) => ({
    productId: `p-${index}`,
    sourceId: "db-1",
    variantGroup: "G9",
    title: `规格 ${index}`,
    size: `size-${index}`,
    path,
  }))
}

test("one design's sizes stage once, file one Card each, and share one Store", async () => {
  resetListingWorkbench()
  const puts = countPuts()
  const stub = installFetch((call) => {
    if (call.url === route("listingCards") && call.method === "POST") {
      return cardReply(call.body.supplierProductId)
    }
    if (call.url.startsWith(CARD_BY_ID)) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    if (call.url === route("listingRows") && call.method === "POST") {
      return rowCreate(call.body.source.fileName, true)
    }
    return new Response(JSON.stringify({ error: "unexpected", code: "test" }), { status: 500 })
  })
  try {
    const paths = ["a/one.psd", "a/two.psd", "a/three.psd"].map((path) =>
      stageFile(new File([new Uint8Array([1])], path.split("/").pop()!, { type: "image/vnd.adobe.photoshop" })),
    )
    const result = await importSameDesignSizes({
      sizes: threeSizes(paths),
      storeId: "store-1",
      importedLog: "已导入",
    })

    assert.deepEqual(result.failures, [])
    assert.equal(result.rows.length, 3)
    // Bytes are staged exactly once for the whole batch: the per-card path
    // reuses the staged identity instead of hashing and writing them again.
    assert.deepEqual(puts.puts, ["one.psd", "two.psd", "three.psd"])

    const creates = stub.calls.filter((call) => call.url === route("listingRows"))
    assert.equal(creates.length, 3)
    assert.deepEqual(
      creates.map((call) => call.body.cardId),
      ["card-p-0", "card-p-1", "card-p-2"],
      "every size gets its own Card",
    )
    for (const call of creates) {
      assert.equal(call.body.storeId, "store-1", "one common Store for the whole design")
      assert.deepEqual(call.body.association, { supplierSourceId: "db-1", variantGroup: "G9" })
      assert.equal(call.body.createKey, sameDesignCreateKey(call.body.cardId, call.body.source.sha256))
      assert.match(call.body.requestFingerprint, /^[A-Za-z0-9._:-]{1,128}$/)
    }
    assert.equal(
      new Set(creates.map((call) => call.body.createKey)).size,
      3,
      "one key per (Card + source image)",
    )
  } finally {
    stub.restore()
    puts.restore()
    resetListingWorkbench()
  }
})

test("later failures keep their source filenames and callbacks keep batch indices", async () => {
  resetListingWorkbench()
  const puts = countPuts()
  const outcomes: SourceImportItemOutcome[] = []
  const stub = installFetch((call) => {
    if (call.url === route("listingCards") && call.method === "POST") {
      return cardReply(call.body.supplierProductId)
    }
    if (call.url.startsWith(CARD_BY_ID)) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    if (call.url === route("listingRows") && call.method === "POST") {
      const fileName = call.body.source.fileName
      if (fileName === "two.psd" || fileName === "three.psd") {
        return refusal(400, "test_import_refused", "图片导入被拒绝")
      }
      return rowCreate(fileName, true)
    }
    return refusal(500, "test", "unexpected")
  })
  try {
    const paths = ["one.psd", "two.psd", "three.psd", "four.psd"].map((fileName) =>
      stageFile(new File([new Uint8Array([1])], fileName, { type: "image/vnd.adobe.photoshop" })),
    )
    const result = await importSameDesignSizes({
      sizes: threeSizes(paths),
      storeId: "store-1",
      importedLog: "已导入",
      onItem: (outcome) => outcomes.push(outcome),
    })

    assert.deepEqual(result.failures, [
      "two.psd：图片导入被拒绝",
      "three.psd：图片导入被拒绝",
    ])
    assert.deepEqual(result.rows.map((row) => row.imageName), ["one.psd", "four.psd"])
    assert.deepEqual(outcomes.map((outcome) => outcome.inputIndex), [0, 1, 2, 3])
    assert.deepEqual(outcomes.map((outcome) => outcome.failure ?? outcome.row?.imageName), [
      "one.psd",
      ...result.failures,
      "four.psd",
    ])
  } finally {
    stub.restore()
    puts.restore()
    resetListingWorkbench()
  }
})

test("a replay of the same batch keeps the same keys and adds no second row", async () => {
  resetListingWorkbench()
  const puts = countPuts()
  let created = true
  const stub = installFetch((call) => {
    if (call.url === route("listingCards") && call.method === "POST") {
      return cardReply(call.body.supplierProductId)
    }
    if (call.url.startsWith(CARD_BY_ID)) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    if (call.url === route("listingRows") && call.method === "POST") {
      return rowCreate(call.body.source.fileName, created)
    }
    return new Response(JSON.stringify({ error: "unexpected", code: "test" }), { status: 500 })
  })
  try {
    const paths = ["a/one.psd"].map((path) =>
      stageFile(new File([new Uint8Array([1])], path.split("/").pop()!, { type: "image/vnd.adobe.photoshop" })),
    )
    const sizes = threeSizes(paths)
    const first = await importSameDesignSizes({ sizes, storeId: "store-1", importedLog: "已导入" })
    created = false
    const replay = await importSameDesignSizes({ sizes, storeId: "store-1", importedLog: "已导入" })

    assert.equal(first.rows.length, 1)
    assert.equal(replay.rows.length, 1, "a replay is success, not a failure")
    assert.deepEqual(replay.failures, [])
    assert.equal(replay.rows[0]!.id, first.rows[0]!.id, "the key names the same row")
    const creates = stub.calls.filter((call) => call.url === route("listingRows"))
    assert.equal(creates.length, 2)
    assert.equal(creates[0]!.body.createKey, creates[1]!.body.createKey)
    assert.equal(creates[0]!.body.requestFingerprint, creates[1]!.body.requestFingerprint)
  } finally {
    stub.restore()
    puts.restore()
    resetListingWorkbench()
  }
})

test("an empty variant group never associates and never reaches Cloud", async () => {
  resetListingWorkbench()
  const puts = countPuts()
  const stub = installFetch((call) => {
    if (call.url === route("listingCards") && call.method === "POST") return cardReply(call.body.supplierProductId)
    if (call.url.startsWith(CARD_BY_ID)) return CARD
    if (call.url.startsWith(route("catalogSchema"))) return SCHEMA
    if (call.url === route("listingRows")) return rowCreate(call.body.source.fileName, true)
    return new Response(JSON.stringify({ error: "unexpected", code: "test" }), { status: 500 })
  })
  try {
    const path = stageFile(new File([new Uint8Array([1])], "solo.psd", { type: "image/vnd.adobe.photoshop" }))
    const result = await importSameDesignSizes({
      sizes: [{ productId: "p-0", sourceId: "db-1", variantGroup: "   ", title: "无款号", path }],
      storeId: "store-1",
      importedLog: "已导入",
    })
    assert.equal(result.rows.length, 0)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0]!, /款号/)
    assert.equal(stub.calls.length, 0, "no Card and no row is created")
  } finally {
    stub.restore()
    puts.restore()
    resetListingWorkbench()
  }
})

test("the same source file under two designs keeps one key per Card", () => {
  assert.equal(
    sameDesignKey({ sourceId: "db-1", variantGroup: "G9" }),
    sameDesignKey({ sourceId: " db-1 ", variantGroup: " G9 " }),
  )
  assert.notEqual(
    sameDesignKey({ sourceId: "db-2", variantGroup: "G9" }),
    sameDesignKey({ sourceId: "db-1", variantGroup: "G9" }),
  )
  assert.notEqual(
    sameDesignKey({ sourceId: "db-1", variantGroup: "" }),
    sameDesignKey({ sourceId: "db-1", variantGroup: "G9" }),
  )
  const key = sameDesignCreateKey("Card-1", `sha256:${"a".repeat(64)}`)
  assert.equal(key, sameDesignCreateKey("card-1", "a".repeat(64)))
  assert.match(key, /^[A-Za-z0-9._:-]{1,128}$/)
  assert.match(sameDesignRequestFingerprint("p-1"), /^[A-Za-z0-9._:-]{1,128}$/)
})

test("a same-design group is at least two sizes of one non-empty 款号", () => {
  const entry = (productId: string, sourceId: string, variantGroup: string, size: string) => ({
    productId,
    sourceId,
    variantGroup,
    title: productId,
    size,
    path: `a/${productId}.psd`,
  })
  const groups = sameDesignGroups([
    entry("p-1", "db-1", "G9", "40x50cm"),
    entry("p-2", "db-1", "G9", "50x70cm"),
    entry("p-3", "db-2", "G9", "40x50cm"),
    entry("p-4", "db-1", "", "40x50cm"),
    entry("p-5", "db-1", "G7", "40x50cm"),
  ])
  assert.equal(groups.length, 1, "only the one design with two sizes")
  assert.deepEqual(groups[0]!.sizes.map((size) => size.productId), ["p-1", "p-2"])
  assert.equal(groups[0]!.variantGroup, "G9")
  // An empty 款号 never forms a group, exactly as it never associates.
  assert.deepEqual(sameDesignGroups([entry("p-6", "db-1", "  ", "40x50cm")]), [])
})
