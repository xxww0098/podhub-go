import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { spaDeviceId } from "@/lib/spa-device-id"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { delegateHttp, type DelegateAssetUploadTarget, type DelegateAssetView } from "./delegate-http"
import { reportUploadUsage, uploadDelegateAsset, type UploadAssetDeps } from "./delegate-upload"

const FILE_BYTES = new TextEncoder().encode("delegate-asset-bytes")
const SHA = "32058268891698995849959c78431d3768ad4d9cd64fd2d32ff17effdddb2d289a"
function testFile(): File {
  return new File([FILE_BYTES], "原图.PNG", { type: "image/png" })
}
function target(ticket = "receipt-1"): DelegateAssetUploadTarget {
  return { object_key: "42/digest.png", upload_ticket: ticket, upload: {
    url: "https://s3.example/object?signature=secret", headers: { content_type: "image/png", if_none_match: "*" }, expires_at_ms: Date.now() + 600_000,
  } }
}
function asset(): DelegateAssetView {
  return { asset_id: "asset-1", binding_id: "binding-1", bytes: FILE_BYTES.length,
    created_at_ms: 1, file_name: "原图.PNG", mime: "image/png", position: 0,
    sha256: SHA, verified: true, verified_at_ms: 2 }
}
function error(code: string, status?: number): Error {
  return Object.assign(new Error("safe failure"), { code, status })
}
const missing = () => error("cloud_media_complete_missing", 404)
const lost = () => Object.assign(error("direct_upload_failed"), { outcomeUnknown: true })
function deps(overrides: Partial<UploadAssetDeps> = {}): UploadAssetDeps {
  return { presign: async () => target(), putObject: async (_target, file, options) => {
    options?.onProgress?.(file.size, file.size)
  }, finalize: async () => asset(), report: async () => {}, wait: async () => {}, ...overrides }
}

// No full-file ArrayBuffer allocation: hashUploadBody may only read bounded slices.
test("hash uses bounded Blob slices and anonymous PUT receives the original File", async () => {
  const file = testFile()
  file.arrayBuffer = async () => { throw new Error("whole file allocated") }
  const calls: string[] = []
  const result = await uploadDelegateAsset(deps({
    presign: async (spec) => {
      calls.push("grant")
      assert.equal(spec.bytes, file.size)
      assert.equal(spec.mime, "image/png")
      assert.match(spec.sha256, /^[0-9a-f]{64}$/)
      return target()
    }, putObject: async (upload, body, options) => {
      calls.push("put")
      assert.equal(body, file)
      assert.equal(upload.upload_ticket, "receipt-1")
      options?.onProgress?.(file.size, file.size)
    }, finalize: async (confirmation) => {
      calls.push("confirm")
      assert.deepEqual(confirmation, { binding_id: "binding-1", upload_ticket: "receipt-1", file_name: file.name, position: undefined })
      return asset()
    }, report: async () => { calls.push("usage") },
  }), { binding_id: "binding-1", file })
  assert.equal(result.asset_id, "asset-1")
  assert.deepEqual(calls, ["grant", "put", "confirm", "usage"])
})

test("lost PUT response confirms before any retransmit", async () => {
  const calls: string[] = []
  const result = await uploadDelegateAsset(deps({ putObject: async () => {
    calls.push("put"); throw lost()
  }, finalize: async () => { calls.push("confirm"); return asset() } }), { binding_id: "binding-1", file: testFile() })
  assert.equal(result.asset_id, "asset-1")
  assert.deepEqual(calls, ["put", "confirm"])
})

test("lost confirmation response replays the same ticket, not bytes", async () => {
  let puts = 0
  const tickets: string[] = []
  await uploadDelegateAsset(deps({ putObject: async () => { puts++ }, finalize: async (body) => {
    tickets.push(body.upload_ticket)
    if (tickets.length === 1) throw error("cloud_unavailable")
    return asset()
  } }), { binding_id: "binding-1", file: testFile() })
  assert.equal(puts, 1)
  assert.deepEqual(tickets, ["receipt-1", "receipt-1"])
})

