import assert from "node:assert/strict"
import test from "node:test"

import type {
  CategorySchemaRequest,
  CategorySchemaView,
} from "@/bindings/commands"

import {
  categorySchemaFlight,
  warmCategorySchemaOnce,
} from "./schema-sync"

function view(request: CategorySchemaRequest): CategorySchemaView {
  return {
    description_category_id: request.description_category_id,
    type_id: request.type_id,
    language: request.language,
    fields: [],
    complex_groups: [],
  }
}

/** 逐 key 记录在途数的 loader —— 用来数清「同一坐标只点一次火」。 */
function countingLoad(latency = Promise.resolve()) {
  const calls: CategorySchemaRequest[] = []
  const load = async (request: CategorySchemaRequest) => {
    calls.push(request)
    await latency
    return view(request)
  }
  return { calls, load }
}

const COORD = { descriptionCategoryId: 11, typeId: 101 }

test("categorySchemaFlight: 同键并发共享一次在途拉取，落定后重试可再发", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { calls, load } = countingLoad(gate)
  const request = {
    description_category_id: 42,
    type_id: 73,
    language: "zh_hans" as const,
    target_store_id: "store-a",
  }
  const first = categorySchemaFlight(request, load)
  const second = categorySchemaFlight({ ...request, target_store_id: "store-b" }, load)
  const third = categorySchemaFlight({ ...request, target_store_id: undefined }, load)
  assert.equal(calls.length, 1, "不同店铺或无店铺共享同一平台请求")
  release()
  assert.equal((await first).type_id, 73)
  assert.equal(await second, await first, "同一在途 promise")
  assert.equal(await third, await first)

  await categorySchemaFlight(request, load)
  assert.equal(calls.length, 2, "落定后同键再拉是新请求")
})

test("warmCategorySchemaOnce: 选中落盘后不依赖店铺拉一次平台 schema", async () => {
  const { calls, load } = countingLoad()
  await warmCategorySchemaOnce(COORD, {
    loadSchema: load,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    description_category_id: 11,
    type_id: 101,
    language: "zh_hans",
  })
})

test("warmCategorySchemaOnce: 坐标不完整不点火", async () => {
  const { calls, load } = countingLoad()
  await warmCategorySchemaOnce(
    { descriptionCategoryId: null, typeId: 101 },
    { loadSchema: load },
  )
  await warmCategorySchemaOnce(
    { descriptionCategoryId: 11 },
    { loadSchema: load },
  )
  assert.equal(calls.length, 0, "清除/半成品坐标不该拉 schema")
})

test("warmCategorySchemaOnce: 暖取与读面并发时同一坐标只飞一次", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { calls, load } = countingLoad(gate)
  const warm = warmCategorySchemaOnce(
    { descriptionCategoryId: 7, typeId: 70 },
    { loadSchema: load },
  )
  // 读面（默认字段分区）在暖取在途时发起同一坐标拉取 → 共享。
  const section = categorySchemaFlight(
    {
      description_category_id: 7,
      type_id: 70,
      language: "zh_hans",
      target_store_id: "store-9",
    },
    load,
  )
  release()
  await Promise.all([warm, section])
  assert.equal(calls.length, 1)
})
