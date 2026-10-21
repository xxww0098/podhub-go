/** Logical business ledger is separate from the context guard's network ledger. */
import type { CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import type { DraftSubmitRequest, DraftSubmitResult } from "@/bindings/http-listing-submit"
import { route } from "@/api/routes"
import { sha256 } from "@/features/workflow/platforms/core"
import { wbCatalogFixture, wbFixtureState } from "./publish-pipeline-fixtures"
import { recordBusiness, recordNative } from "./publish-pipeline-metrics"
import type { IntentPage, ListingIntent } from "@/bindings/http-listing-intents"
import { createDiagnosticMocks } from "./publish-pipeline-diagnostic-mocks"
import { createWorkbenchMocks } from "./publish-pipeline-workbench-mocks"
export type FixtureMode = "accepted" | "unknown" | "schema" | "media" | "stop" | "late" | "diagnostic" | "request-400" | "request-409"
  | "admission-store-unavailable" | "admission-capacity-full" | "admission-offer-busy" | "admission-busy-exhausted" | "reconcile-pending-200" | "reconcile-lost-history"
export function installPipelineMocks(initialSchema: CategorySchemaSnapshot) {
  const diagnostics = createDiagnosticMocks(), workbench = createWorkbenchMocks()
  let mode: FixtureMode = "accepted", nextId = 0, firstHeld = false
  const attempts = new Map<string, number>()
  const intents = new Map<string, ListingIntent>()
  const releases = new Set<() => void>()
  const original = globalThis.fetch.bind(globalThis)
  // The compiled artifact lives above the Vite root, so its dev URL is an /@fs path.
  // Compare the artifact suffix so the pass-through holds for any served spelling.
  const wasmSuffix = "/wasm/dist/browser/listing-state.wasm"
  const isWasmRead = (pathname: string) => {
    try { return decodeURIComponent(pathname).endsWith(wasmSuffix) } catch { return false }
  }
  const hold = (signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    const finish = () => { releases.delete(done); signal?.removeEventListener("abort", aborted) }
    const done = () => { finish(); resolve() }
    const aborted = () => { finish(); reject(new DOMException("Mock request deadline or preparation stop", "AbortError")) }
    releases.add(done)
    if (signal?.aborted) aborted()
    else signal?.addEventListener("abort", aborted, { once: true })
  })
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (url.origin === location.origin && method === "GET" && isWasmRead(url.pathname)) return original(input, init)
    const request = ++nextId, path = url.pathname
    const boundary = { request, method, path, requestBytes: typeof init?.body === "string" ? new TextEncoder().encode(init.body).byteLength : undefined }
    const inbox = await diagnostics.handle(url, method, init, boundary)
    if (inbox) return inbox
    const legacy = await workbench.handle(url, method, init, boundary)
    if (legacy) return legacy
    const same = url.origin === location.origin
    const operation = !same ? "unexpected"
      : method === "GET" && path === route("catalogWbSubjectsBySubjectId", { subject_id: 105 }) ? "wb-catalog"
        : method === "GET" && path === "/api/catalog/schemas/fixture" ? "schema"
          : method === "POST" && path === route("listingSubmit") ? "submit"
            : method === "GET" && path === route("listingIntents") ? "intents"
              : method === "POST" && path === "/api/media/fixture-reupload" ? "media" : "unexpected"
    const category = operation === "submit" || operation === "intents" ? "E"
      : operation === "schema" || operation === "wb-catalog" ? "C"
        : operation === "media" ? "fixture-media" : "unexpected"
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const base = { request, method, path, category, operation, requestBytes: typeof init?.body === "string" ? new TextEncoder().encode(init.body).byteLength : undefined } as const
    let body: DraftSubmitRequest | undefined
    try { if (operation === "submit") {
      body = JSON.parse(String(init?.body)) as typeof body
      if (!body || body.card_id !== "fixture-card" || !["fixture-a", "fixture-b"].includes(body.store_id)
        || Object.keys(body).sort().join() !== "card_id,items,store_id" || !Array.isArray(body.items)
        || body.items.length === 0 || body.items.length > 100 || new Set(body.items.map((item) => item.rowId)).size !== body.items.length
        || boundary.requestBytes! > 7.5 * 1024 * 1024 || url.search) throw new Error("Unexpected fixture submit boundary")
    } }
    catch (error) {
      recordBusiness({ ...base, event: "dispatch", signalAborted: signal?.aborted ?? false })
      recordBusiness({ ...base, event: "rejection", signalAborted: signal?.aborted ?? false })
      throw error
    }
    const attempt = body ? (attempts.get(body.store_id) ?? 0) + 1 : undefined
    if (body) attempts.set(body.store_id, attempt!)
    const identity = body ? { destination: body.store_id, rowIds: body.items.map((item) => item.rowId), attempt }
      : operation === "intents" ? { destination: url.searchParams.get("storeId") ?? undefined } : {}
    recordBusiness({ ...base, ...identity, event: "dispatch", signalAborted: signal?.aborted ?? false })
    if (mode === "admission-busy-exhausted" && operation === "submit") recordNative("busy-admission-dispatch", { request, destination: body!.store_id, at: Date.now() })
    const abort = () => recordBusiness({ ...base, ...identity, event: "abort", signalAborted: true })
    signal?.addEventListener("abort", abort, { once: true })
    try {
      let response: Response
      if (category === "unexpected") throw new Error("Unregistered fixture business request")
      if (operation === "wb-catalog" && url.searchParams.toString() !== "language=ru") throw new Error("Unexpected WB coordinate query")
      if ((operation === "schema" || operation === "media") && url.search) throw new Error("Unexpected fixture repair query")
      if (operation === "intents") {
        const key = url.searchParams.has("rowIds") ? "rowIds" : "intentIds"
        const selected = url.searchParams.get(key)?.split(",") ?? []
        if (!["fixture-a", "fixture-b"].includes(url.searchParams.get("storeId") ?? "") || url.searchParams.get("limit") !== "100"
          || url.searchParams.get("latestPerRow") !== "true" || [...url.searchParams.keys()].sort().join() !== ["latestPerRow", "limit", key, "storeId"].sort().join()
          || selected.length === 0 || selected.length > 100 || selected.some((id) => !/^[A-Za-z0-9_.-]{1,128}$/.test(id))) throw new Error("Unexpected S16 Intent inspection")
        recordNative("mock-intent-query", { storeId: url.searchParams.get("storeId"), [key]: selected, limit: 100, latestPerRow: true })
        const items = [...intents.values()].filter((intent) => intent.store_id === url.searchParams.get("storeId") && selected.includes(key === "rowIds" ? intent.listing_row_id : intent.id))
          .map((intent) => mode === "reconcile-pending-200" ? { ...intent, state: "accepted", external_task_id: "42" } : intent)
        response = Response.json({ data: { items, next_cursor: null } satisfies IntentPage })
        recordBusiness({ ...base, ...identity, event: "response", status: 200, signalAborted: signal?.aborted ?? false })
        return response
      }
      if (operation === "submit") {
        const hashes = await Promise.all(body!.items.map((item) => sha256(JSON.stringify(item))))
        if (mode === "unknown" && body!.store_id === "fixture-a" && attempt === 2 || mode === "diagnostic") await diagnostics.observeLoss(String(init?.body))
        if (mode === "stop" || mode === "late" || mode === "diagnostic" || (firstHeld && attempt === 1)) { recordBusiness({ ...base, ...identity, event: "held" }); await hold(signal) }
        else if (!mode.startsWith("admission-")) await new Promise((resolve) => setTimeout(resolve, 500))
        if (mode === "diagnostic" || (mode === "unknown" && body!.store_id === "fixture-a" && attempt === 2)) throw new TypeError("Fixture response lost")
        if (mode === "request-400" || mode === "request-409") {
          const status = mode === "request-400" ? 400 : 409
          recordBusiness({ ...base, ...identity, event: "response", status })
          return Response.json({ error: "External fixture refusal body must stay out of the DOM", code: status === 400 ? "validation" : "conflict" },
            { status, headers: { "x-request-id": `fixture-request-${status}` } })
        }
        if (mode.startsWith("admission-") && body!.store_id === "fixture-a") {
          const code = { "admission-store-unavailable": "store_unavailable", "admission-capacity-full": "submit_capacity_full",
            "admission-offer-busy": "offer_busy", "admission-busy-exhausted": "store_busy" }[mode as "admission-store-unavailable" | "admission-capacity-full" | "admission-offer-busy" | "admission-busy-exhausted"]
          recordBusiness({ ...base, ...identity, event: "response", status: 409 })
          return Response.json({ code, error: "Mock typed request-level refusal" }, { status: 409 })
        }
        const repair = (mode === "schema" || mode === "media") && body!.store_id === "fixture-a" && attempt === 1
        const items: DraftSubmitResult["items"] = body!.items.map((item) => {
          if (repair) return { row_id: item.rowId, outcome: "skipped", skip_reason: mode === "schema" ? "schema_stale" : "media_expired" }
          const intent: ListingIntent = { id: crypto.randomUUID(), listing_row_id: item.rowId, row_revision: 0, store_id: body!.store_id,
            client_operation_id: `fixture-server:${item.rowId}`, state: "accepted", external_task_id: "42", can_resume: false,
            current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: Date.now() }
          return { row_id: item.rowId, outcome: "created", intent }
        })
        if (mode === "reconcile-pending-200" || mode === "reconcile-lost-history") {
          for (const item of items) if ("intent" in item && item.intent) {
            item.intent.id = `fixture-intent-${item.row_id}`
            if (mode === "reconcile-pending-200" && body!.store_id === "fixture-a") { item.intent.state = "queued"; item.intent.external_task_id = "" }
            intents.set(item.intent.id, { ...item.intent })
          }
          if (mode === "reconcile-lost-history" && body!.store_id === "fixture-a") throw new TypeError("Mock committed response lost")
        }
        response = Response.json({ data: { server_schema_revision: initialSchema.schema_revision, items } satisfies DraftSubmitResult })
        recordBusiness({ ...base, ...identity, event: "response", status: 200, signalAborted: signal?.aborted ?? false,
          draftHashes: hashes, schemaRevisions: body!.items.map((item) => item.schemaRevision), renewedMedia: body!.items.every((item) => JSON.stringify(item.media ?? null).includes("renewed.jpg")) })
        return response
      }
      if (operation === "wb-catalog") response = Response.json(wbFixtureState.empty ? { ...wbCatalogFixture, catalog: null, defaults: null, usable: false } : wbCatalogFixture)
      else if (path === "/api/catalog/schemas/fixture") { recordBusiness({ ...base, event: "held" }); await hold(signal); response = Response.json({ data: { ...initialSchema, schema_revision: "fixture-refreshed" } }) }
      else if (category === "fixture-media") {
        recordBusiness({ ...base, event: "held" }); await hold(signal)
        if (signal?.aborted) throw new DOMException("Stopped", "AbortError")
        const selected = JSON.parse(String(init?.body)) as Array<{ id: string; rev: number; images: LeanRow["media"]["images"] }>
        response = Response.json({ data: selected.map((row) => ({ rowId: row.id, revision: row.rev, state: "confirmed", images: row.images.map((image) => ({
          ...image, phase: "public_ready", public_url: "https://media.example.invalid/renewed.jpg", object_key: "fixture/renewed.jpg", account_id: "fixture-account",
        })) })) })
      } else response = Response.json({ data: { items: [], next_cursor: null } satisfies IntentPage })
      recordBusiness({ ...base, ...identity, event: "response", status: response.status, signalAborted: signal?.aborted ?? false })
      return response
    } catch (error) { recordBusiness({ ...base, ...identity, event: "rejection", signalAborted: signal?.aborted ?? false }); throw error }
    finally { signal?.removeEventListener("abort", abort) }
  }
  return { diagnostics, workbench, holdFirst(value: boolean) { firstHeld = value }, select(value: FixtureMode) { mode = value }, release() { for (const release of [...releases]) release() } }
}
