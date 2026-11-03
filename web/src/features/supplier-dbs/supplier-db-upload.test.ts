import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { supplierDbsHttp } from "@/bindings/http-supplier-dbs"
import { GALLERY_MAX_BYTES, PSD_MAX_BYTES, VIDEO_MAX_BYTES, uploadFileError, uploadCountError, uploadContentType,
  supplierDbUploadFile, isUploadAbort, type SupplierDbPresign, type SupplierDbConfirm, type SupplierDbUploadTarget, type SupplierUploadAttempts } from "./supplier-db-upload"

const ready = { key: "supplier-dbs/s1/a.png", publicUrl: "https://cdn.invalid/supplier-dbs/s1/a.png" }
function target(expiresAtMs = Date.now() + 600_000): SupplierDbUploadTarget {
  return { uploadTicket: "opaque-ticket", upload: { url: "https://s3.invalid/stage/a?secret=redacted", expires_at_ms: expiresAtMs,
    headers: { content_type: "image/png", if_none_match: "*" } } }
}
function stubFetch(fn: typeof fetch) { const previous = globalThis.fetch; globalThis.fetch = fn; return () => { globalThis.fetch = previous } }
const missing = () => Object.assign(new Error("missing"), { code: "cloud_upload_object_missing", status: 404 })
const file = () => new File(["png bytes"], "a.png", { type: "image/png" })
const presign: SupplierDbPresign = async () => ({ ok: true, value: target() })

