import assert from "node:assert/strict"
import test from "node:test"
import { unusableMessage } from "./ocr-recovery"

const attempt = (status: string) => ({ status }) as Parameters<typeof unusableMessage>[0]

test("released contract refusals say uncharged; any settled attempt keeps the billed copy", () => {
  const released = unusableMessage(attempt("unbilled_unknown"), attempt("unbilled_unknown"))
  assert.match(released, /本次未计费（预占已释放）/)
  assert.doesNotMatch(released, /已计费，/)
  assert.match(unusableMessage(attempt("settled"), attempt("settled")), /已计费，结果未写入商品/)
  assert.match(unusableMessage(attempt("unbilled_unknown"), attempt("settled")), /已计费，结果未写入商品/)
})
