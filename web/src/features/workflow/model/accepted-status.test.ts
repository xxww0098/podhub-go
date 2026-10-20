import assert from "node:assert/strict"
import test from "node:test"
import { acceptedPublishCopy } from "./accepted-status"

test("an accepted row without a follow-up keeps the previous sentences", () => {
  assert.equal(acceptedPublishCopy({}).label, "已受理")
  assert.match(acceptedPublishCopy({}).detail, /后续审核与可售以卖家后台为准/)
  assert.equal(acceptedPublishCopy({ ozon_sku: 42 }).label, "商品已创建")
  assert.match(acceptedPublishCopy({ ozon_sku: 42 }).detail, /可售状态仍需核对/)
})

test("import and moderation progress replace 已受理 without opening a resend", () => {
  const pending = acceptedPublishCopy({
    importFollowup: { phase: "pending", detail: "Ozon 正在导入该商品，完成后会更新到这一行。" },
  })
  assert.equal(pending.label, "导入处理中")
  assert.equal(pending.failed, false)

  const review = acceptedPublishCopy({
    importFollowup: { phase: "moderating", detail: "商品正在审核，通过后会更新到这一行。" },
  })
  assert.equal(review.label, "审核中")
  assert.equal(acceptedPublishCopy({
    ozon_sku: 42,
    importFollowup: { phase: "moderating", detail: "商品正在审核，通过后会更新到这一行。" },
  }).label, "商品已创建")

  const declined = acceptedPublishCopy({
    ozon_sku: 42,
    importFollowup: { phase: "moderation_failed", detail: "审核未通过，请到卖家后台查看原因。" },
  })
  assert.equal(declined.label, "审核未通过")
  assert.equal(declined.failed, true)
  assert.doesNotMatch(declined.detail, /重新发送|重发/)

  const created = acceptedPublishCopy({
    importFollowup: { phase: "created", detail: "商品已创建，可售状态仍需核对。" },
  })
  assert.equal(created.label, "商品已创建")
})
