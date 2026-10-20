/**
 * The only file that touches `listing-core-wasm`'s raw exports (slice 03
 * "单一所有者": "WASM ABI | `rust/crates/listing-core-wasm` ↔ `web/src/listing-core/`
 * | 其它文件直接碰 WASM exports" is the thing this module exists to prevent).
 *
 * `rust/crates/listing-core-wasm/src/lib.rs` is the contract; this file is its one
 * TypeScript-side reader. `createListingCore` is synchronous — it wraps an
 * already-instantiated module's exports and never fetches or instantiates
 * anything itself (that is `client.ts`'s job, since it also owns wiring the
 * `env.fill_random` import, which needs the instance's own memory).
 *
 * ABI shape (`rust/crates/listing-core-wasm/src/lib.rs`'s own doc comment):
 *
 * ```text
 * alloc(len) -> ptr            free(ptr, len)
 * schema_load(ptr, len) -> h   // 0 on failure; schema stays resident in WASM
 * schema_drop(h)
 * call(op, h, ptr, len) -> r   // 0 success, non-zero failure
 * result_ptr() / result_len() / drop_result()   // singleton — one call in flight
 * last_error_ptr() / last_error_len()
 * ```
 *
 * `result_ptr`/`result_len`/`drop_result` take no handle, unlike
 * `render-wasm`'s per-template result table: `call()` is strictly
 * request/response, so one pending result is all there ever is.
 */

import { assertWbJson, type WbMaterial, type WbProductConfig, type WbPreview, type WbIssue, type WbSchemaHandle } from "./wb-types"
import type {
  KnownIssueKey,
  ProjectSubmitDraftInput,
  SubmitDraft,
  DecideCandidatesInput,
  EditedOutput,
  EditRowInput,
  EditRowOutput,
  FreezeListingInput,
  FreezeListingOutput,
  ListingCoreErrorCode,
  RecordRenderInput,
  RecordRenderOutput,
  RevalidateInput,
  SchemaLoadInput,
  SeedRowInput,
  SeedRowOutput,
  SettleRecognitionInput,
  ParsedOcrAnswer,
  OcrRetryClass,
  StageRequest,
  SubmitDraftInput,
  SubmitDraftOutput,
  ValidateVariantGroupInput,
  ValuesEqualInput,
  VariantProblem,
} from "./types"

/** A `call()`/`schema_load()` failure — `{code, message}` from `error.rs`, or
 * `wasm.ts`'s own `CORE_OOM`. `code` stays a plain `string` on the instance
 * (the wasm-decoded path parses untrusted JSON and must not hard-fail on an
 * unrecognized code), but every call site in this file passes a
 * `ListingCoreErrorCode`. */
export class ListingCoreError extends Error {
  readonly code: string
  readonly reasonCode?: string
  readonly retryClass?: OcrRetryClass

  constructor(code: ListingCoreErrorCode | string, message: string, reasonCode?: string, retryClass?: OcrRetryClass) {
    super(message)
    this.name = "ListingCoreError"
    this.code = code
    this.reasonCode = reasonCode
    this.retryClass = retryClass
  }
}

const OP = {
  seedRow: 1,
  editRow: 2,
  settleRecognition: 3,
  decideCandidates: 4,
  recordRender: 5,
  recordUpload: 6,
  revalidate: 7,
  valuesEqual: 8,
  submitDraft: 9,
  schemaRevision: 10,
  freezeListing: 11,
  projectSubmitDraft: 12,
  issueManifest: 13,
  wbPreview: 14,
  wbMetadataIssues: 15,
  planStage: 16,
  parseOcrAnswer: 17,
  validateVariantGroup: 18,
} as const

