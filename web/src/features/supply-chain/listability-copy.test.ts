import assert from "node:assert/strict"
import test from "node:test"

import type { CloudRefusal } from "@/api/client"

import {
  LISTABILITY_BADGE,
  LISTABILITY_EXPLAIN,
  SUPPLIER_NOT_LISTABLE_CODE,
  listabilityClass,
  listabilityFromRefusal,
  listabilitySkippedNotice,
  type ListabilityClass,
  type SupplierOzonConfigDenial,
} from "./listability-copy"

/** fetch client 落下来的拒绝形态：code 已带 cloud_ 前缀，denial 原样透传。 */
function refusal(denial?: string, extra: Record<string, unknown> = {}) {
  return {
    code: SUPPLIER_NOT_LISTABLE_CODE,
    message: "",
    ...(denial !== undefined ? { denial } : {}),
    ...extra,
  } as CloudRefusal
}

test("八个 denial 全归两类：停售三码，其余平台待处理", () => {
  const delisted: SupplierOzonConfigDenial[] = [
    "source_not_listed",
    "product_archived",
    "sku_not_published",
  ]
  const pending: SupplierOzonConfigDenial[] = [
    "catalog_missing",
    "catalog_expired",
    "config_needs_reconfiguration",
    "catalog_digest_mismatch",
    "prompt_invalid",
  ]
  for (const denial of delisted) {
    assert.equal(listabilityClass(denial), "delisted", denial)
  }
  for (const denial of pending) {
    assert.equal(listabilityClass(denial), "platform_pending", denial)
  }
})

test("listabilityFromRefusal 只认 cloud_supplier_not_listable", () => {
  assert.equal(
    listabilityFromRefusal(refusal("catalog_expired")),
    "platform_pending",
  )
  assert.equal(listabilityFromRefusal(refusal("product_archived")), "delisted")
  assert.equal(listabilityFromRefusal(refusal("sku_not_published")), "delisted")
  assert.equal(listabilityFromRefusal(refusal("config_needs_reconfiguration")), "platform_pending")
  assert.equal(listabilityFromRefusal(refusal("prompt_invalid")), "platform_pending")

  // 别的 code——哪怕顺手带了 denial——也不是这个门的文案。
  assert.equal(
    listabilityFromRefusal({
      code: "cloud_queue_busy",
      message: "",
      denial: "catalog_expired",
    }),
    null,
  )
  assert.equal(listabilityFromRefusal({ message: "没有 code" }), null)
  assert.equal(listabilityFromRefusal("cloud_supplier_not_listable"), null)
  assert.equal(listabilityFromRefusal(undefined), null)

  // denial 缺席或是不认识的未来码：归「平台待处理」，不臆造停售事实。
  assert.equal(listabilityFromRefusal(refusal()), "platform_pending")
  assert.equal(listabilityFromRefusal(refusal("future_denial")), "platform_pending")
})

test("两类卖家文案固定，批量跳过报数一行交代", () => {
  const explains: Record<ListabilityClass, string> = {
    platform_pending: "平台正在复核该商品的 Ozon 配置，暂不可上架",
    delisted: "该商品已停售，不可上架",
  }
  const badges: Record<ListabilityClass, string> = {
    platform_pending: "暂不可上架",
    delisted: "已停售",
  }
  assert.deepEqual({ ...LISTABILITY_EXPLAIN }, explains)
  assert.deepEqual({ ...LISTABILITY_BADGE }, badges)
  assert.equal(listabilitySkippedNotice(1), "已跳过 1 件暂不可上架的商品")
  assert.equal(listabilitySkippedNotice(3), "已跳过 3 件暂不可上架的商品")
})
