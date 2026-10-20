import assert from "node:assert/strict"
import test from "node:test"

import type { OzonStoreView, ShippingPostingView } from "@/bindings/commands"

import {
  ALL_STATUS,
  DEFAULT_QUEUE,
  DEFAULT_WINDOW_DAYS,
  SHIPPING_POLL_INTERVAL_MS,
  commandFailure,
  deadlineLabel,
  describeFailure,
  emptyView,
  formatInstant,
  hasUnavailableShippingStores,
  isAuthFailure,
  isEmptyShippingAdvance,
  labelPrintLabel,
  packingLabel,
  preferredStoreUid,
  queueRequest,
  requestStatus,
  rowToneStatus,
  shippingActions,
  shippingStatusLabel,
} from "./shipping-model"

const posting = (
  overrides: Partial<ShippingPostingView> = {},
): ShippingPostingView => ({
  posting_number: "33920145-0032-1",
  in_process_at: "2026-08-16T08:11:04Z",
  shipment_date: "2026-08-17T10:00:00Z",
  status: "awaiting_packaging",
  substatus: "",
  products: [
    {
      sku: 5_296_027_915,
      offer_id: "ART-40X50-0001",
      name: "Картина на холсте 40×50 Абстрактный берег",
      quantity: 2,
    },
  ],
  quantity: 2,
  deadline_state: "deadline_overdue",
  packing_state: "unpacked",
  label_state: "label_not_ready",
  ...overrides,
})

test("all-status filter is not sent to Ozon as a status", () => {
  assert.equal(requestStatus(ALL_STATUS), "")
  assert.equal(requestStatus("awaiting_packaging"), "awaiting_packaging")
})

test("queue tabs map onto the existing status and window request", () => {
  assert.equal(DEFAULT_QUEUE, "awaiting_label")
  assert.deepEqual(queueRequest("awaiting_label"), {
    status: "awaiting_packaging",
    windowDays: DEFAULT_WINDOW_DAYS,
  })
  assert.deepEqual(queueRequest("awaiting_ship"), {
    status: "awaiting_deliver",
    windowDays: DEFAULT_WINDOW_DAYS,
  })
  assert.deepEqual(queueRequest("due_today"), { status: "", windowDays: 1 })
  assert.deepEqual(queueRequest("all"), {
    status: "",
    windowDays: DEFAULT_WINDOW_DAYS,
  })
})

test("packed label-ready rows expose 打单 and 发货", () => {
  assert.deepEqual(
    shippingActions(
      posting({
        packing_state: "packed",
        label_state: "label_ready",
      }),
    ).map((item) => item.label),
    ["打单", "发货"],
  )
  assert.deepEqual(
    shippingActions(posting()).map((item) => item.label),
    ["打单"],
  )
})

test("a status is translated for the operator and never for Ozon", () => {
  assert.equal(shippingStatusLabel("awaiting_packaging"), "待组包")
  assert.equal(shippingStatusLabel("arbitration"), "仲裁中")
  // Unmapped statuses print themselves rather than a guess.
  assert.equal(shippingStatusLabel("some_future_ozon_state"), "some_future_ozon_state")
  // The filter still sends the wire value, whatever the chip printed.
  assert.equal(requestStatus("arbitration"), "arbitration")
})

test("preferred store follows the active id when it is configured", () => {
  const stores = [
    { storeUid: "store_02", name: "副店", clientId: "2" },
    { storeUid: "store_01", name: "主店", clientId: "1" },
  ]
  assert.equal(preferredStoreUid(stores, "store_01"), "store_01")
  assert.equal(preferredStoreUid(stores, "missing"), "store_02")
  assert.equal(preferredStoreUid([], "store_01"), "")
})

