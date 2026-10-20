import assert from "node:assert/strict"
import test from "node:test"
import { uploadFailureMessage } from "./upload-failure-copy"

test("upload failures name the cause in Chinese", () => {
  assert.equal(uploadFailureMessage({ status: 429 }), "请求过于频繁，存储限流")
  assert.equal(uploadFailureMessage({ status: 429, code: "media_complete_kept_batch" }), "完成确认繁忙，本机保持整批，不拆成单张")
  assert.equal(uploadFailureMessage({ status: 403 }), "上传签名已过期")
  assert.equal(uploadFailureMessage({ status: 403, code: "cloud_media_upload_batch_invalid" }), "上传批次已失效，请重试上传")
  assert.equal(uploadFailureMessage({ outcomeUnknown: true }), "网络已断开")
  assert.equal(uploadFailureMessage({ name: "TypeError" }), "网络已断开")
  assert.equal(uploadFailureMessage({ code: "media_digest_mismatch" }), "文件校验失败")
  assert.equal(uploadFailureMessage({ code: "psd_etag_missing" }), "对象存储没有返回分片标识")
  assert.equal(uploadFailureMessage({ status: 404, code: "psd_part_gone" }), "分片已失效")
  assert.equal(uploadFailureMessage({ message: "切片清单已变化" }), "切片清单已变化")
})
