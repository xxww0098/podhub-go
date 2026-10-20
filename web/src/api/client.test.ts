import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"

import { UNAUTHENTICATED_EVENT, api, request, retryAfterMs } from "@/api/client"
import { errorMessage } from "@/lib/error-message"

type Fetch = typeof globalThis.fetch

function stubFetch(next: Fetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = next
  return () => {
    globalThis.fetch = previous
  }
}

/** node has no `window`; the client only dispatches when one exists. */
function stubWindow(): { events: number, restore: () => void } {
  const scope = globalThis as unknown as { window?: EventTarget }
  const previous = scope.window
  const target = new EventTarget()
  const counted = { events: 0, restore: () => { scope.window = previous } }
  target.addEventListener(UNAUTHENTICATED_EVENT, () => {
    counted.events += 1
  })
  scope.window = target
  return counted
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function captureConsole(): { lines: string[], restore: () => void } {
  const lines: string[] = []
  const previous = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => typeof value === "string" ? value : String(value)).join(" "))
  }
  return { lines, restore: () => { console.log = previous } }
}

test("a 2xx answer is unwrapped out of the Cloud data envelope", async () => {
  const restore = stubFetch(async (input, init) => {
    assert.equal(input, route("viewAccountOverview"))
    assert.equal(init?.credentials, "include")
    return jsonResponse(200, { data: { email: "operator@example.com" } })
  })

  try {
    const overview = await api.get<{ email: string }>(route("viewAccountOverview"))
    assert.deepEqual(overview, { email: "operator@example.com" })
  } finally {
    restore()
  }
})

test("a Cloud refusal keeps its code in the renderer's namespace and its copy", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(400, {
      error: "自建工作空间已达上限（3/3）",
      code: "WORKSPACE_LIMIT_REACHED",
    }),
  )

  try {
    await assert.rejects(
      api.post(route("workspaces"), { name: "新工作空间" }),
      (reason: unknown) => {
        assert.ok(reason instanceof Error)
        assert.equal(
          (reason as { code?: string }).code,
          "cloud_workspace_limit_reached",
        )
        assert.equal(
          errorMessage(reason, "无法创建工作空间"),
          "自建工作空间已达上限（3/3）",
        )
        return true
      },
    )
  } finally {
    restore()
  }
})

test("a 401 rejects as unauthenticated and announces itself once", async () => {
  const restore = stubFetch(async () => jsonResponse(401, { code: "AUTH_REQUIRED", message: "会话已失效" }))
  const observed = stubWindow()

  try {
    await assert.rejects(api.get(route("authSession")), (reason: unknown) => {
      assert.equal((reason as { code?: string }).code, "unauthenticated")
      return true
    })
    assert.equal(observed.events, 1)
  } finally {
    observed.restore()
    restore()
  }
})

test("a write transport failure keeps its stable code without claiming it can be repeated", async () => {
  const transportError = new TypeError("Failed to fetch")
  const restore = stubFetch(async () => {
    throw transportError
  })

  try {
    await assert.rejects(api.del(route("invitationsByUuid", { uuid: "abc" })), (reason: unknown) => {
      const error = reason as { code?: string, remediation?: string | null }
      assert.equal(error.code, "cloud_unavailable")
      assert.equal(error.remediation, "请刷新核对云端记录；不要重复提交已发起的操作。")
      assert.equal((reason as { cause?: unknown }).cause, transportError)
      // The toast carries the recovery hint, not just the symptom.
      assert.equal(
        errorMessage(reason, "无法撤销邀请"),
        "云端连接中断，本次操作结果未被确认 请刷新核对云端记录；不要重复提交已发起的操作。",
      )
      return true
    })
  } finally {
    restore()
  }
})

test("a timed-out wait becomes the Cloud outage without implying a refund", async () => {
  const restore = stubFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error("timeout must abort the fetch"))
      return
    }
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
    })
  }))

  try {
    await assert.rejects(
      request("GET", route("authSession"), undefined, {}, 20),
      (reason: unknown) => {
        const error = reason as { code?: string, cause?: { name?: string } }
        assert.equal(error.code, "cloud_unavailable")
        assert.equal(error.cause?.name, "AbortError")
        return true
      },
    )
  } finally {
    restore()
  }
})