test("deadline packing and label copy stay in the six-tone vocabulary", () => {
  assert.equal(deadlineLabel("deadline_overdue"), "逾期")
  assert.equal(deadlineLabel("deadline_approaching"), "临期")
  assert.equal(deadlineLabel("deadline_ok"), "未到")
  assert.equal(packingLabel("unpacked"), "未组包")
  assert.equal(packingLabel("packed"), "已组包")
  assert.equal(packingLabel("result_unknown"), "Result Unknown")
  assert.equal(labelPrintLabel("label_not_ready"), "未到打单")
  assert.equal(labelPrintLabel("label_ready"), "可打单")
  assert.equal(labelPrintLabel("label_unknown"), "Result Unknown")
})

test("an overdue or approaching deadline owns the row tone", () => {
  assert.equal(rowToneStatus(posting()), "deadline_overdue")
  assert.equal(
    rowToneStatus(posting({ deadline_state: "deadline_approaching" })),
    "deadline_approaching",
  )
  assert.equal(
    rowToneStatus(
      posting({ deadline_state: "deadline_ok", status: "awaiting_deliver" }),
    ),
    "awaiting_deliver",
  )
})

test("an empty speculative next page keeps the committed page", () => {
  assert.equal(isEmptyShippingAdvance(true, emptyView("store")), true)
  assert.equal(isEmptyShippingAdvance(false, emptyView("store")), false)
  assert.equal(
    isEmptyShippingAdvance(true, {
      ...emptyView("store"),
      postings: [posting()],
    }),
    false,
  )
})

test("disabled stores are unavailable, not unconfigured", () => {
  const store = {
    configured: true,
    cloud_store_uuid: "11111111-1111-4111-8111-111111111111",
    cloud_status: "manual_disabled",
  } as OzonStoreView
  assert.equal(hasUnavailableShippingStores([store]), true)
  assert.equal(
    hasUnavailableShippingStores([
      { ...store, cloud_status: "quota_suspended" },
    ]),
    true,
  )
  assert.equal(hasUnavailableShippingStores([{ ...store, cloud_status: "active" }]), false)
  assert.equal(hasUnavailableShippingStores([{ ...store, configured: false }]), false)
  // A lapsed key is a third unavailable reason: Cloud refuses shipping for it.
  assert.equal(
    hasUnavailableShippingStores([
      { ...store, cloud_status: "active", key_expires_at_ms: Date.now() - 1 },
    ]),
    true,
  )
  assert.equal(
    hasUnavailableShippingStores([
      { ...store, cloud_status: "active", key_expires_at_ms: Date.now() + 60_000 },
    ]),
    false,
  )
  assert.equal(
    hasUnavailableShippingStores([
      { ...store, cloud_status: "active", key_expires_at_ms: null },
    ]),
    false,
  )
})

test("visible Shipping refresh uses the shared one-minute cadence", () => {
  assert.equal(SHIPPING_POLL_INTERVAL_MS, 60_000)
})

test("an empty timestamp stays a dash; a junk string is not rewritten", () => {
  assert.equal(formatInstant(""), "—")
  assert.equal(formatInstant("not-a-date"), "not-a-date")
  assert.match(formatInstant("2026-08-17T10:00:00Z"), /2026/)
})

test("Ozon reason is kept verbatim and remediations are appended, not rewritten", () => {
  const failure = commandFailure(
    { code: "cloud_ozon_shipping_failed", message: "PERIOD_IS_TOO_LONG" },
    "读取失败",
  )
  assert.equal(failure.message, "PERIOD_IS_TOO_LONG")
  assert.equal(describeFailure(failure), "PERIOD_IS_TOO_LONG")
  assert.equal(
    describeFailure({
      code: "cloud_ozon_auth_failed",
      message: "Api-key is invalid",
      remediation: "到「店铺」重新检查 Client ID / API Key 后再同步。",
    }),
    "Api-key is invalid 到「店铺」重新检查 Client ID / API Key 后再同步。",
  )
  assert.ok(isAuthFailure({ code: "cloud_ozon_auth_failed", message: "no" }))
  assert.ok(isAuthFailure({ code: "cloud_forbidden", message: "no role" }))
  assert.ok(isAuthFailure({ code: "unauthenticated", message: "expired" }))
  assert.ok(!isAuthFailure({ code: "cloud_ozon_shipping_failed", message: "no" }))
})
