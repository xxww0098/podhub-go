/**
 * Real native inputs for the send rail's tests: the compiled
 * `listing-core-wasm` (rebuild with `scripts/build-wasm.sh core --copy`)
 * and the frozen-ABI golden row / card / schema its native tests pin
 * (`rust/crates/listing-core-wasm/tests/fixtures/ambient`). Nothing here is a
 * hand-made Seller body; the core freezes, Cloud is stubbed at `fetch`.
 */
import { readFileSync } from "node:fs"

import { primeCardSession, resetCardSessions } from "../card/card-session"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import type { ListingRowView } from "@/bindings/listing-projection"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import type { CardPayload, CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import { createListingCore, type ListingCore } from "@/listing-core/wasm"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { resetListingWorkbench } from "../workbench/listing-workbench-store"
import type { SendCore } from "./send-native"

const root = new URL("../../../../../", import.meta.url)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), "utf8")) as T

type Golden = { rowId: string, row: LeanRow, card: CardPayload }
export const golden = readJson<Golden>("rust/crates/listing-core-wasm/tests/fixtures/ambient/ozon-freeze-golden.json")
export const goldenSchema = readJson<CategorySchemaSnapshot>("rust/crates/listing-core-wasm/tests/fixtures/ambient/decorative-wall-art-schema.json")
export const CATEGORY = golden.card.descriptionCategoryId
export const TYPE = golden.card.typeId
export const CARD = "card-1"

export async function wasmCore(): Promise<ListingCore> {
  let memory: WebAssembly.Memory | undefined
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL("wasm/dist/browser/listing-state.wasm", root)), {
    env: { fill_random: (ptr: number, len: number) => crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr, len)) },
  })
  memory = instance.exports.memory as WebAssembly.Memory
  return createListingCore(instance.exports)
}

/** Counts schema loads so tests can see a resident handle being reused. */
export function countingCore(core: ListingCore): SendCore & { loads: number } {
  const counted = {
    loads: 0,
    loadSchema: (input: Parameters<ListingCore["loadSchema"]>[0]) => { counted.loads += 1; return core.loadSchema(input) },
    freezeListing: (handle: number, input: Parameters<ListingCore["freezeListing"]>[1]) => core.freezeListing(handle, input),
  }
  return counted
}

/** The golden row under `id`, with its own offer so a batch never collides. */
export function nativeRowView(id: string, options: { revision?: number, viewRevision?: number, storeId?: string, typeId?: number, cardId?: string, payload?: Partial<LeanRow>, stage?: string } = {}): ListingRowView {
  const payload: LeanRow = structuredClone(golden.row)
  payload.draft.values.offer_id = { kind: "text", value: id }
  if (options.typeId) payload.typeId = options.typeId
  Object.assign(payload, options.payload)
  return {
    id, card_id: options.cardId ?? CARD, store_id: options.storeId ?? "store-1",
    revision: options.revision ?? 9, view_revision: options.viewRevision ?? 1,
    content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: "none",
    projection: listingProjection(options.stage ? { stage: options.stage as never } : {}),
    draft: payload.draft, validation_issues: [], media: payload.media, ai: payload.ai, source: payload.source,
    payload: payload as never, updated_at_ms: 0, build: { state: "built", sources: [] },
  } as ListingRowView
}

export function residentRows(rows: readonly ListingRowView[]): void {
  rememberListingRows(rows, rowCacheScope())
}

export function openCard(id = CARD, typeId = TYPE, storeIds = "store-1"): void {
  primeCardSession({ id, title: "golden", revision: 1, store_id: storeIds.split(",")[0] || null, payload: { ...golden.card, typeId, targetStoreId: storeIds }, updated_at_ms: 0 } as never)
}

export function schemaData(typeId = TYPE, withMaterial = true) {
  return {
    description_category_id: CATEGORY, type_id: typeId, language: "default", fetched_at_ms: 1, fields: [],
    ...(withMaterial ? { nativeMaterial: { snapshot: { ...goldenSchema, type_id: typeId }, searchMaterials: [] } } : {}),
  }
}

export type SendCall = { url: string, method: string, body: any }

/** `answer` plays Cloud; a plain value is enveloped as `{data}`. */
export function serve(answer: (call: SendCall) => unknown | Promise<unknown>): { calls: SendCall[], restore: () => void } {
  const previous = globalThis.fetch
  const previousLog = console.log
  console.log = () => {}
  const calls: SendCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }
    calls.push(call)
    const data = await answer(call)
    if (data instanceof Response) return data
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = previous; console.log = previousLog } }
}

export function refusal(status: number, code: string, error = "refused"): Response {
  return new Response(JSON.stringify({ code, error }), { status, headers: { "Content-Type": "application/json" } })
}