test("native extension, size and count preflight remains bounded", () => {
  for (const [kind, name, cap] of [["gallery", "a.png", GALLERY_MAX_BYTES], ["psd", "a.psd", PSD_MAX_BYTES], ["video", "a.mp4", VIDEO_MAX_BYTES]] as const) {
    assert.equal(uploadFileError(kind, { name, size: cap }), null)
    assert.ok(uploadFileError(kind, { name, size: cap + 1 }))
    assert.ok(uploadFileError(kind, { name, size: 0 }))
  }
  assert.ok(uploadFileError("gallery", { name: "a.psd", size: 1 }))
  assert.equal(uploadCountError("gallery", 19), null)
  assert.ok(uploadCountError("gallery", 20))
})
test("extension determines the exact signed native MIME", () => {
  assert.equal(uploadContentType("gallery", { name: "a.PNG", type: "image/jpeg" }), "image/png")
  assert.equal(uploadContentType("psd", { name: "a.psd", type: "" }), "image/vnd.adobe.photoshop")
  assert.equal(uploadContentType("video", { name: "a.mov", type: "" }), "video/quicktime")
})
test("a fresh PSD grant does not resubmit an unsupported cached resume ticket", async (t) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ uploadId: "old-upload", ticket: "old-ticket", completed: [] }),
    setItem() {}, removeItem() {},
  } })
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    if (worker) Object.defineProperty(globalThis, "Worker", worker)
    else Reflect.deleteProperty(globalThis, "Worker")
  })
  const body = new File([new Uint8Array(16 * 1024 * 1024 + 1)], "artwork.psd")
  const issue: SupplierDbPresign = async (_, request) => {
    assert.deepEqual(Object.keys(request).sort(), ["bytes", "contentType", "filename", "kind", "sha256"])
    assert.equal(request.kind, "psd")
    return { ok: true, value: { uploadTicket: "new-ticket", alreadyPresent: true } }
  }
  const result = await supplierDbUploadFile(issue, "s1", { kind: "psd", file: body }, { confirm: async (_, ticket) => {
    assert.equal(ticket, "new-ticket")
    return ready
  } })
  assert.deepEqual(result, ready)
})
test("hash → anonymous immutable File PUT → authenticated confirm; only confirm returns URL", async () => {
  const events: string[] = []; let seen: RequestInit | undefined
  const body = file()
  const issue: SupplierDbPresign = async (_, request) => { events.push("issue"); assert.match(request.sha256, /^[0-9a-f]{64}$/); assert.equal(request.bytes, body.size); return { ok: true, value: target() } }
  const restore = stubFetch(async (_, init) => { events.push("put"); seen = init; return new Response(null, { status: 200 }) })
  try {
    const value = await supplierDbUploadFile(issue, "s1", { kind: "gallery", file: body }, { confirm: async (_, ticket) => { events.push("confirm"); assert.equal(ticket, "opaque-ticket"); return ready } })
    assert.deepEqual(value, ready); assert.deepEqual(events, ["issue", "put", "confirm"])
    assert.equal(seen?.credentials, "omit"); assert.equal(seen?.redirect, "error"); assert.equal(seen?.body, body)
    assert.deepEqual(seen?.headers, { "Content-Type": "image/png", "If-None-Match": "*" })
  } finally { restore() }
})
test("large PSD uses the management multipart DTO and confirms ordered ETags before exposing its URL", async (t) => {
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker")
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
  t.after(() => {
    if (worker) Object.defineProperty(globalThis, "Worker", worker)
    else Reflect.deleteProperty(globalThis, "Worker")
  })
  const partSize = 16 * 1024 * 1024
  const body = new File([new Uint8Array(partSize + 7).fill(7)], "large.psd")
  const events: string[] = []
  const uploadPath = route("adminSupplierDbsBySourceIdUploads", { source_id: "s1" })
  const confirmPath = route("adminSupplierDbsBySourceIdUploadsConfirm", { source_id: "s1" })
  const restore = stubFetch(async (input, init) => {
    const path = String(input)
    if (path === uploadPath) {
      events.push("issue")
      const request = JSON.parse(String(init?.body))
      assert.equal(request.bytes, body.size)
      assert.equal(request.content_type, "image/vnd.adobe.photoshop")
      assert.equal("contentType" in request, false)
      assert.match(request.sha256, /^[0-9a-f]{64}$/)
      assert.equal(init?.credentials, "include")
      return Response.json({ data: { upload: { upload_ticket: "multipart-ticket", multipart: {
        upload_id: "supplier-large-upload", part_size: partSize, ticket: "multipart-ticket",
        parts: [partSize, 7].map((byteLength, index) => ({ part_number: index + 1,
          url: `https://s3.invalid/large-part-${index + 1}`, byte_length: byteLength, expires_at_ms: Date.now() + 60_000 })),
      } } } })
    }
    if (path.startsWith("https://s3.invalid/large-part-")) {
      const part = Number(path.at(-1))
      events.push(`part-${part}`)
      assert.equal(init?.method, "PUT")
      assert.equal(init?.credentials, "omit")
      assert.equal(init?.redirect, "error")
      assert.deepEqual(init?.headers, { "Content-Type": "application/octet-stream" })
      assert.ok(init?.body instanceof Blob)
      assert.equal(init.body.size, part === 1 ? partSize : 7)
      return new Response(null, { status: 200, headers: { ETag: `"part-${part}"` } })
    }
    assert.equal(path, confirmPath)
    events.push("confirm")
    assert.equal(init?.credentials, "include")
    assert.deepEqual(JSON.parse(String(init?.body)), { upload_ticket: "multipart-ticket", parts: [
      { part_number: 1, etag: '"part-1"' }, { part_number: 2, etag: '"part-2"' },
    ] })
    return Response.json({ data: { key: ready.key, public_url: ready.publicUrl } })
  })
  t.after(restore)
  const issue: SupplierDbPresign = async (sourceId, request) => ({
    ok: true, value: (await supplierDbsHttp.supplierDbUploadPresign(sourceId, request)).upload,
  })
  assert.deepEqual(await supplierDbUploadFile(issue, "s1", { kind: "psd", file: body }), ready)
  assert.equal(events[0], "issue")
  assert.deepEqual(events.slice(1, 3).sort(), ["part-1", "part-2"])
  assert.equal(events[3], "confirm")
})
test("cancelling while a multipart grant is pending aborts only the returned upload without PUT or confirm", async (t) => {
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker")
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
  t.after(() => {
    if (worker) Object.defineProperty(globalThis, "Worker", worker)
    else Reflect.deleteProperty(globalThis, "Worker")
  })
  const partSize = 16 * 1024 * 1024
  const body = new File([new Uint8Array(partSize + 1)], "cancelled.psd")
  const controller = new AbortController()
  const attempts: SupplierUploadAttempts = new WeakMap()
  const events: string[] = []
  let grant!: (value: SupplierDbUploadTarget) => void
  const granted = new Promise<SupplierDbUploadTarget>((resolve) => { grant = resolve })
  let issued!: () => void
  const issuing = new Promise<void>((resolve) => { issued = resolve })
  const issue: SupplierDbPresign = async () => {
    events.push("issue")
    issued()
    return { ok: true, value: await granted }
  }
  const abortPath = route("adminSupplierDbsBySourceIdUploadsAbort", { source_id: "s1" })
  t.after(stubFetch(async (input, init) => {
    assert.equal(String(input), abortPath)
    assert.equal(init?.method, "POST")
    assert.equal(init?.credentials, "include")
    assert.deepEqual(JSON.parse(String(init?.body)), { upload_ticket: "own-late-grant" })
    events.push("abort")
    return Response.json({ data: {} })
  }))
  const uploading = supplierDbUploadFile(issue, "s1", { kind: "psd", file: body, signal: controller.signal }, {
    attempts, confirm: async () => { events.push("confirm"); return ready },
  })
  await issuing
  controller.abort()
  grant({ uploadTicket: "own-late-grant", multipart: {
    uploadId: "own-late-upload", partSize, ticket: "own-late-grant",
    parts: [partSize, 1].map((byteLength, index) => ({ partNumber: index + 1,
      url: `https://s3.invalid/cancelled-part-${index + 1}`, byteLength, expiresAtMs: Date.now() + 60_000 })),
  } })
  await assert.rejects(uploading, (reason) => isUploadAbort(reason))
  assert.deepEqual(events, ["issue", "abort"])
  assert.equal(attempts.has(body), false)
})
test("412 is confirmation-only readiness, never client success", async () => {
  const restore = stubFetch(async () => new Response(null, { status: 412 })); let confirmed = false
  try { await assert.rejects(supplierDbUploadFile(presign, "s1", { kind: "gallery", file: file() }, { confirm: async () => { confirmed = true; throw new Error("digest mismatch") } }), /digest mismatch/); assert.equal(confirmed, true) }
  finally { restore() }
})
test("uncertain PUT confirms instead of retransmitting and has no URL/XML/cause leak", async () => {
  let puts = 0
  const restore = stubFetch(async () => { puts++; throw new Error("https://s3.invalid/private?signature=secret <XML>") })
  try { const result = await supplierDbUploadFile(presign, "s1", { kind: "gallery", file: file() }, { confirm: async () => ready }); assert.deepEqual(result, ready); assert.equal(puts, 1) }
  finally { restore() }
})
test("retry confirms retained intent first, and unresolved confirmation cannot PUT again", async () => {
  const attempts: SupplierUploadAttempts = new WeakMap(); const body = file(); let puts = 0; let issued = 0; let confirmed = 0
  const issue: SupplierDbPresign = async () => { issued++; return { ok: true, value: target() } }
  const confirm: SupplierDbConfirm = async () => { confirmed++; throw new Error("confirmation unavailable") }
  const restore = stubFetch(async () => { puts++; return new Response(null, { status: 200 }) })
  try {
    await assert.rejects(supplierDbUploadFile(issue, "s1", { kind: "gallery", file: body }, { confirm, attempts }))
    await assert.rejects(supplierDbUploadFile(issue, "s1", { kind: "gallery", file: body }, { confirm, attempts }))
    assert.equal(puts, 1); assert.equal(issued, 1); assert.equal(confirmed, 2)
    assert.deepEqual(await supplierDbUploadFile(issue, "s1", { kind: "gallery", file: body }, { confirm: async () => ready, attempts }), ready)
    assert.equal(puts, 1)
  } finally { restore() }
})
test("only explicit missing permits retransmit; expired grant renews only after missing", async () => {
  const body = file(); const attempts: SupplierUploadAttempts = new WeakMap(); attempts.set(body, { sourceId: "s1", kind: "gallery", sha256: "", target: target(Date.now() - 1) })
  let confirms = 0; let issues = 0; let puts = 0
  const restore = stubFetch(async () => { puts++; return new Response(null, { status: 200 }) })
  try {
    await supplierDbUploadFile(async () => { issues++; return { ok: true, value: target() } }, "s1", { kind: "gallery", file: body },
      { attempts, confirm: async () => { if (++confirms === 1) throw missing(); return ready } })
    assert.equal(confirms, 2); assert.equal(issues, 1); assert.equal(puts, 1)
  } finally { restore() }
})
test("late confirmation cannot escape caller cancellation fence", async () => {
  const controller = new AbortController(); const attempts: SupplierUploadAttempts = new WeakMap(); const body = file()
  attempts.set(body, { sourceId: "s1", kind: "gallery", sha256: "", target: target() })
  await assert.rejects(supplierDbUploadFile(presign, "s1", { kind: "gallery", file: body, signal: controller.signal },
    { attempts, confirm: async () => { controller.abort(); return ready } }), (reason) => isUploadAbort(reason))
})

