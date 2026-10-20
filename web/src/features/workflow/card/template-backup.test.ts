import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { route } from "@/api/routes"
import { cardPayload } from "@/bindings/listing-projection"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { putTemplate, getTemplate } from "@/render/opfs"
import { stubOpfs, restoreOpfsTestGlobals } from "@/render/opfs-test-support"
import { resetListingWorkbench } from "../workbench/listing-workbench-store"
import { backupUserTemplate, persistUserTemplate } from "./template-assets"
import { toast } from "@/components/ui/toast"
import { listingCardSavePsd, listingCardSaveDefaultPrice } from "./card-writes"
import { primeCardSession, resetCardSessions, type CardPayloadView } from "./card-session"

afterEach(async () => { resetCardSessions(); await restoreOpfsTestGlobals() })

async function fixture() {
  const fs = stubOpfs()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const digest = await putTemplate(bytes)
  const template = { id: "backup", sha256: digest, file_name: "x.psd", bytes: bytes.length,
    description_category_id: 10, type_id: 20, ready: false,
    upload: { url: `https://s3.example.invalid/templates/${digest}.psd?X-Amz-Signature=capability`,
      headers: { content_type: "application/octet-stream", if_none_match: "*" }, expires_at_ms: Date.now() + 600_000 } }
  return { bytes, digest, template, fs }
}

test("a 502 upload retries three times then succeeds, without losing local bytes", { timeout: 15_000 }, async () => {
  const { bytes, digest, template } = await fixture()
  const original = globalThis.fetch
  let uploads = 0
  let registrations = 0
  let confirmations = 0
  globalThis.fetch = async (input, init) => {
    if (String(input) === route("listingTemplates")) {
      registrations++
      return Response.json({ data: template })
    }
    if (init?.method === "PUT") {
      uploads++
      return new Response(null, { status: uploads < 4 ? 502 : 204 })
    }
    if (String(input).endsWith("/confirm")) {
      confirmations++
      if (uploads < 4) return Response.json({ code: "template_object_missing", error: "missing" }, { status: 404 })
      return Response.json({ data: { ...template, ready: true } })
    }
    return Response.json({ data: { accepted: [], rejected: [] } })
  }
  try {
    await persistUserTemplate(digest, "x.psd", 10, 20)
    assert.equal(uploads, 4, "initial upload plus exactly three retries")
    assert.equal(registrations, 4, "refresh expired capabilities / discover accepted writes")
    assert.equal(confirmations, 4, "probe each ambiguous PUT before retransmitting")
    assert.deepEqual(await getTemplate(digest), bytes)
  } finally { globalThis.fetch = original }
})

test("persistent 502 stops after three retries and releases the backup queue", { timeout: 15_000 }, async () => {
  const { bytes, digest, template } = await fixture()
  const original = globalThis.fetch
  let uploads = 0
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PUT") { uploads++; return new Response(null, { status: 502 }) }
    if (String(_input).endsWith("/confirm")) return Response.json({ code: "template_object_missing", error: "missing" }, { status: 404 })
    return Response.json({ data: template })
  }
  try {
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { status: 502 })
    assert.equal(uploads, 4)
    assert.deepEqual(await getTemplate(digest), bytes)
    globalThis.fetch = async () => Response.json({ data: { ...template, ready: true } })
    await persistUserTemplate(digest, "x.psd", 10, 20)
    assert.equal(uploads, 4, "a completed backup needs no new PUT")
  } finally { globalThis.fetch = original }
})

test("validation refusal and long Retry-After do not retry", async () => {
  const { digest } = await fixture()
  const original = globalThis.fetch
  try {
    for (const status of [400, 409, 429]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return new Response(null, { status, headers: { "retry-after": "60" } }) }
      await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { status })
      assert.equal(calls, 1)
    }
  } finally { globalThis.fetch = original }
})

test("local binding and normal edits complete while backup PUT is held", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let stored = { id: "local-first", revision: 1, title: "local", store_id: null, updated_at_ms: 1,
    payload: { categoryKey: "local", descriptionCategoryId: 10, typeId: 20 } } as CardPayloadView
  primeCardSession(stored)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let patches = 0
  let uploads = 0
  let confirmations = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body))
      assert.equal(body.baseRevision, stored.revision)
      stored = { ...stored, payload: body.payload, revision: stored.revision + 1 }
      patches++
      return Response.json({ data: stored })
    }
    if (String(input) === route("listingTemplates")) return Response.json({ data: template })
    if (init?.method === "PUT") { uploads++; await held; return new Response(null, { status: 204 }) }
    if (String(input).endsWith("/confirm")) {
      confirmations++
      return Response.json({ data: { ...template, ready: true } })
    }
    return Response.json({ data: { accepted: [], rejected: [] } })
  }
  let backup = Promise.resolve()
  try {
    const saved = await listingCardSavePsd(stored.id, digest, "x.psd")
    backup = persistUserTemplate(digest, "x.psd", 10, 20)
    assert.equal(saved.psd_template_file_name, "x.psd")
    assert.equal(cardPayload(stored).psdTemplateSha256, digest)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(uploads, 1, "concurrent backup requests coalesce")
    assert.equal(confirmations, 0, "binding did not wait for cloud confirmation")
    await listingCardSaveDefaultPrice(stored.id, 72)
    assert.equal(patches, 2, "ordinary edits do not enter the backup queue")
    assert.equal(cardPayload(stored).psdTemplateSha256, digest)
    resetListingWorkbench()
    release()
    await backup
    assert.equal(confirmations, 1, "opening another plan must not cancel its backup")
  } finally { release(); await backup; globalThis.fetch = original }
})