export interface ListingCore {
  loadWbMaterial(material: WbMaterial): WbSchemaHandle
  dropWbMaterial(handle: WbSchemaHandle): void
  wbPreview(handle: WbSchemaHandle, config: WbProductConfig): WbPreview
  wbMetadataIssues(handle: WbSchemaHandle): WbIssue[]
  projectSubmitDraft(input: ProjectSubmitDraftInput): SubmitDraft
  issueManifest(): KnownIssueKey[]
  /** Loads a schema and returns a resident handle (`schema_load`). */
  loadSchema(material: SchemaLoadInput): number
  /** Releases a resident schema (`schema_drop`; a no-op on an unknown handle). */
  dropSchema(handle: number): void
  seedRow(handle: number, input: SeedRowInput): SeedRowOutput
  editRow(handle: number, input: EditRowInput): EditRowOutput
  settleRecognition(handle: number, input: SettleRecognitionInput): EditedOutput
  decideCandidates(handle: number, input: DecideCandidatesInput): EditedOutput
  recordRender(input: RecordRenderInput): RecordRenderOutput
  /** Op 6 — composition, not a distinct rule: identical to `revalidate`
   * (`rust/crates/listing-core-wasm/src/dispatch.rs`'s module docs explain why
   * `record_upload` has no function of its own in `listing-core` either). */
  recordUpload(handle: number, input: RevalidateInput): EditedOutput
  revalidate(handle: number, input: RevalidateInput): EditedOutput
  valuesEqual(input: ValuesEqualInput): boolean
  /** The loaded schema's revision string. */
  schemaRevision(handle: number): string
  /** Needs no schema handle, like `recordRender`/`valuesEqual` —
   * `SubmitDraft::into_row` only reads the Card (`dispatch.rs`'s module
   * docs). A local preview only: the server always rebuilds and validates
   * again before accepting a submission (README I7). */
  submitDraft(input: SubmitDraftInput): SubmitDraftOutput
  /** Build → validate → freeze against the resident schema. A refusal is a
   * normal result carrying `FieldIssue`s, not a thrown `CORE_REFUSED`. */
  freezeListing(handle: number, input: FreezeListingInput): FreezeListingOutput
  /** Op 16. No schema. Confirms and OCR display steps the browser can decide. */
  planStage<T>(input: StageRequest): T
  /** Op 17. No schema. One settled completion → checked ru/tags/description.
   * Does not call a provider. A refusal throws `CORE_REFUSED` with its reason
   * code and retry class from the shared contract. */
  parseOcrAnswer(completion: unknown): ParsedOcrAnswer
  /** Op 18. No schema: the current category material travels in the body, so
   * the workbench judges a grouping with the very rules Cloud refuses it with
   * (`listing_core::variants::validate_group`). A refusal is the returned
   * problem list, never a thrown error. */
  validateVariantGroup(input: ValidateVariantGroupInput): VariantProblem[]
}

