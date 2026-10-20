/**
 * Wave-0 structural admission, as the browser sees it.
 *
 * `rust/crates/render` refuses three document families before rendering, because
 * the RGBA8 compositor can only turn them into wrong pixels:
 *
 * - `PSD_RENDER_UNSUPPORTED_DEPTH`: 1/16/32-bit samples were read as RGBA8.
 * - `PSD_RENDER_UNSUPPORTED_COLOR_MODE`: Gray/CMYK/Lab/… went through the RGB
 *   pipeline without conversion.
 * - `PSD_RENDER_COMPOSITE_ONLY`: no layer records, only the merged image,
 *   which rendered as a transparent canvas.
 *
 * These are content failures: retrying the same bytes cannot succeed, so the
 * copy asks for a Photoshop fix, never a retry. The renderer stays the
 * authority (it checks every template, including nested smart objects); the
 * header pre-check below only refuses a *new* binding early, before it
 * replaces the previous good one, and only on facts that are certain from the
 * first bytes of the file.
 */

export const PSD_CONTENT_REFUSAL_COPY = {
  PSD_RENDER_UNSUPPORTED_DEPTH:
    "当前模板位深不受支持。请在 Photoshop 中将副本转为 8 位/通道，保留替换图层后重新保存。",
  PSD_RENDER_UNSUPPORTED_COLOR_MODE:
    "当前模板色彩模式不受支持。请在 Photoshop 中转为 RGB，并通过“转换为配置文件”转为 sRGB 后重新保存。",
  PSD_RENDER_COMPOSITE_ONLY:
    "当前文件仅包含合并图像，不能作为可替换模板。请上传保留替换图层的分层 PSD/PSB。",
} as const

export type PsdContentRefusalCode = keyof typeof PSD_CONTENT_REFUSAL_COPY

export function isPsdContentRefusal(code: unknown): code is PsdContentRefusalCode {
  return typeof code === "string" && Object.hasOwn(PSD_CONTENT_REFUSAL_COPY, code)
}

/**
 * The stable code a render failure carries. The crate prints
 * `{CODE} during {phase}: {detail}`; across a worker boundary the text may be
 * prefixed (`Error: …`). Glue failures that carry no crate code keep their own
 * `RENDER_*` name.
 */
export function renderFailureCode(text: string): string | undefined {
  return /(?:^|[^A-Z0-9_])([A-Z][A-Z0-9_]*) during /.exec(text)?.[1]
    ?? /(?:^|[^A-Z0-9_])(RENDER_[A-Z_]+)\b/.exec(text)?.[1]
}

/**
 * A render failure as the operator reads it: content refusals swap the
 * English diagnostic for the Chinese remediation (kept on `detail` for logs);
 * every other failure is unchanged.
 */
export function renderFailure(message: string, code: string): Error & { code: string, detail?: string, retryable?: boolean } {
  if (isPsdContentRefusal(code)) {
    return Object.assign(new Error(PSD_CONTENT_REFUSAL_COPY[code]), { code, detail: message, retryable: false })
  }
  return Object.assign(new Error(message), { code })
}

const RGB = 3

/** Reads `length` bytes at `offset`; a short read means the file is short. */
export type ByteRange = (offset: number, length: number) => Promise<Uint8Array>

/**
 * The refusal code certain from the file's leading structure, or `undefined`
 * when the header is admissible or the answer needs the full parser.
 *
 * Only certainties are refused here: a non-8 depth, a non-RGB mode, or a
 * layer-and-mask section with no layer records anywhere (empty layer info and
 * no global `Layr`/`Lr16`/`Lr32` block). Anything malformed or
 * ambiguous is left to the renderer, which has the final word.
 */
export async function psdStructuralRefusal(read: ByteRange): Promise<PsdContentRefusalCode | undefined> {
  const header = await read(0, 26)
  if (header.length < 26) return undefined
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (String.fromCharCode(...header.subarray(0, 4)) !== "8BPS") return undefined
  const version = view.getUint16(4)
  if (version !== 1 && version !== 2) return undefined
  if (view.getUint16(22) !== 8) return "PSD_RENDER_UNSUPPORTED_DEPTH"
  if (view.getUint16(24) !== RGB) return "PSD_RENDER_UNSUPPORTED_COLOR_MODE"

  let offset = 26
  for (let section = 0; section < 2; section += 1) {
    // Colour mode data, then image resources: each a u32 length + payload.
    const length = await readLength(read, offset, 4)
    if (length === undefined) return undefined
    offset += 4 + length
  }
  const width = version === 2 ? 8 : 4
  const sectionLength = await readLength(read, offset, width)
  if (sectionLength === undefined) return undefined
  if (sectionLength === 0) return "PSD_RENDER_COMPOSITE_ONLY"
  const sectionEnd = offset + width + sectionLength
  offset += width
  const layerInfoLength = await readLength(read, offset, width)
  if (layerInfoLength !== 0) return undefined
  offset += width
  // An empty layer-info block is composite-only unless a global tagged block
  // carries the layers instead (`Layr`/`Lr16`/`Lr32`). Walk the remainder;
  // anything unexpected defers to the renderer.
  const globalMask = await readLength(read, offset, 4)
  if (globalMask === undefined) return undefined
  offset += 4 + globalMask
  for (let blocks = 0; offset < sectionEnd; blocks += 1) {
    if (blocks >= MAX_GLOBAL_BLOCKS || sectionEnd - offset < 12) return undefined
    const tag = await read(offset, 8)
    if (tag.length < 8) return undefined
    const signature = String.fromCharCode(...tag.subarray(0, 4))
    if (signature !== "8BIM" && signature !== "8B64") return undefined
    const key = String.fromCharCode(...tag.subarray(4, 8))
    if (LAYER_KEYS.has(key)) return undefined
    const lengthWidth = version === 2 && WIDE_KEYS.has(key) ? 8 : 4
    const length = await readLength(read, offset + 8, lengthWidth)
    if (length === undefined) return undefined
    offset += 8 + lengthWidth + length + ((4 - (length % 4)) % 4)
  }
  return offset === sectionEnd ? "PSD_RENDER_COMPOSITE_ONLY" : undefined
}

const MAX_GLOBAL_BLOCKS = 64
const LAYER_KEYS = new Set(["Layr", "Lr16", "Lr32"])
/** PSB tagged blocks whose length is 8 bytes (Adobe PSB file format notes). */
const WIDE_KEYS = new Set(["LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD"])

async function readLength(read: ByteRange, offset: number, width: 4 | 8): Promise<number | undefined> {
  const bytes = await read(offset, width)
  if (bytes.length < width) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, width)
  const value = width === 8 ? view.getBigUint64(0) : BigInt(view.getUint32(0))
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
}

/** `psdStructuralRefusal` over a picked `File`, reading only a few slices. */
export function psdFileStructuralRefusal(file: Blob): Promise<PsdContentRefusalCode | undefined> {
  return psdStructuralRefusal(async (offset, length) => {
    if (offset >= file.size) return new Uint8Array()
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  })
}
