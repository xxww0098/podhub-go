import assert from "node:assert/strict"
import test from "node:test"
import { getBytes, request, type CloudRefusal } from "./client"
import { route } from "./routes"
import { errorMessage } from "@/lib/error-message"

async function withFetch(next: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch
  globalThis.fetch = next
  try { await run() } finally { globalThis.fetch = previous }
}

const transports = [
  { name: "JSON", run: () => request("POST", route("workspaces"), {}, {}, undefined, undefined, { reportOwner: "caller" }) },
  { name: "binary GET", run: () => getBytes(route("avatarsMe")) },
]

test("HTTP status and exact server code retain one mapping across all transports", async () => {
  for (const { status, serverCode, code } of [
    { status: 401, serverCode: "AUTH_INVALID", code: "unauthenticated" },
    { status: 403, serverCode: "FORBIDDEN", code: "cloud_forbidden" },
    { status: 429, serverCode: "INTERNAL", code: "cloud_internal" },
    { status: 409, serverCode: "supplier_not_listable", code: "cloud_supplier_not_listable" },
    { status: 500, serverCode: "FUTURE_DOMAIN_CODE", code: "cloud_future_domain_code" },
    { status: 503, serverCode: undefined, code: "cloud_request_failed" },
  ]) {
    await withFetch(async () => Response.json({ code: serverCode, error: "服务端说明", ocrRecovery: { requestId: "ocr-purchase" } }, {
      status, headers: { "x-request-id": "http-trace", "Retry-After": "2" },
    }), async () => {
      for (const transport of transports) {
        await assert.rejects(transport.run(), (reason: unknown) => {
          const failure = reason as CloudRefusal
          assert.equal(failure.code, code, transport.name)
          assert.equal(failure.status, status)
          assert.equal(failure.serverCode, serverCode)
          assert.equal(failure.traceId, "http-trace")
          assert.equal(failure.requestId, "ocr-purchase")
          assert.equal(failure.retryAfterMs, 2000)
          assert.equal(errorMessage(failure, "操作失败"), "服务端说明")
          return true
        })
      }
    })
  }
})

test("a supplier publish-gate refusal retains its missing requirements", async () => {
  await withFetch(async () => Response.json({ code: "VALIDATION", error: "上架前置条件未齐备", missing: ["category", "prompt", "ozonConfig"] }, {
    status: 400,
  }), async () => {
    await assert.rejects(transports[0]!.run(), (reason: unknown) => {
      assert.equal((reason as CloudRefusal).code, "cloud_validation")
      assert.deepEqual((reason as CloudRefusal).missing, ["category", "prompt", "ozonConfig"])
      return true
    })
  })
})

test("writes with no operator explanation stay unconfirmed; reads keep their generic fallback", async () => {
  for (const body of [{}, { code: "FUTURE_DOMAIN_CODE" }]) {
    await withFetch(async () => Response.json(body, { status: 502 }), async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        await assert.rejects(request(method, route("workspaces"), undefined, {}, undefined, undefined, { reportOwner: "caller" }), (reason: unknown) => {
          const copy = errorMessage(reason, "操作失败，请重试")
          assert.match(copy, /未确认本次操作结果.*不要重复提交/)
          assert.doesNotMatch(copy, /失败|重试|重发/)
          return true
        })
      }
      await assert.rejects(request("GET", route("authSession"), undefined, {}, undefined, undefined, { reportOwner: "caller" }), { message: "云端请求失败（HTTP 502）" })
    })
  }
})

test("write timeout and JSON disconnect do not invite resubmission", async () => {
  await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
  }), async () => {
    await assert.rejects(request("POST", route("workspaces"), {}, {}, 10, undefined, { reportOwner: "caller" }), (reason: unknown) => {
      const failure = reason as CloudRefusal & { cause?: Error }
      assert.equal(failure.code, "cloud_unavailable")
      assert.equal(failure.cause?.name, "TimeoutError")
      assert.match(errorMessage(failure, "操作失败"), /结果未被确认.*不要重复提交/)
      return true
    })
  })
  await withFetch(async () => { throw new TypeError("Failed to fetch") }, async () => {
    await assert.rejects(transports[0]!.run(), (reason: unknown) => {
      assert.match(errorMessage(reason, "上传失败"), /结果未被确认.*不要重复提交/)
      return true
    })
    await assert.rejects(transports[1]!.run(), { message: "云端服务暂时不可用", remediation: "请稍后重试；若问题持续，请检查网络连接。" })
  })
})
