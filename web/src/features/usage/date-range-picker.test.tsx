import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  DateRangePicker,
  formatShortDateRange,
  getPresetDateRange,
  PRESET_OPTIONS,
} from "./date-range-picker"

test("formatShortDateRange formats YYYY-MM-DD to MM/DD - MM/DD", () => {
  assert.equal(formatShortDateRange("2026-08-20", "2026-08-20"), "08/20 - 08/20")
  assert.equal(formatShortDateRange("2026-07-24", "2026-08-22"), "07/24 - 08/22")
})

test("getPresetDateRange calculates correct bounds based on given reference date", () => {
  const ref = new Date("2026-08-22T10:00:00Z")

  const today = getPresetDateRange("today", ref)
  assert.equal(today.from, "2026-08-22")
  assert.equal(today.to, "2026-08-22")

  const yesterday = getPresetDateRange("yesterday", ref)
  assert.equal(yesterday.from, "2026-08-21")
  assert.equal(yesterday.to, "2026-08-21")

  const last7 = getPresetDateRange("last7", ref)
  assert.equal(last7.from, "2026-08-16")
  assert.equal(last7.to, "2026-08-22")

  const last30 = getPresetDateRange("last30", ref)
  assert.equal(last30.from, "2026-07-24")
  assert.equal(last30.to, "2026-08-22")

  const thisMonth = getPresetDateRange("thisMonth", ref)
  assert.equal(thisMonth.from, "2026-08-01")
  assert.equal(thisMonth.to, "2026-08-22")

  const lastMonth = getPresetDateRange("lastMonth", ref)
  assert.equal(lastMonth.from, "2026-07-01")
  assert.equal(lastMonth.to, "2026-07-31")
})

test("PRESET_OPTIONS contains all 7 required presets", () => {
  assert.deepEqual(
    PRESET_OPTIONS.map((p) => p.label),
    ["今天", "昨天", "近 7 天", "近 30 天", "本月", "上月", "自定义"],
  )
})

test("DateRangePicker trigger renders 时间维度 and formatted range", () => {
  const html = renderToStaticMarkup(
    <DateRangePicker
      value={{ from: "2026-08-20", to: "2026-08-20", preset: "today" }}
      onChange={() => {}}
    />,
  )

  assert.match(html, /时间维度/)
  assert.match(html, /08\/20 - 08\/20/)
})
