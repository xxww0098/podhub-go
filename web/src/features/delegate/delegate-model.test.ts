import assert from "node:assert/strict"
import test from "node:test"

import {
  assetContentType,
  assetExtensionOf,
  assetFileError,
  delegateBadgeFor,
  delegateRowAction,
  formatInstantValue,
  isDelegateConflict,
  newIdempotencyKey,
  normalizedOfferId,
  orderCanCancel,
  orderCanClose,
  orderStateLabel,
  orderStateTone,
  packetStateLabel,
  packetStateTone,
  sha256Hex,
} from "./delegate-model"

test("posting 四态映射到行内动作：ready 确认建单、partial 委托剩余行、needs_setup 补齐流", () => {
  assert.deepEqual(delegateRowAction("delegated"), {
    kind: "view-order",
    label: "查看委托单",
  })
  assert.deepEqual(delegateRowAction("partial"), {
    kind: "delegate-rest",
    label: "委托剩余行",
  })
  assert.deepEqual(delegateRowAction("ready"), { kind: "delegate", label: "委托" })
  assert.deepEqual(delegateRowAction("needs_setup"), {
    kind: "setup",
    label: "补齐并委托",
  })
})

test("单级与包状态只翻译印出的字，wire 值保持 wire 值", () => {
  assert.equal(orderStateLabel("awaiting_setup"), "待完善")
  assert.equal(orderStateLabel("ready"), "待派发")
  assert.equal(orderStateLabel("dispatched"), "已派发")
  assert.equal(orderStateLabel("in_production"), "生产中")
  assert.equal(orderStateLabel("shipped"), "已发货")
  assert.equal(orderStateLabel("done"), "已完成")
  assert.equal(orderStateLabel("cancelled"), "已取消")
  assert.equal(orderStateLabel("some_future_state"), "some_future_state")
  assert.equal(packetStateLabel("dispatched"), "待接单")
  assert.equal(packetStateLabel("accepted"), "已接单")
  assert.equal(packetStateLabel("rejected"), "已拒单")

  // 六色词汇，不发明第七种 tone。
  assert.equal(orderStateTone("awaiting_setup"), "attest")
  assert.equal(orderStateTone("ready"), "flight")
  assert.equal(orderStateTone("shipped"), "good")
  assert.equal(orderStateTone("cancelled"), "bad")
  assert.equal(packetStateTone("dispatched"), "idle")
  assert.equal(packetStateTone("accepted"), "flight")
  assert.equal(packetStateTone("rejected"), "bad")
  assert.equal(packetStateTone("mystery"), "unknown")
})

test("撤单/收口按状态×动作矩阵给按钮，服务端仍是最终门", () => {
  assert.equal(orderCanCancel("awaiting_setup", false), true)
  assert.equal(orderCanCancel("ready", false), true)
  assert.equal(orderCanCancel("dispatched", false), true)
  assert.equal(orderCanCancel("in_production", false), true)
  // 已接单撤 = 置 cancel_requested；旗标已立就不再给按钮。
  assert.equal(orderCanCancel("in_production", true), false)
  assert.equal(orderCanCancel("shipped", false), false)
  assert.equal(orderCanCancel("done", false), false)
  assert.equal(orderCanCancel("cancelled", false), false)

  assert.equal(orderCanClose("dispatched"), true)
  assert.equal(orderCanClose("in_production"), true)
  assert.equal(orderCanClose("shipped"), true)
  assert.equal(orderCanClose("ready"), false)
  assert.equal(orderCanClose("awaiting_setup"), false)
  assert.equal(orderCanClose("cancelled"), false)
})