test("a listing writeback pending refusal carries the purchase id for settle recovery", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(409, {
      error: "识图已计费，商品尚未写入，请核对后重试写回",
      code: "LISTING_WRITEBACK_PENDING",
      ocrRecovery: { jobId: "job-1", requestId: "air-pending" },
    }),
  )
  try {
    await assert.rejects(api.post(route("aiOcrCompletions")), (reason: unknown) => {
      const refusal = reason as { status?: number, code?: string, requestId?: string }
      assert.equal(refusal.status, 409)
      assert.equal(refusal.code, "cloud_listing_writeback_pending")
      assert.equal(refusal.requestId, "air-pending")
      return true
    })
  } finally {
    restore()
  }
})

test("a listing 422 keeps structured blockers next to the envelope message", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(422, {
      error: "当前状态无法执行此操作",
      code: "VALIDATION",
      blockers: ["missing_render_evidence"],
    }),
  )

  try {
    await assert.rejects(
      api.post(route("listingRowsByIdPrepare", { id: "row-1" })),
      (reason: unknown) => {
        const refusal = reason as { code?: string, message?: string, blockers?: unknown[] }
        assert.equal(refusal.code, "cloud_validation")
        assert.equal(refusal.message, "当前状态无法执行此操作")
        assert.deepEqual(refusal.blockers, ["missing_render_evidence"])
        return true
      },
    )
  } finally {
    restore()
  }
})

test("a supplier listability refusal keeps its denial code", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(409, {
      error: "该商品的 Ozon 类目目录已过期，平台正在刷新，请稍后重试",
      code: "supplier_not_listable",
      denial: "catalog_expired",
    }),
  )

  try {
    await assert.rejects(
      api.post(route("listingCards"), { supplierProductId: "p", sourceAssetIds: ["a"], idempotencyKey: "k" }),
      (reason: unknown) => {
        const refusal = reason as { code?: string, denial?: string, message?: string }
        assert.equal(refusal.code, "cloud_supplier_not_listable")
        assert.equal(refusal.denial, "catalog_expired")
        assert.equal(refusal.message, "该商品的 Ozon 类目目录已过期，平台正在刷新，请稍后重试")
        return true
      },
    )
  } finally {
    restore()
  }
})

test("a congestion answer carries its status and Retry-After for the busy wait", async () => {
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ code: "INTERNAL", message: "该 Workspace 的并发预算已用尽，请稍后重试" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "2" },
    }),
  )

  try {
    await assert.rejects(api.post(route("mediaObjectsByDigestByExtensionProbe", { digest: "abc", extension: "jpg" })), (reason: unknown) => {
      const refusal = reason as { status?: number, retryAfterMs?: number, code?: string }
      assert.equal(refusal.status, 429)
      assert.equal(refusal.retryAfterMs, 2000)
      assert.equal(refusal.code, "cloud_internal")
      return true
    })
  } finally {
    restore()
  }

  const now = Date.UTC(2026, 8, 4, 8, 0, 0)
  assert.equal(
    retryAfterMs(new Headers({ "Retry-After": "Fri, 04 Sep 2026 08:00:05 GMT" }), now),
    5000,
    "an HTTP-date is read relative to now",
  )
  assert.equal(retryAfterMs(new Headers({ "Retry-After": "soon" })), undefined)
  assert.equal(retryAfterMs(new Headers()), undefined)
})

test("an HTTP failure logs safe request diagnostics and the response request id", async () => {
  const restoreFetch = stubFetch(async () => new Response(JSON.stringify({ message: "failed" }), {
    status: 500,
    headers: { "Content-Type": "application/json", "x-request-id": "req-123" },
  }))
  const captured = captureConsole()

  try {
    await assert.rejects(api.get("/api/private?token=secret"))
    assert.match(captured.lines[0] ?? "", /\[api\] error .*method=GET path=\/api\/private .*status=500 .*requestId=req-123 .*kind=http/)
    assert.doesNotMatch(captured.lines[0] ?? "", /token=secret/)
  } finally {
    captured.restore()
    restoreFetch()
  }
})

test("a non-empty malformed response rejects as an unconfirmed result, never a quiet undefined", async () => {
  const restoreFetch = stubFetch(async () => new Response('{"token":"response-secret",broken}', {
    status: 200,
    headers: { "Content-Type": "application/json", "x-request-id": "req-json" },
  }))
  const captured = captureConsole()

  try {
    await assert.rejects(
      api.get(`${route("viewAccountOverview")}?email=secret`),
      (reason: unknown) => {
        assert.equal((reason as { code?: string }).code, "cloud_bad_response")
        return true
      },
    )
    assert.match(captured.lines[0] ?? "", /\[api\] error .*method=GET path=\/api\/view\/account-overview .*status=200 .*requestId=req-json .*kind=json/)
    assert.match(captured.lines[0] ?? "", /frames=.*readPayload/)
    assert.doesNotMatch(captured.lines[0] ?? "", /email=secret/)
    assert.doesNotMatch(captured.lines[0] ?? "", /response-secret/)
  } finally {
    captured.restore()
    restoreFetch()
  }
})