test("only explicit object missing permits retransmission", async () => {
  const calls: string[] = []
  let confirms = 0
  await uploadDelegateAsset(deps({ putObject: async () => { calls.push("put"); if (confirms === 0) throw lost() },
    finalize: async () => { calls.push("confirm"); if (++confirms === 1) throw missing(); return asset() },
  }), { binding_id: "binding-1", file: testFile() })
  assert.deepEqual(calls, ["put", "confirm", "put", "confirm"])
  let puts = 0
  await assert.rejects(uploadDelegateAsset(deps({ putObject: async () => { puts++; throw lost() },
    finalize: async () => { throw error("cloud_not_found", 404) },
  }), { binding_id: "binding-1", file: testFile() }), { code: "cloud_not_found" })
  assert.equal(puts, 1)
})

test("403 renewal follows missing confirmation and happens at most once", async () => {
  const calls: string[] = []
  let grants = 0
  await uploadDelegateAsset(deps({ presign: async () => { calls.push("grant"); return target("receipt-" + ++grants) },
    putObject: async () => { calls.push("put"); if (grants === 1) throw error("direct_upload_failed", 403) },
    finalize: async (body) => { calls.push("confirm"); if (body.upload_ticket === "receipt-1") throw missing(); return asset() },
  }), { binding_id: "binding-1", file: testFile() })
  assert.deepEqual(calls, ["grant", "put", "confirm", "grant", "put", "confirm"])
  grants = 0
  await assert.rejects(uploadDelegateAsset(deps({ presign: async () => { grants++; return target() },
    putObject: async () => { throw error("direct_upload_failed", 403) }, finalize: async () => { throw missing() },
  }), { binding_id: "binding-1", file: testFile() }), { status: 403 })
  assert.equal(grants, 2)
})

test("412 success-to-confirm with no byte progress creates no phantom traffic", async () => {
  let reports = 0
  let confirms = 0
  await uploadDelegateAsset(deps({ putObject: async () => {}, finalize: async () => { confirms++; return asset() },
    report: async () => { reports++ },
  }), { binding_id: "binding-1", file: testFile() })
  assert.equal(confirms, 1)
  assert.equal(reports, 0)
})

test("wrong actual bytes refusal is terminal and never uploads again", async () => {
  let puts = 0
  await assert.rejects(uploadDelegateAsset(deps({ putObject: async () => { puts++ },
    finalize: async () => { throw error("cloud_validation", 422) },
  }), { binding_id: "binding-1", file: testFile() }), { status: 422 })
  assert.equal(puts, 1)
})

test("retry budget is shared across grant and confirmation", async () => {
  let grants = 0
  let puts = 0
  let confirms = 0
  await assert.rejects(uploadDelegateAsset(deps({
    presign: async () => { if (++grants === 1) throw error("cloud_unavailable"); return target() },
    putObject: async () => { puts++ }, finalize: async () => { confirms++; throw error("cloud_unavailable") },
  }), { binding_id: "binding-1", file: testFile() }), { code: "cloud_unavailable" })
  assert.equal(grants, 2)
  assert.equal(puts, 1)
  assert.equal(confirms, 3)
})

test("actor/workspace invalidation and native scope fence stop before next step", async () => {
  let puts = 0
  await assert.rejects(uploadDelegateAsset(deps({ presign: async () => {
    invalidateAllSessionCaches(); return target()
  }, putObject: async () => { puts++ } }), { binding_id: "binding-1", file: testFile() }), { code: "upload_cancelled" })
  assert.equal(puts, 0)
  let current = true
  let confirms = 0
  await assert.rejects(uploadDelegateAsset(deps({ putObject: async () => { current = false },
    finalize: async () => { confirms++; return asset() },
  }), { binding_id: "binding-1", file: testFile(), isCurrent: () => current }), { code: "upload_cancelled" })
  assert.equal(confirms, 0)
})

