import assert from "node:assert/strict"
import test from "node:test"

import { formatDate, formatDateTimeYearMinute } from "./format"

test("期限类日期带年份：Ozon 密钥到期可能是明年", () => {
  // 本地时间构造、本地时间格式化，断言与运行机器的时区无关。
  assert.equal(formatDate(new Date(2026, 0, 5, 12)), "2026/01/05")
  assert.equal(formatDate(new Date(2026, 11, 31, 12)), "2026/12/31")
})

test("非法输入原样返回，不把 Invalid Date 画进表格", () => {
  assert.equal(formatDate("not-a-date"), "not-a-date")
})

test("顶栏与列表共用同一套年月日时分", () => {
  assert.equal(formatDateTimeYearMinute(new Date(2026, 0, 5, 18, 30, 59)), "2026/01/05 18:30")
  assert.equal(formatDateTimeYearMinute("not-a-date"), "not-a-date")
})
