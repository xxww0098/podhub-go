import assert from "node:assert/strict"
import test from "node:test"
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