test("native Ozon video width preflight runs before hash/grant and remains cancellable", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis,"document"); let width=639; let issued=false
  const video: {duration:number;videoWidth:number;videoHeight:number;onloadedmetadata:(()=>void)|null;onerror:(()=>void)|null;preload:string;removeAttribute:()=>void;load:()=>void;src:string} = {
    duration:1, get videoWidth(){return width},videoHeight:360,onloadedmetadata:null,onerror:null,preload:"",removeAttribute(){},load(){},
    set src(_value:string){queueMicrotask(()=>video.onloadedmetadata?.())},get src(){return ""},
  }
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>video}})
  const issue: SupplierDbPresign = async () => { issued=true; return {ok:true,value:target()} }
  try {
    await assert.rejects(supplierDbUploadFile(issue,"s1",{kind:"video",file:new File(["video"],"a.mp4")}),/至少 640/)
    assert.equal(issued,false)
    width=640;const controller=new AbortController()
    const upload=supplierDbUploadFile(issue,"s1",{kind:"video",file:new File(["video"],"a.mp4"),signal:controller.signal})
    controller.abort();await assert.rejects(upload,{name:"AbortError"});assert.equal(issued,false)
  } finally {if(previous) Object.defineProperty(globalThis,"document",previous);else Reflect.deleteProperty(globalThis,"document")}
})