test("coveredOfferIds → N/M 徽标：空覆盖无徽标、全覆盖「已委托」、部分「N/M 行」", () => {
  const offers = ["ART-1", "ART-2"]
  assert.equal(delegateBadgeFor(offers, []), null)
  assert.equal(delegateBadgeFor([], ["ART-1"]), null)
  assert.deepEqual(delegateBadgeFor(offers, ["ART-1", "ART-2"]), {
    kind: "delegated",
    label: "已委托",
  })
  assert.deepEqual(delegateBadgeFor(offers, ["ART-1"]), {
    kind: "partial",
    label: "已委托 1/2 行",
  })
  // 覆盖集里的未知 offer 不算数；posting 与覆盖集都按归一后去重计数。
  // 归一只 trim 不改大小写（服务端 `NULLIF(btrim())` 同口径）。
  assert.deepEqual(delegateBadgeFor(offers, ["ART-1", "GHOST-9"]), {
    kind: "partial",
    label: "已委托 1/2 行",
  })
  // 归一只 trim 不改大小写（服务端 `NULLIF(btrim())` 同口径）：大小写不合
  // 就是不覆盖，宁可不显示徽标也不猜。
  assert.deepEqual(
    delegateBadgeFor([" ART-1 ", "ART-1", "ART-2"], ["ART-1 ", " ART-2"]),
    { kind: "delegated", label: "已委托" },
  )
  assert.equal(delegateBadgeFor(offers, ["art-1"]), null)
  assert.equal(normalizedOfferId("  ART-1  "), "ART-1")
})

test("原图白名单与 500MB 上限在 presign 之前本地预检", () => {
  assert.equal(assetExtensionOf("原图.PSD"), "psd")
  assert.equal(assetExtensionOf("photo.jpeg"), "jpg")
  assert.equal(assetExtensionOf("photo.JPG"), "jpg")
  assert.equal(assetExtensionOf("logo.png"), "png")
  assert.equal(assetExtensionOf("art.webp"), "webp")
  assert.equal(assetExtensionOf("virus.exe"), null)
  assert.equal(assetExtensionOf("no-extension"), null)

  assert.equal(assetFileError({ name: "a.png", size: 1 }), null)
  assert.match(assetFileError({ name: "a.gif", size: 1 }) ?? "", /jpg\/png\/webp\/psd/)
  assert.match(assetFileError({ name: "a.png", size: 0 }) ?? "", /空文件/)
  assert.match(
    assetFileError({ name: "a.psd", size: 500 * 1024 * 1024 + 1 }) ?? "",
    /500MB/,
  )
  assert.equal(assetFileError({ name: "a.psd", size: 500 * 1024 * 1024 }), null)
})

test("Content-Type 声明：浏览器识别优先，扩展名兜底，PSD 走 octet-stream", () => {
  assert.equal(assetContentType({ name: "a.png", type: "image/png" }), "image/png")
  assert.equal(assetContentType({ name: "a.jpg", type: "" }), "image/jpeg")
  assert.equal(assetContentType({ name: "a.webp", type: "" }), "image/webp")
  assert.equal(assetContentType({ name: "a.psd", type: "" }), "application/octet-stream")
})

test("sha256 是小写 hex，服务端按它派生对象键并回读核验", async () => {
  const bytes = new TextEncoder().encode("abc")
  const digest = await sha256Hex(bytes.buffer as ArrayBuffer)
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

test("绑定 CAS 409 以 cloud_conflict 识别；幂等键每次意图一个新值", () => {
  assert.ok(isDelegateConflict(Object.assign(new Error("冲突"), { code: "cloud_conflict" })))
  assert.ok(!isDelegateConflict(Object.assign(new Error("四〇四"), { code: "cloud_not_found" })))
  assert.ok(!isDelegateConflict(new Error("plain")))

  const first = newIdempotencyKey()
  const second = newIdempotencyKey()
  assert.notEqual(first, second)
  assert.match(first, /^delegate-[0-9a-f-]{36}$/)
})

test("委托单时间走共享格式化；空值与不可解析值不被改写", () => {
  assert.equal(formatInstantValue(""), "—")
  assert.equal(formatInstantValue(0), "—")
  assert.equal(formatInstantValue("not-a-date"), "not-a-date")
  assert.match(formatInstantValue("2026-08-17T10:00:00Z"), /08\/17/)
  assert.match(formatInstantValue(1_755_000_000_000), /\d{2}\/\d{2}/)
})