test("public AbortSignal is propagated and cancels confirmation retries", async () => {
  const controller = new AbortController()
  await assert.rejects(uploadDelegateAsset(deps({ finalize: async (_body, signal) => {
    assert.ok(signal)
    controller.abort()
    throw error("cloud_unavailable")
  } }), { binding_id: "binding-1", file: testFile(), signal: controller.signal }), { code: "upload_cancelled" })
})

test("HTTP PUT sends only restricted S3 headers and no session or receipt", async () => {
  const originalFetch = globalThis.fetch
  let init: RequestInit | undefined
  let url = ""
  globalThis.fetch = async (input, options) => { url = String(input); init = options; return new Response(null, { status: 412 }) }
  try {
    await delegateHttp.putAssetObject(target(), testFile())
    assert.equal(url, target().upload.url)
    assert.equal(init?.method, "PUT")
    assert.equal(init?.credentials, "omit")
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("content-type"), "image/png")
    assert.equal(headers.get("if-none-match"), "*")
    assert.equal(headers.get("authorization"), null)
    assert.equal(headers.get("x-delegate-upload-token"), null)
    assert.equal(headers.get("cookie"), null)
    assert.equal(JSON.stringify(init).includes("receipt-1"), false)
  } finally { globalThis.fetch = originalFetch }
})

test("流量上报按 OBJECT_UPLOAD_USAGE_KIND 走事件收件箱，失败静默进诊断日志", async () => {
  const posts: { path: string; body: unknown; deviceId: string }[] = []
  const payload = {
    schemaVersion: 1 as const,
    bytes: 12,
    occurredAt: "2026-09-22T00:00:00.000Z",
    objectKey: "42/abc.png",
    contentHash: "abc",
    outcome: "uploaded" as const,
  }

  await reportUploadUsage(
    payload,
    async (path, body, deviceId) => {
      posts.push({ path, body, deviceId })
    },
    () => "spa-device-1",
  )

  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.path, route("eventsInbox"))
  assert.equal(posts[0]!.deviceId, "spa-device-1")
  const body = posts[0]!.body as {
    events: {
      id: string
      kind: string
      schema_version: number
      payload_json: string
    }[]
  }
  assert.equal(body.events.length, 1)
  const event = body.events[0]!
  assert.equal(event.kind, "billing.object-upload-usage.v1")
  assert.equal(event.schema_version, 1)
  assert.match(event.id, /^asset-upload-abc-12$/)
  assert.deepEqual(JSON.parse(event.payload_json), payload)

  // 旁路纪律：收件箱拒收不打断上传结果，也不向用户弹错。
  await reportUploadUsage(
    payload,
    async () => {
      throw new Error("inbox refused")
    },
    () => "spa-device-1",
  )
})

test("SPA 设备标识：首次生成并落 localStorage，之后复用", () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
  const first = spaDeviceId(storage)
  assert.match(first, /^spa-[0-9a-f-]{36}$/)
  assert.equal(store.get("podhub:spa-device-id"), first)
  assert.equal(spaDeviceId(storage), first, "同一浏览器必须复用同一个标识")
})

test("S3 network failures never expose URL XML or nested transport causes", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error(target().upload.url + "<Error>private XML</Error>") }
  try {
    await assert.rejects(delegateHttp.putAssetObject(target(), testFile()), (reason: unknown) => {
      const safe = reason as Error & { cause?: unknown; outcomeUnknown?: boolean }
      assert.equal(safe.cause, undefined)
      assert.equal(safe.outcomeUnknown, true)
      assert.equal(safe.message.includes("signature"), false)
      assert.equal(safe.message.includes("XML"), false)
      assert.equal(JSON.stringify(safe).includes("s3.example"), false)
      return true
    })
  } finally { globalThis.fetch = originalFetch }
})

test("binding or storage authorization changes are terminal, never relay fallbacks", async () => {
  let puts = 0
  let grants = 0
  await assert.rejects(uploadDelegateAsset(deps({ presign: async () => { grants++; return target() },
    putObject: async () => { puts++ }, finalize: async () => { throw error("cloud_conflict", 409) },
  }), { binding_id: "binding-1", file: testFile() }), { code: "cloud_conflict" })
  assert.equal(grants, 1)
  assert.equal(puts, 1)
})
