import assert from "node:assert/strict"
import test from "node:test"
import { failedUploadRowIds, resetUploadMeter, trackSliceRow, uploadMeterSnapshot } from "./upload-batch-meter"

test("batch progress counts finished objects and only retries failed rows", () => {
  resetUploadMeter()
  const first = trackSliceRow("row-a", 2, 200)
  const second = trackSliceRow("row-b", 2, 200)
  first.objectDone(100, true)
  second.fail("请求过于频繁，存储限流")
  const ids = failedUploadRowIds([
    { id: "row-a", upload: "running" },
    { id: "row-b", upload: "failed" },
    { id: "row-c", upload: "failed" },
    { id: "row-d", upload: "done" },
  ], new Set(["row-c"]))
  assert.deepEqual(ids, ["row-b"])
  const meter = uploadMeterSnapshot()
  assert.equal(meter.completed, 1)
  assert.equal(meter.total, 4)
  assert.equal(meter.active, true)
  assert.equal(meter.failureMessage, "请求过于频繁，存储限流")
  first.done()
  assert.equal(uploadMeterSnapshot().active, false)
  resetUploadMeter()
})
