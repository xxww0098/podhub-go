import assert from "node:assert/strict"
import test from "node:test"
import { unusableMessage } from "./ocr-recovery"
const attempt = (status: string) => ({ status }) as Parameters<typeof unusableMessage>[0]
test("receipt copy follows the original purchase's billing fact", () => {
 for (const status of ["unbilled_unknown", "failed"]) {
  const message = unusableMessage(attempt(status))
  assert.match(message,/本次未计费（预占已释放）/)
  assert.doesNotMatch(message,/已计费，/)
 }
 assert.match(unusableMessage(attempt("settled")),/已计费，结果未写入商品/)
})