interface ListingCoreExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  free(ptr: number, len: number): void
  schema_load(ptr: number, len: number): number
  schema_drop(handle: number): void
  call(op: number, handle: number, ptr: number, len: number): number
  result_ptr(): number
  result_len(): number
  drop_result(): void
  last_error_ptr(): number
  last_error_len(): number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createListingCore(exports: WebAssembly.Exports): ListingCore {
  let trapped: WebAssembly.RuntimeError | undefined
  const wbHandles = new Set<WbSchemaHandle>()
  const requireWb = (handle: WbSchemaHandle) => {
    if (trapped) throw trapped
    if (!wbHandles.has(handle)) throw new ListingCoreError("CORE_SCHEMA_HANDLE", "WB material belongs to a different or retired native instance")
    return handle.handle
  }
  // A trapped allocator is never touched again, including free/drop calls.
  // WebAssembly exports are non-configurable/non-writable. Intercept our own
  // plain facade, not those immutable properties (Proxy [[Get]] invariant).
  const api = new Proxy({ ...exports } as unknown as ListingCoreExports, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== "function") return value
      return (...args: number[]) => {
        if (trapped) throw trapped
        try { return Reflect.apply(value, target, args) }
        catch (error) {
          if (error instanceof WebAssembly.RuntimeError) { trapped = error; wbHandles.clear() }
          throw error
        }
      }
    },
  })
  // wasm memory grows by replacing the buffer, so every read takes a fresh
  // view instead of caching one (same reasoning as render-wasm's `wasm.ts`).
  const view = () => new Uint8Array(api.memory.buffer)

  const put = (json: unknown): { ptr: number; len: number } => {
    const bytes = encoder.encode(JSON.stringify(json ?? null))
    const ptr = bytes.length === 0 ? 0 : api.alloc(bytes.length)
    if (ptr === 0 && bytes.length > 0) {
      throw new ListingCoreError("CORE_OOM", `listing-core-wasm refused ${bytes.length} bytes`)
    }
    if (bytes.length > 0) view().set(bytes, ptr)
    return { ptr, len: bytes.length }
  }

  const readError = (): never => {
    const ptr = api.last_error_ptr()
    const message = decoder.decode(view().subarray(ptr, ptr + api.last_error_len()))
    const parsed = JSON.parse(message) as { code: string; message: string; reason_code?: string; retry_class?: OcrRetryClass }
    throw new ListingCoreError(parsed.code, parsed.message, parsed.reason_code, parsed.retry_class)
  }

  const takeResult = <T>(): T => {
    const ptr = api.result_ptr()
    const bytes = view().slice(ptr, ptr + api.result_len())
    api.drop_result()
    return JSON.parse(decoder.decode(bytes)) as T
  }

  const call = <T>(op: number, handle: number, input: unknown): T => {
    const { ptr, len } = put(input)
    // No `finally`: a trap leaves the allocator in an unspecified state and
    // the caller must discard the whole instance, so freeing here would only
    // mask the trap with a second failure (same reasoning as render-wasm).
    const status = api.call(op, handle, ptr, len)
    if (ptr !== 0) api.free(ptr, len)
    return status === 0 ? takeResult<T>() : readError()
  }

  return {
    loadWbMaterial(material) {
      assertWbJson(material)
      const { ptr, len } = put({ platform: "wb", material })
      const id = api.schema_load(ptr, len)
      if (ptr !== 0) api.free(ptr, len)
      if (id === 0) return readError()
      const handle = Object.freeze({ platform: "wb" as const, handle: id })
      wbHandles.add(handle)
      return handle
    },
    dropWbMaterial(handle) {
      api.schema_drop(requireWb(handle))
      wbHandles.delete(handle)
    },
    wbPreview(handle, config) {
      assertWbJson(config)
      return call(OP.wbPreview, requireWb(handle), { config })
    },
    wbMetadataIssues(handle) {
      const status = api.call(OP.wbMetadataIssues, requireWb(handle), 0, 0)
      return status === 0 ? takeResult<WbIssue[]>() : readError()
    },
    loadSchema(material) {
      const { ptr, len } = put(material)
      const handle = api.schema_load(ptr, len)
      if (ptr !== 0) api.free(ptr, len)
      return handle === 0 ? readError() : handle
    },
    dropSchema(handle) {
      api.schema_drop(handle)
      for (const resident of wbHandles) if (resident.handle === handle) wbHandles.delete(resident)
    },
    seedRow: (handle, input) => call(OP.seedRow, handle, input),
    editRow: (handle, input) => call(OP.editRow, handle, input),
    settleRecognition: (handle, input) => call(OP.settleRecognition, handle, input),
    decideCandidates: (handle, input) => call(OP.decideCandidates, handle, input),
    recordRender: (input) => call(OP.recordRender, 0, input),
    recordUpload: (handle, input) => call(OP.recordUpload, handle, input),
    revalidate: (handle, input) => call(OP.revalidate, handle, input),
    valuesEqual: (input) => call(OP.valuesEqual, 0, input),
    schemaRevision: (handle) => call(OP.schemaRevision, handle, null),
    submitDraft: (input) => call(OP.submitDraft, 0, input),
    freezeListing: (handle, input) => call(OP.freezeListing, handle, input),
    projectSubmitDraft: (input) => call(OP.projectSubmitDraft, 0, input),
    issueManifest: () => call(OP.issueManifest, 0, null),
    planStage: <T>(input: StageRequest) => call<T>(OP.planStage, 0, input),
    parseOcrAnswer: (completion) => call(OP.parseOcrAnswer, 0, completion),
    validateVariantGroup: (input) => call(OP.validateVariantGroup, 0, input),
  }
}
