/**
 * Render types and packed-result decoding shared by the threaded worker, the
 * clients and the OPFS cache. The packed layout is documented in
 * `rust/crates/render-wasm/src/lib.rs`; `parseRenderResult` is the only reader.
 */

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

const decoder = new TextDecoder()

/**
 * Splits the packed result: a compact JSON header, one `\n`, then the
 * concatenated slice bytes. Each `offset` is measured from the byte after the
 * newline, so the header's own length never enters the arithmetic.
 */
export function parseRenderResult(packed: RenderBytes): RenderResult {
  const newline = packed.indexOf(0x0a)
  if (newline < 0) {
    throw new Error("RENDER_PROTOCOL: the render result has no header newline")
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
