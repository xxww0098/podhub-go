import assert from "node:assert/strict"
import test from "node:test"
import { richContentError } from "./card-rich-content-cell"

test("富内容允许 JSON 对象与清空，拒绝破损 JSON、数组和标量", () => {
  for (const raw of ["", " \n ", "{}", '{"content":[{"text":"油画 🎨"}]}']) {
    assert.equal(richContentError(raw), null, raw)
  }
  for (const raw of ['{"content":', '{"content":[],}', "[{}]", "null", '"{}"', "true", "123"]) {
    assert.notEqual(richContentError(raw), null, raw)
  }
})
