import assert from "node:assert/strict"
import test from "node:test"
import { errorMessage } from "./error-message"

test("operator copy survives while technical exceptions retain operation context", () => {
  assert.equal(errorMessage({ code: "cloud_writes_disabled", message: "发送已暂停", remediation: "请联系管理员后重试" }, "发送失败"),
    "发送已暂停 请联系管理员后重试")
  assert.equal(errorMessage(new Error("源图已不可用，请重新导入"), "切片失败"), "源图已不可用，请重新导入")
  for (const reason of [new TypeError("Failed to fetch"), new SyntaxError('Unexpected token {"token":"secret"}'),
    "HTTP 502 Bad Gateway", "云端失败 https://private.test/?token=secret", new Error("错误 token=secret"),
    '<Error>上传失败</Error>', '{"message":"上传失败"}']) {
    assert.equal(errorMessage(reason, "保存失败，请重试"), "保存失败，请重试")
  }
  assert.equal(errorMessage(new DOMException("disk full", "QuotaExceededError"), "保存本地行失败"),
    "保存本地行失败：浏览器存储空间不足，内容尚未保存；请释放空间后重试")
  assert.match(errorMessage({ code: "local_storage_full", message: "quota exceeded" }, "保存本地行失败"), /浏览器存储空间不足/)
  assert.equal(errorMessage(new DOMException("gone", "NotFoundError"), "无法打开源图"),
    "无法打开源图：本地文件已不可用；请重新选择或导入文件")
})
