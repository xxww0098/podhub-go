import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ListingRow } from "../model/listing-row"
import { noteUploadGate, resetUploadMeter, trackSliceRow } from "../prepare/upload-batch-meter"
import { UploadBatchMeter } from "./upload-batch-meter-view"

test("the batch meter shows count, speed words, the failure, and retries only failed rows", () => {
  resetUploadMeter()
  const row = trackSliceRow("row-b", 4, 4_000_000)
  row.objectDone(1_000_000, false)
  row.fail("网络已断开")
  const failed = {
    id: "row-b",
    upload: "failed",
    preparationUpload: { stage: "upload", state: "failed", message: "网络已断开", since_ms: 1 },
  } as ListingRow
  const html = renderToStaticMarkup(
    <UploadBatchMeter
      rows={[failed, { id: "row-a", upload: "done" } as ListingRow]}
      activity={{ ai: new Set(), render: new Set(), deliver: new Set() }}
      disabled={false}
      onRetryFailed={() => undefined}
    />,
  )
  assert.match(html, /上传 1\/4/)
  assert.match(html, /网络已断开/)
  assert.match(html, /重试全部失败/)
  assert.doesNotMatch(html, /row-a/)
  resetUploadMeter()
})

test("a local confirm queue is visible before any byte moves", () => {
  resetUploadMeter()
  noteUploadGate("本机已核对，排队确认")
  const html = renderToStaticMarkup(
    <UploadBatchMeter
      rows={[]}
      activity={{ ai: new Set(), render: new Set(), deliver: new Set() }}
      disabled={false}
      onRetryFailed={() => undefined}
    />,
  )
  assert.match(html, /本机已核对，排队确认/)
  resetUploadMeter()
})
