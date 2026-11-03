import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { TaskRecord } from "@/bindings/http-task-records"
import { TaskRecordsTable, taskStateLabel } from "./task-records-screen"

test("task receipts keep platform acceptance and unknown results distinct", () => {
  assert.equal(taskStateLabel("accepted"), "平台已受理")
  assert.equal(taskStateLabel("unknown"), "待核对")
  assert.equal(taskStateLabel("succeeded"), "执行完成")
  assert.equal(taskStateLabel("future_state"), "future_state")
  const row: TaskRecord = {
    id: "12345678-1234-4234-8234-123456789abc", kind: "listing", store_id: null,
    store_name: "样例店铺", title: "样例方案", card_id: null, row_id: null,
    state: "accepted", error_code: "", external_task_id: "42", attempt: 0,
    next_attempt_at: null, created_at: "2026-10-31T02:00:00Z", updated_at: "2026-10-31T02:00:00Z",
  }
  const html = renderToStaticMarkup(<TaskRecordsTable items={[row]} onInspect={() => {}} />)
  assert.match(html, /平台已受理/)
  assert.doesNotMatch(html, /已在售/)
  assert.match(html, /查看样例方案的任务记录/)
})