export function accepted(body: { row_ids: string[]; store_id?: string }) {
  return { items: body.row_ids.map((rowId) => ({ row_id: rowId, created: true, blockers: [], intent: { id: `intent-${rowId}`, state: "accepted", external_task_id: "42", store_id: body.store_id ?? "store-1", listing_row_id: rowId, row_revision: 9, client_operation_id: `server-${rowId}`, can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 } })) }
}

export function resetSendState(): void {
  invalidateAllSessionCaches()
  resetCardSessions()
  resetListingWorkbench()
}

/** The golden row as a Cloud row's `payload`, owning offer `id`. */
export function nativePayload(id: string): LeanRow {
  const payload: LeanRow = structuredClone(golden.row)
  payload.draft.values.offer_id = { kind: "text", value: id }
  return payload
}

/** A stored Card payload: the golden native card plus the test's own annotations. */
export function nativeCardPayload<T extends object = object>(extra: T = {} as T): Omit<CardPayload, keyof T> & T {
  return { ...golden.card, targetStoreId: "store", ...extra }
}

/**
 * For hook-level tests that go through the production send entry: loads the
 * tab's real `listing-core-wasm` from local bytes (no `file:` fetch) and makes the golden
 * coordinate's native material resident, so the test's own fetch stub only
 * has to play the listing routes.
 */
export async function warmProductionSend(): Promise<void> {
  const { defaultSendCore } = await import("./send-native")
  const { readCategorySchema } = await import("@/bindings/listing-material-cache")
  await defaultSendCore(readFileSync(new URL("wasm/dist/browser/listing-state.wasm", root))).loadSchema({ snapshot: goldenSchema })
  const warm = serve(() => schemaData())
  try {
    await readCategorySchema({ descriptionCategoryId: CATEGORY, typeId: TYPE, language: "default" })
  } finally { warm.restore() }
}

/** Final queue fixture: real CardRows/RowRepo, transport supplied by each behavior check. */
export async function finalQueueHarness(count = 1, destination = "s1", scope = { workspaceUuid: "ws-1", cardId: "card-1" }) {
  const { openCardRows } = await import("../rows/card-rows")
  const { memoryRowRepo } = await import("../rows/row-repo")
  const { sampleLocalRow } = await import("../rows/row-repo.contract")
  const repo = memoryRowRepo()
  await repo.putRows(Array.from({ length: count }, (_, i) => sampleLocalRow({ id: `r${i}`, ...scope, storeId: destination, position: i })))
  const rows = await openCardRows(repo, scope, async () => ({ writable: true, onChange: () => () => {}, release() {} }))
  return { repo, rows, scope }
}

export const prepareQueueRows: import("./queue/types").SendCapability["prepare"] = async (rows) => ({
  items: rows.map((row) => ({ rowId: row.id, revision: row.rev, offerId: row.id, digest: `digest-${row.id}`, previewOperationId: `preview-${row.id}`, body: { rowId: row.id } })),
  blocked: [],
})
export function queueAccepted(items: readonly import("./queue/types").PreparedRow[]): ReadonlyMap<string, import("./queue/types").SendFact> {
  return new Map(items.map((item) => [item.rowId, { state: "accepted", intentId: `i-${item.rowId}`, serverOperationId: `server-${item.rowId}`, taskId: 42 }]))
}

/** Test-only adapter module: real preview contract enters the production S16 capability port. */
export function testAdapterCapability(
  adapter: import("../platforms/core").PlatformAdapter<readonly import("../rows/types").LocalRow[], { value: string }>,
  send: import("./queue/types").SendCapability["send"],
): import("./queue/types").SendCapability {
  return {
    async prepare(rows) {
      const built = await adapter.build(rows)
      return {
        items: built.frozen.map((item) => ({ rowId: item.key, revision: rows.find((row) => row.id === item.key)?.rev ?? -1,
          offerId: item.body.value, digest: item.digest, previewOperationId: item.clientOperationId, body: item.body })),
        blocked: built.blocked.map((item) => ({ rowId: item.key, issues: item.issues })),
      }
    },
    bytes: (_destination, items) => new TextEncoder().encode(JSON.stringify(items)).length,
    send,
  }
}

/** A third platform module; adding its single registration requires no runner changes. */
export function thirdPlatformCapability(): import("./queue/types").SendCapability {
  return testAdapterCapability({ platform: "demo", label: "DEMO", async build(rows) {
    return { frozen: rows.map((row) => ({ key: row.id, body: { value: row.id }, digest: `sha256:${row.id}`, clientOperationId: `demo:${row.id}`, provenance: [] })), blocked: [] }
  } }, async (_destination, items) => queueAccepted(items))
}