test("a 2xx without the data envelope rejects instead of reading as a void", async () => {
  const restoreFetch = stubFetch(async () => jsonResponse(200, { unexpected: true }))
  const captured = captureConsole()
  try {
    await assert.rejects(api.get(route("viewAccountOverview")), (reason: unknown) => {
      assert.equal((reason as { code?: string }).code, "cloud_bad_response")
      return true
    })
  } finally {
    captured.restore()
    restoreFetch()
  }
})

test("the deadline covers a stalled response body, not just the headers", async () => {
  const restoreFetch = stubFetch(async (_input, init) => {
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(Object.assign(new Error("Aborted"), { name: "AbortError" }))
        })
      },
    })
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })
  })

  try {
    const startedAt = Date.now()
    await assert.rejects(
      request("GET", route("authSession"), undefined, {}, 20),
      (reason: unknown) => {
        assert.equal((reason as { code?: string }).code, "cloud_unavailable")
        return true
      },
    )
    assert.ok(Date.now() - startedAt < 5000, "the body stall must trip the deadline")
  } finally {
    restoreFetch()
  }
})


test("caller cancellation covers the body and leaves status/trace separate from OCR identity", async () => {
  let controller = new AbortController()
  const restore = stubFetch(async (_input, init) => new Response(new ReadableStream({
    start(stream) { init?.signal?.addEventListener("abort", () => stream.error(new DOMException("Stopped", "AbortError")), { once: true }) },
  })))
  try {
    const pending = request("GET", "/api/test", undefined, {}, 1000, undefined, { callerSignal: controller.signal, reportOwner: "caller" })
    await Promise.resolve()
    controller.abort()
    await assert.rejects(pending, { code: "cloud_unavailable" })
    controller = new AbortController()
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "AUTH_REQUIRED", ocrRecovery: { requestId: "ocr-1" } }), {
      status: 401, headers: { "x-request-id": "http-1" },
    })
    await assert.rejects(request("GET", "/api/test", undefined, {}, 1000, undefined, { reportOwner: "caller" }), {
      code: "unauthenticated", status: 401, serverCode: "AUTH_REQUIRED", traceId: "http-1", requestId: "ocr-1",
    })
  } finally { restore() }
})

test("settled requests detach caller cancellation listeners", async () => {
  const controller = new AbortController()
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  let removed = 0
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => { removed++; remove(...args) }
  const restore = stubFetch(async () => jsonResponse(200, { data: 1 }))
  try {
    assert.equal(await request("GET", "/api/test", undefined, {}, 1000, undefined, { callerSignal: controller.signal }), 1)
    assert.equal(removed, 1)
  } finally { restore() }
})

test("presign grants opt into store checksums and confirm routes do not", async () => {
  const seen: string[] = []
  const restore = stubFetch(async (input, init) => {
    const headers = new Headers(init?.headers)
    seen.push(`${String(input)} ${headers.get("x-podhub-store-checksum") ?? ""}`)
    return jsonResponse(200, { data: {} })
  })
  try {
    const presign = route("mediaObjectsByDigestByExtensionPresign", { digest: "abc", extension: "jpg" })
    const presignBatch = route("mediaObjectsPresignBatch")
    const templates = route("listingTemplates")
    const uploads = route("aiOcrUploads")
    const avatar = route("avatarsWorkspacesByWorkspaceIdUpload", { workspace_id: 1 })
    const confirm = route("aiOcrUploadsConfirm")
    const templateConfirm = route("listingTemplatesByIdConfirm", { id: "id" })
    await request("POST", presign, { byteLength: 1 })
    await request("POST", presignBatch, { objects: [] })
    await request("POST", templates, { sha256: "a" })
    await request("POST", uploads, { image: {} })
    await request("POST", avatar, { bytes: 1 })
    await request("POST", confirm, {})
    await request("POST", templateConfirm)
    assert.deepEqual(seen, [
      `${presign} sha256`,
      `${presignBatch} sha256`,
      `${templates} sha256`,
      `${uploads} sha256`,
      `${avatar} sha256`,
      `${confirm} `,
      `${templateConfirm} `,
    ])
  } finally { restore() }
})
