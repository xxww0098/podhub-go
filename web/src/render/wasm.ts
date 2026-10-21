/**
 * Shared render types / packed-result decoding, plus the legacy C-ABI adapter
 * used by golden tests and benchmarks. Production uses threaded-worker.ts and
 * generated bindgen glue, not loadRenderModule / createRenderModule.
 *
 * The module imports a monotonic clock for diagnostics. Render data crosses
 * as bytes in its own linear memory: `alloc`, write,
 * call, read the result buffer, `free`. `rust/crates/render-wasm/src/lib.rs` is the
 * contract; this file is the only place that speaks it.
 *
 * `memory.buffer` is detached and replaced whenever the module grows its heap,
 * so every read takes a fresh view instead of caching one.
 */

import { instantiateWasm } from "../lib/wasm-loader"

/** `RenderIntent` as the crate serialises it — camelCase, defaults included. */
export interface RenderIntent {
  fit: "cover" | "contain" | "fill"
  slotSelection: string
  exportBounds: "trim" | "canvas"
  exportScale: number
  presentationQuality: number
  /**
   * `skip` leaves the groups whose pixels cannot depend on the design out of
   * the render; their slices come back in order with `staticGroup` set and no
   * bytes, for the caller to fill from `opfs.ts`. Omitted means `render`. Not
   * part of `renderProfile()`: it changes what is rendered, never how.
   */
  staticGroups?: "render" | "skip"
}

/**
 * `RenderIntent::default()`. An omitted intent renders with exactly this.
 * `presentationQuality` must match `DEFAULT_PRESENTATION_QUALITY` in
 * `rust/crates/render/src/media/intent.rs` (82 → 4:2:0 JPEG).
 */
export const DEFAULT_RENDER_INTENT: RenderIntent = {
  fit: "cover",
  slotSelection: "auto",
  exportBounds: "trim",
  exportScale: 1,
  presentationQuality: 82,
}

/**
 * wasm memory is a plain `ArrayBuffer`, never shared. Saying so is what lets a
 * view reach `crypto.subtle`, a `postMessage` transfer list and a
 * `FileSystemWritableFileStream` without a cast at each one.
 */
export type RenderBytes = Uint8Array<ArrayBuffer>

export interface RenderSlice {
  groupName: string
  index: number
  fileName: string
  width: number
  height: number
  /** `sha256:{hex}` of `bytes`, computed by the renderer. */
  contentHash: string
  /**
   * The group's pixels do not depend on the design: the same slice for every
   * product of this template and render profile. Under `staticGroups: "skip"`
   * it arrives with no bytes, an empty hash and zero dimensions. Set by the
   * renderer; a slice rebuilt from a row's lifecycle has no say.
   */
  staticGroup?: boolean
  /** JPEG encode duration reported by the renderer. Absent on a cache fill. */
  encodeMs?: number
  /** A view on the single buffer copied out of wasm memory for this render. */
  bytes: RenderBytes
}

export interface RenderResult {
  manifest: unknown
  slices: RenderSlice[]
}

/**
 * A call that returned `0` and left a message in `last_error`.
 *
 * `code` is the `MediaErrorCode` the crate prints ahead of the phase — the
 * message is `{CODE} during {phase}: {detail}` — or `RENDER_FAILED` for the
 * glue's own failures, which carry no code.
 */
export class RenderWasmError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RenderWasmError"
    this.code = code
  }
}

export interface RenderModule {
  /** One handle serves a whole batch of designs. */
  loadTemplate(bytes: Uint8Array): number
  dropTemplate(handle: number): void
  renderProduct(
    templateHandle: number,
    designBytes: Uint8Array,
    designName: string,
    intent?: RenderIntent,
  ): RenderResult
  prepareAiImage(bytes: Uint8Array): RenderBytes
  /** Linear-memory size right now — the peak-memory measurement input. */
  memoryBytes(): number
}

interface RenderExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  free(ptr: number, len: number): void
  load_template(ptr: number, len: number): number
  drop_template(handle: number): void
  render_product(
    templateHandle: number,
    designPtr: number,
    designLen: number,
    namePtr: number,
    nameLen: number,
    intentPtr: number,
    intentLen: number,
  ): number
  prepare_ai_image(ptr: number, len: number): number
  result_len(handle: number): number
  result_ptr(handle: number): number
  drop_result(handle: number): void
  last_error_len(): number
  last_error_ptr(): number
}

