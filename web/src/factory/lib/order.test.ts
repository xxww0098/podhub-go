import assert from "node:assert/strict"
import test from "node:test"

import {
  countdownLabel,
  deadlineInstant,
  dispatchSummary,
  isUrgent,
  nudgeCooling,
  sortUrgentFirst,
} from "./order"

const NOW = Date.parse("2026-07-01T12:00:00Z")

test("a date-only deadline ends at 23:59:59Z that day", () => {
  assert.equal(deadlineInstant("2026-07-01"), Date.parse("2026-07-01T23:59:59Z"))
  assert.equal(deadlineInstant("2026-07-01T15:00:00Z"), Date.parse("2026-07-01T15:00:00Z"))
})

test("overdue, due within 12 hours, or nudged packets are urgent", () => {
  assert.equal(isUrgent({ state: "dispatched", deadline: "2026-06-30" }, NOW), true)
  assert.equal(isUrgent({ state: "accepted", deadline: "2026-07-01T18:00:00Z" }, NOW), true)
  assert.equal(isUrgent({ state: "dispatched", deadline: "2026-07-02T06:00:00Z" }, NOW), false)
  assert.equal(
    isUrgent({ state: "dispatched", deadline: "2026-07-08", nudge_count: 1 }, NOW),
    true,
  )
  assert.equal(isUrgent({ state: "shipped", deadline: "2026-06-01", nudge_count: 4 }, NOW), false)
})

test("countdown names the remaining time and overdue packets", () => {
  assert.equal(countdownLabel("2026-06-30", NOW), "超时")
  assert.equal(countdownLabel("2026-07-01T13:30:00Z", NOW), "1 小时 30 分")
  assert.equal(countdownLabel("2026-07-04", NOW), "3 天")
})

test("shipped detail does not report overdue or an outstanding nudge", () => {
  const row = { posting_number: "P001", deadline: "2026-06-30", nudge_count: 1 }
  assert.equal(dispatchSummary({ ...row, state: "shipped" }, NOW), "单号 P001")
  assert.equal(dispatchSummary({ ...row, state: "accepted" }, NOW), "单号 P001 · 对方在催 · 超时")
})

test("urgent rows move first without dropping or duplicating the rest", () => {
  const rows = [
    { id: "late", state: "dispatched", deadline: "2026-07-08" },
    { id: "soon", state: "accepted", deadline: "2026-07-01T13:00:00Z" },
    { id: "nudged", state: "dispatched", deadline: "2026-07-09", nudge_count: 2 },
    { id: "later", state: "dispatched", deadline: "2026-07-10" },
  ]
  assert.deepEqual(
    sortUrgentFirst(rows, NOW).map((row) => row.id),
    ["soon", "nudged", "late", "later"],
  )
})

test("a nudge stays cooling for 30 minutes", () => {
  assert.equal(nudgeCooling(NOW - 10 * 60 * 1000, NOW), true)
  assert.equal(nudgeCooling(NOW - 31 * 60 * 1000, NOW), false)
  assert.equal(nudgeCooling(null, NOW), false)
})

test("wire-format nudge count marks a live order urgent but not a shipped order", () => {
  assert.equal(isUrgent({ state: "dispatched", nudge_count: 1 }, NOW), true)
  assert.equal(isUrgent({ state: "shipped", nudge_count: 1 }, NOW), false)
})
