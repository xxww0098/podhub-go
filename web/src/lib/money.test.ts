import assert from "node:assert/strict"
import test from "node:test"

import { formatYuan, topupCentsFromYuan } from "./money"

test("一笔充值只在这里取整一次，非正数不成为请求", () => {
  assert.equal(topupCentsFromYuan("12.34"), 1234)
  // 12.35 * 100 is 1234.9999... in binary floating point; rounding once here is
  // what keeps the operator's ¥12.35 from being sent as ¥12.34.
  assert.equal(topupCentsFromYuan("12.35"), 1235)
  assert.equal(topupCentsFromYuan(" 5 "), 500)
  assert.equal(topupCentsFromYuan(""), null)
  assert.equal(topupCentsFromYuan("abc"), null)
  assert.equal(topupCentsFromYuan("0"), null)
  assert.equal(topupCentsFromYuan("-5"), null)
  assert.equal(topupCentsFromYuan("0.001"), null)
})

test("显示精度跟着量级走：一次 ¥0.003 的调用不能被抹成 ¥0.00", () => {
  assert.equal(formatYuan(0), "¥0.00")
  assert.equal(formatYuan(500_000_000), "¥5.00")
  // 一次调用 = ¥0.003 = 300_000 microfen，最小计费档必须看得见。
  assert.equal(formatYuan(300_000), "¥0.003")
  assert.equal(formatYuan(6_880_000), "¥0.0688")
  assert.equal(formatYuan(50_000_000), "¥0.50")
  // ¥1 以上回到两位，余额不会长出 ¥9.9312 这样的尾巴。
  assert.equal(formatYuan(993_120_000), "¥9.93")
})