interface PackedSlice {
  groupName: string
  index: number
  fileName: string
  width: number
  height: number
  contentHash: string
  staticGroup: boolean
  encodeMs?: number
  offset: number
  len: number
}

interface PackedHeader {
  manifest: unknown
  slices: PackedSlice[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CODED_MESSAGE = /^([A-Z][A-Z0-9_]*) during /

/**
 * Splits the packed result: a compact JSON header, one `\n`, then the
 * concatenated slice bytes. Each `offset` is measured from the byte after the
 * newline, so the header's own length never enters the arithmetic.
 */
export function parseRenderResult(packed: RenderBytes): RenderResult {
  const newline = packed.indexOf(0x0a)
  if (newline < 0) {
    throw new RenderWasmError("RENDER_PROTOCOL", "the render result has no header newline")
  }
  const header = JSON.parse(decoder.decode(packed.subarray(0, newline))) as PackedHeader
  const base = newline + 1
  return {
    manifest: header.manifest,
    slices: header.slices.map((slice) => ({
      groupName: slice.groupName,
      index: slice.index,
      fileName: slice.fileName,
      width: slice.width,
      height: slice.height,
      contentHash: slice.contentHash,
      staticGroup: slice.staticGroup,
      encodeMs: typeof slice.encodeMs === "number" ? slice.encodeMs : undefined,
      bytes: packed.subarray(base + slice.offset, base + slice.offset + slice.len),
    })),
  }
}

export function createRenderModule(exports: WebAssembly.Exports): RenderModule {
  const api = exports as unknown as RenderExports
  const view = () => new Uint8Array(api.memory.buffer)

  const fail = (): never => {
    const ptr = api.last_error_ptr()
    const message = decoder.decode(view().subarray(ptr, ptr + api.last_error_len()))
    throw new RenderWasmError(CODED_MESSAGE.exec(message)?.[1] ?? "RENDER_FAILED", message)
  }

  const put = (data: Uint8Array): number => {
    const ptr = api.alloc(data.length)
    if (ptr === 0) {
      throw new RenderWasmError("RENDER_OOM", `render-wasm refused ${data.length} bytes`)
    }
    // After `alloc`, because that is the call that may have grown the heap.
    view().set(data, ptr)
    return ptr
  }

  // One copy out of wasm memory for the whole result; the slices are views on
  // it, so a worker transfers the render with a single detach.
  const take = (handle: number): RenderBytes => {
    const ptr = api.result_ptr(handle)
    const bytes = view().slice(ptr, ptr + api.result_len(handle))
    api.drop_result(handle)
    return bytes
  }

  return {
    loadTemplate(bytes) {
      const ptr = put(bytes)
      const handle = api.load_template(ptr, bytes.length)
      api.free(ptr, bytes.length)
      return handle === 0 ? fail() : handle
    },

    dropTemplate(handle) {
      api.drop_template(handle)
    },

    renderProduct(templateHandle, designBytes, designName, intent) {
      const name = encoder.encode(designName)
      const intentJson = intent ? encoder.encode(JSON.stringify(intent)) : new Uint8Array(0)
      const designPtr = put(designBytes)
      const namePtr = put(name)
      const intentPtr = intentJson.length === 0 ? 0 : put(intentJson)
      // No `finally`: a trap leaves the allocator in an unspecified state and
      // the worker discards the instance, so freeing then would only mask the
      // trap with a second one.
      const handle = api.render_product(
        templateHandle,
        designPtr,
        designBytes.length,
        namePtr,
        name.length,
        intentPtr,
        intentJson.length,
      )
      api.free(designPtr, designBytes.length)
      api.free(namePtr, name.length)
      if (intentPtr !== 0) {
        api.free(intentPtr, intentJson.length)
      }
      return handle === 0 ? fail() : parseRenderResult(take(handle))
    },

    prepareAiImage(bytes) {
      const ptr = put(bytes)
      const handle = api.prepare_ai_image(ptr, bytes.length)
      api.free(ptr, bytes.length)
      // No JSON header on this one — the result buffer is the prepared image.
      return handle === 0 ? fail() : take(handle)
    },

    memoryBytes() {
      return api.memory.buffer.byteLength
    },
  }
}

/** Fetches and instantiates the module once, using bytes for a non-WASM MIME
 * type. The legacy test/benchmark Worker supplies its bundled module URL. */
export async function loadRenderModule(url: string): Promise<RenderModule> {
  const imports = { env: { performance_now: () => performance.now() } }
  const { instance } = await instantiateWasm(url, imports)
  return createRenderModule(instance.exports)
}
