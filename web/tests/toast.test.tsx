import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(
  fileURLToPath(new URL("../src/components/ui/toast.tsx", import.meta.url)),
  "utf8",
)

test("error notifications sit under the top-center edge and always expose close", () => {
  assert.match(source, /fixed top-4 left-1\/2 -translate-x-1\/2/)
  assert.doesNotMatch(source, /top-16/)
  assert.match(source, /aria-label="关闭通知"/)
  assert.match(source, /toastItem\.actionProps \? <ToastAction/)
  assert.match(source, /<ToastClose \/>/)
  assert.doesNotMatch(source, /timeout === 0 \? null/)
  assert.match(source, /data-\[type=unknown\]/)
  assert.match(source, /whitespace-pre-line/)
})