test("workspace switch stops old confirmation and queued backups", async () => {
  const { digest, template } = await fixture()
  const second = await putTemplate(new Uint8Array([5, 6, 7]))
  const original = globalThis.fetch
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const active = new Promise<void>((resolve) => { started = resolve })
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    if (init?.method === "PUT") { started(); await held; return new Response(null, { status: 204 }) }
    return Response.json({ data: template })
  }
  const first = persistUserTemplate(digest, "x.psd", 10, 20)
  const queued = persistUserTemplate(second, "y.psd", 10, 20)
  const settled = Promise.allSettled([first, queued])
  try {
    await active
    invalidateAllSessionCaches()
    release()
    for (const result of await settled) {
      assert.equal(result.status, "rejected")
      if (result.status === "rejected") assert.equal(result.reason.code, "workflow_scope_changed")
    }
    assert.equal(calls, 2, "no follow-up request may use the new Workspace identity")
  } finally { release(); await settled; globalThis.fetch = original }
})

test("a late binding reply cannot back up old PSD bytes into a new Workspace", async () => {
  const { digest } = await fixture()
  const original = globalThis.fetch
  const stored = { id: "late-binding", revision: 1, title: "old workspace", store_id: null, updated_at_ms: 1,
    payload: { categoryKey: "local", descriptionCategoryId: 10, typeId: 20 } } as CardPayloadView
  primeCardSession(stored)
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const active = new Promise<void>((resolve) => { started = resolve })
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    assert.equal(init?.method, "PATCH", "no backup may start using the new identity")
    const body = JSON.parse(String(init.body))
    started()
    await held
    return Response.json({ data: { ...stored, revision: 2, payload: body.payload } })
  }
  const binding = listingCardSavePsd(stored.id, digest, "x.psd")
  try {
    await active
    invalidateAllSessionCaches()
    release()
    await binding
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
  } finally { release(); await binding; globalThis.fetch = original }
})


test("identity change aborts the active upload and lets the new backup run", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "PUT") return Response.json({ data: template })
    assert.ok(init.signal)
    started()
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled upload")) }, { once: true })
    })
  }
  const first = persistUserTemplate(digest, "x.psd", 10, 20)
  const firstResult = Promise.allSettled([first])
  try {
    await active
    invalidateAllSessionCaches()
    const [result] = await firstResult
    assert.equal(result!.status, "rejected")
    assert.equal(aborted, true)
    globalThis.fetch = async () => Response.json({ data: { ...template, ready: true } })
    await persistUserTemplate(digest, "x.psd", 10, 20)
  } finally { invalidateAllSessionCaches(); await firstResult; globalThis.fetch = original }
})

test("a missing local file reports one actionable notice, not local usability", async () => {
  const { digest, template, fs } = await fixture()
  fs.written.clear()
  const original = toast.add
  const originalFetch = globalThis.fetch
  const notices: Array<{ description?: ReactNode }> = []
  let calls = 0
  toast.add = ((notice) => { notices.push(notice); return "missing-psd" }) as typeof toast.add
  globalThis.fetch = async () => { calls++; throw new Error("missing bytes must not use the network") }
  try {
    const payload = cardPayload({ id: "missing", revision: 1, title: "missing", store_id: null, updated_at_ms: 1,
      payload: { ...template, psdTemplateSha256: digest, psdTemplateFileName: "x.psd" } })
    backupUserTemplate(payload)
    backupUserTemplate(payload)
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "workflow_template_missing" })
    assert.equal(notices.length, 1)
    assert.match(renderToStaticMarkup(createElement("div", null, notices[0]!.description)), /重新选择原文件/)
    assert.doesNotMatch(renderToStaticMarkup(createElement("div", null, notices[0]!.description)), /仍可正常上架/)
    assert.equal(calls, 0)
  } finally { toast.add = original; globalThis.fetch = originalFetch }
})

