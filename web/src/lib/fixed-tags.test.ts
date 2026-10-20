import assert from "node:assert/strict"
import test from "node:test"

import { FIXED_TAGS_MAX, fixedTagsReady, isValidFixedTag } from "./fixed-tags"

test("isValidFixedTag：# + 西里尔词身（可含数字、_ 连词）", () => {
  assert.equal(isValidFixedTag("#тег"), true)
  assert.equal(isValidFixedTag("#картина_по_номерам"), true)
  assert.equal(isValidFixedTag("#тег2"), true)
  assert.equal(isValidFixedTag("#тег_а1"), true)
  // 拉丁字母、汉字、裸词、裸 #、纯数字段、空词段都过不了 publish 闸。
  assert.equal(isValidFixedTag("#test"), false)
  assert.equal(isValidFixedTag("#标签"), false)
  assert.equal(isValidFixedTag("тег"), false)
  assert.equal(isValidFixedTag("#"), false)
  assert.equal(isValidFixedTag("#123"), false)
  assert.equal(isValidFixedTag("#тег_1"), false)
  assert.equal(isValidFixedTag("#тег__а"), false)
  // 码点口径与 Rust chars().count() 一致：含 # 共 30 过、31 拒。
  assert.equal(isValidFixedTag(`#${"а".repeat(29)}`), true)
  assert.equal(isValidFixedTag(`#${"а".repeat(30)}`), false)
})

test("fixedTagsReady：1–25 个、全合法、大小写不敏感去重", () => {
  assert.equal(FIXED_TAGS_MAX, 25)
  const max = Array.from({ length: FIXED_TAGS_MAX }, (_, i) => `#тег${i}`)
  assert.equal(fixedTagsReady([]), false)
  assert.equal(fixedTagsReady(["#тег"]), true)
  assert.equal(fixedTagsReady(max), true)
  assert.equal(fixedTagsReady([...max, "#лишний"]), false)
  assert.equal(fixedTagsReady(["#тег", "#ТЕГ"]), false)
  assert.equal(fixedTagsReady(["#тег", "#latin"]), false)
})
