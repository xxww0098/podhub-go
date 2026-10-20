/**
 * 浏览器侧视频时长读取——工作台与平台货源共用，不转码、不解码整段视频。
 *
 * 两条腿，按可靠性排序：
 * 1. 离屏 `<video preload="metadata">` + object URL：能播的文件走解码器，最准；
 *    被 CSP `media-src` 拦掉、编解码器缺失、元数据迟迟不来都算失败。
 * 2. ISO BMFF（MP4/MOV）`moov/mvhd` 头：只读文件字节，不需要解码器，也
 *    不受 CSP 影响；浏览器没有对应解码器时这是唯一能拿到真值的路。
 *
 * 契约：读不出返回 0，绝不编造时长——调用方自己决定 0 是拒绝上传还是留空。
 */
const VIDEO_DURATION_TIMEOUT_MS = 15_000

/**
 * 从 MP4/MOV 的 `mvhd` 读时长；头缺失、截断或形状不认识一律返回 0。
 * 盒子按 ISO/IEC 14496-12 走：32 位 size，`size == 1` 时跟 64 位 largesize，
 * `size == 0` 表示延伸到文件尾。
 */
export function isoBmffDurationMs(bytes: ArrayBuffer): number {
  const view = new DataView(bytes)
  const boxAt = (offset: number, limit: number) => {
    if (offset + 8 > limit) return undefined
    const size32 = view.getUint32(offset)
    const headerSize = size32 === 1 ? 16 : 8
    if (offset + headerSize > limit) return undefined
    const size = size32 === 0
      ? limit - offset
      : size32 === 1
        ? Number(view.getBigUint64(offset + 8))
        : size32
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > limit) return undefined
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    )
    return { type, body: offset + headerSize, end: offset + size }
  }
  let top = 0
  while (top < view.byteLength) {
    const box = boxAt(top, view.byteLength)
    if (!box) break
    if (box.type === "moov") {
      let childOffset = box.body
      while (childOffset < box.end) {
        const child = boxAt(childOffset, box.end)
        if (!child) break
        if (child.type === "mvhd") {
          const version = view.getUint8(child.body)
          const needed = version === 1 ? 32 : version === 0 ? 20 : 0
          if (needed > 0 && child.body + needed <= child.end) {
            const timescale = view.getUint32(child.body + (version === 1 ? 20 : 12))
            const duration = version === 1
              ? Number(view.getBigUint64(child.body + 24))
              : view.getUint32(child.body + 16)
            const milliseconds = timescale > 0 ? Math.round(duration * 1000 / timescale) : 0
            if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds
          }
        }
        childOffset = child.end
      }
    }
    top = box.end
  }
  return 0
}

/**
 * `<video preload="metadata">` 元数据探测；失败（含超时、被拦、解码不了、
 * `duration` 是 `NaN`/`Infinity`）返回 0，不抛——调用方还有文件头那条腿。
 * 取完值先摘掉事件再 `load()`（`load()` 会把 `duration` 复位成 `NaN`）。
 */
function elementVideoMetadata(
  file: File,
  timeoutMs: number = VIDEO_DURATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ durationMs: number; width: number; height: number } | null> {
  signal?.throwIfAborted()
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement("video")
    let settled = false
    const finish = (value: { durationMs: number; width: number; height: number } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute("src")
      video.load()
      URL.revokeObjectURL(url)
      if (signal?.aborted) reject(signal.reason)
      else resolve(value)
    }
    const abort = () => finish(null)
    const timer = setTimeout(() => finish(null), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    video.preload = "metadata"
    video.onloadedmetadata = () => {
      const durationMs = Math.round(video.duration * 1000)
      finish({
        durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }
    video.onerror = () => finish(null)
    video.src = url
  })
}

export async function elementVideoDurationMs(
  file: File,
  timeoutMs: number = VIDEO_DURATION_TIMEOUT_MS,
): Promise<number> {
  return (await elementVideoMetadata(file, timeoutMs))?.durationMs ?? 0
}

export async function validateVideoResolution(file: File, signal?: AbortSignal): Promise<number> {
  const metadata = await elementVideoMetadata(file, VIDEO_DURATION_TIMEOUT_MS, signal)
  if (!metadata || !Number.isFinite(metadata.width) || metadata.width <= 0) {
    throw new Error("无法读取视频分辨率，请检查视频文件后重试")
  }
  if (metadata.width < 640) {
    throw new Error(`视频分辨率为 ${metadata.width}×${metadata.height}，Ozon 要求视频宽度至少 640 像素，请调整后重新上传`)
  }
  return metadata.durationMs
}

/**
 * 先解码器、后 `mvhd` 头。已经读过字节的调用方传 `knownBytes`，省一次
 * 全文件读（视频可达上百 MB）。两条腿都读不出返回 0。
 */
export async function readVideoDurationMs(
  file: File,
  options: { knownBytes?: Uint8Array; timeoutMs?: number } = {},
): Promise<number> {
  const probed = await elementVideoDurationMs(file, options.timeoutMs)
  if (probed > 0) return probed
  try {
    const bytes = options.knownBytes
      ? options.knownBytes.buffer.slice(
        options.knownBytes.byteOffset,
        options.knownBytes.byteOffset + options.knownBytes.byteLength,
      ) as ArrayBuffer
      : await file.arrayBuffer()
    return isoBmffDurationMs(bytes)
  } catch {
    return 0
  }
}