test("response loss probes first and retries only confirmation when storage is unavailable", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  const calls: string[] = []
  let confirms = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { calls.push("put"); throw new TypeError(template.upload.url) }
    if (String(input).endsWith("/confirm")) {
      calls.push("confirm"); confirms++
      if (confirms === 1) return new Response(null, { status: 502 })
      return Response.json({ data: { ...template, ready: true } })
    }
    calls.push("register"); return Response.json({ data: template })
  }
  try {
    await persistUserTemplate(digest, "x.psd", 10, 20)
    assert.deepEqual(calls, ["register", "put", "confirm", "confirm"])
  } finally { globalThis.fetch = original }
})

test("conditional conflict is never accepted without authoritative confirmation", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { calls.push("put"); return new Response(null, { status: 409 }) }
    if (String(input).endsWith("/confirm")) { calls.push("confirm"); return Response.json({ data: { ...template, ready: true } }) }
    calls.push("register"); return Response.json({ data: template })
  }
  try { await persistUserTemplate(digest, "x.psd", 10, 20); assert.deepEqual(calls, ["register", "put", "confirm"]) }
  finally { globalThis.fetch = original }
})

test("opaque expiry confirms missing then refreshes and conditionally retransmits", async () => {
  const { digest, template, bytes } = await fixture()
  const original = globalThis.fetch
  const calls: string[] = []
  let puts = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") {
      calls.push("put"); puts++
      assert.deepEqual(new Uint8Array(init.body as Uint8Array), bytes)
      if (puts === 1) throw new TypeError("opaque CORS ExpiredRequest")
      return new Response(null, { status: 204 })
    }
    if (String(input).endsWith("/confirm")) {
      calls.push("confirm")
      if (puts === 1) return Response.json({ code: "template_object_missing", error: "missing" }, { status: 404 })
      return Response.json({ data: { ...template, ready: true } })
    }
    calls.push("register"); return Response.json({ data: template })
  }
  try { await persistUserTemplate(digest, "x.psd", 10, 20); assert.deepEqual(calls, ["register", "put", "confirm", "register", "put", "confirm"]) }
  finally { globalThis.fetch = original }
})

test("nearly expired capability re-signs once before any body leaves the browser", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let registrations = 0, puts = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { puts++; return new Response(null, { status: 204 }) }
    if (String(input).endsWith("/confirm")) return Response.json({ data: { ...template, ready: true } })
    registrations++
    return Response.json({ data: registrations === 1
      ? { ...template, upload: { ...template.upload, expires_at_ms: Date.now() + 1000 } } : template })
  }
  try { await persistUserTemplate(digest, "x.psd", 10, 20); assert.equal(registrations, 2); assert.equal(puts, 1) }
  finally { globalThis.fetch = original }
})

test("existing corrupt object fails closed without overwrite or claiming backup ready", async () => {
  const { digest, template, bytes } = await fixture()
  const original = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { puts++; return new Response(null, { status: 412 }) }
    if (String(input).endsWith("/confirm")) return Response.json({ code: "conflict", error: "digest mismatch" }, { status: 409 })
    return Response.json({ data: template })
  }
  try {
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "cloud_conflict" })
    assert.equal(puts, 1); assert.deepEqual(await getTemplate(digest), bytes)
  } finally { globalThis.fetch = original }
})

test("a missing database record does not masquerade as a missing S3 object", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") { puts++; return new Response(null, { status: 204 }) }
    if (String(input).endsWith("/confirm")) return Response.json({ code: "not_found", error: "record missing" }, { status: 404 })
    return Response.json({ data: template })
  }
  try { await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "cloud_not_found" }); assert.equal(puts, 1) }
  finally { globalThis.fetch = original }
})


test("obsolete scope cannot coalesce into a new scope backup with the same digest", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let release!: (response: Response) => void
  const response = new Promise<Response>((resolve) => { release = resolve })
  globalThis.fetch = async () => response
  const live = persistUserTemplate(digest, "x.psd", 10, 20)
  try {
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20, () => false), { code: "workflow_scope_changed" })
  } finally {
    release(Response.json({ data: { ...template, ready: true } })); await live
    globalThis.fetch = original
  }
})

test("truthy non-boolean ready values cannot falsely complete the backup", async () => {
  const { digest, template } = await fixture()
  const original = globalThis.fetch
  let puts = 0
  try {
    globalThis.fetch = async () => Response.json({ data: { ...template, ready: "true" } })
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "workflow_template_unconfirmed" })
    globalThis.fetch = async (input, init) => {
      if (init?.method === "PUT") { puts++; return new Response(null, { status: 204 }) }
      return Response.json({ data: String(input).endsWith("/confirm") ? { ...template, ready: "true" } : template })
    }
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "workflow_template_unconfirmed" })
    assert.equal(puts, 1)
  } finally { globalThis.fetch = original }
})
