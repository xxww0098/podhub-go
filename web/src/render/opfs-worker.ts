/**
 * The dedicated Web Worker that owns the render cache's byte I/O.
 *
 * `FileSystemFileHandle.createSyncAccessHandle` is DedicatedWorker-only
 * in the File System spec, so the Window thread's reads and writes — a 254 MiB
 * template among them — route here: byte copies happen off the main thread
 * and only buffers cross back, transferred rather than cloned. `preview`
 * goes further and never lets the full image leave the worker: it decodes,
 * downscales to `edge` and returns just the thumbnail.
 *
 * Directory handles are resolved per request, never cached: `clearCache` on
 * the Window thread can remove a whole family between ops, and a cached
 * handle into a deleted directory would file bytes nowhere.
 */

export type OpfsWorkerOp =
  | { op: "probe" }
  | { op: "read"; path: string[]; name: string }
  | { op: "write"; path: string[]; name: string; bytes: Uint8Array }
  | {
      op: "preview"
      path: string[]
      name: string
      /** Longest edge of the returned image, in CSS pixels. */
      edge: number
      /** Re-encode target; defaults to PNG for PNG files, JPEG otherwise. */
      mime?: string
    }

export type OpfsWorkerRequest = OpfsWorkerOp & { id: number }

export type OpfsWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; name: string; message: string }

/** What `preview` returns: the bytes to show, and the stored file's real size. */
export interface OpfsPreviewResult {
  bytes: Uint8Array
  byteSize: number
}

/**
 * lib.dom does not carry the DedicatedWorker-only sync handle; this is the
 * slice of `FileSystemSyncAccessHandle` the ops below use.
 */
interface SyncAccessHandle {
  getSize(): number
  read(buffer: Uint8Array, options?: { at?: number }): number
  write(buffer: Uint8Array, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

/**
 * Sync access handles are exclusive per file, not per origin. Different slice
 * files used to share one queue, so a wave of uploads opened the next file
 * only after the previous read returned. Same-file work stays ordered. The
 * cap matches a slice PUT wave: one row does not open more handles than it
 * will put, and a second row waits instead of holding every file open.
 */
export const OPFS_IO_PARALLEL = 6

const tails = new Map<string, Promise<void>>()
let ioActive = 0
const ioWaiting: Array<() => void> = []

function takeIoSlot(): Promise<void> {
  if (ioActive < OPFS_IO_PARALLEL) {
    ioActive += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    ioWaiting.push(() => {
      ioActive += 1
      resolve()
    })
  })
}

function freeIoSlot(): void {
  ioActive -= 1
  const next = ioWaiting.shift()
  if (next) next()
}

export function enqueueOpfsIo<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(async () => {
    await takeIoSlot()
    try {
      return await operation()
    } finally {
      freeIoSlot()
    }
  })
  const tail = run.then(() => undefined, () => undefined)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}

/**
 * `preview` never touches a sync handle — `getFile` snapshots the bytes and
 * decode/scale/encode are async canvas work — so it gets its own lane instead
 * of standing ahead of the reads an upload is waiting on.
 */
const PREVIEW_MAX_IN_FLIGHT = 2
/** Queued previews past this many waiters are refused; the window-side
 * scheduler already dedupes by request key and treats a refusal as no
 * thumbnail, so nothing user-visible breaks. */
const PREVIEW_MAX_QUEUED = 32

let previewInFlight = 0
const previewWaiters: Array<() => void> = []

export function enqueueOpfsPreview<T>(operation: () => Promise<T>): Promise<T> {
  if (previewInFlight >= PREVIEW_MAX_IN_FLIGHT && previewWaiters.length >= PREVIEW_MAX_QUEUED) {
    return Promise.reject(
      Object.assign(new Error("the OPFS preview backlog is full"), { name: "PreviewBusyError" }),
    )
  }
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      previewInFlight += 1
      operation().then(resolve, reject).finally(() => {
        previewInFlight -= 1
        previewWaiters.shift()?.()
      })
    }
    if (previewInFlight < PREVIEW_MAX_IN_FLIGHT) start()
    else previewWaiters.push(start)
  })
}

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

function capable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    typeof (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown })
      .createSyncAccessHandle === "function" &&
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas === "function"
  )
}

async function directory(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let handle = await navigator.storage.getDirectory()
  for (const segment of path) {
    handle = await handle.getDirectoryHandle(segment, { create })
  }
  return handle
}

/** Read exactly `size` bytes or fail — a short read is never a usable cache entry. */
export function readAll(access: SyncAccessHandle, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let filled = 0
  while (filled < size) {
    const got = access.read(bytes.subarray(filled), { at: filled })
    if (got <= 0) break
    filled += got
  }
  if (filled < size) {
    throw new Error(`short read: ${filled} of ${size} bytes`)
  }
  return bytes
}

/** Write every byte or fail; the caller truncates the half-written file. */
export function writeAll(access: SyncAccessHandle, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    const wrote = access.write(bytes.subarray(offset), { at: offset })
    if (wrote <= 0) {
      throw new Error(`short write: ${offset} of ${bytes.length} bytes`)
    }
    offset += wrote
  }
}

/**
 * Replace `access`'s contents with `bytes`. On failure the partial file is
 * truncated so a later read can never serve it as a cache entry; the original
 * error — including its `QuotaExceededError` name — is rethrown untouched.
 */
export function storeAll(access: SyncAccessHandle, bytes: Uint8Array): void {
  try {
    access.truncate(0)
    writeAll(access, bytes)
    access.flush()
  } catch (error) {
    try {
      access.truncate(0)
    } catch {
      // Keep the original error.
    }
    throw error
  }
}

async function read(path: string[], name: string): Promise<{ value: Uint8Array; transfer: Transferable[] }> {
  const file = await (await directory(path, false)).getFileHandle(name) as SyncFileHandle
  const access = await file.createSyncAccessHandle()
  try {
    const size = access.getSize()
    if (size === 0) {
      // An empty file is indistinguishable from a missing one for callers.
      throw new DOMException("the OPFS entry is empty", "NotFoundError")
    }
    const bytes = readAll(access, size)
    return { value: bytes, transfer: [bytes.buffer] }
  } finally {
    access.close()
  }
}

async function write(path: string[], name: string, bytes: Uint8Array): Promise<{ value: null; transfer: Transferable[] }> {
  const file = await (await directory(path, true)).getFileHandle(name, { create: true }) as SyncFileHandle
  const access = await file.createSyncAccessHandle()
  try {
    storeAll(access, bytes)
  } finally {
    access.close()
  }
  return { value: null, transfer: [] }
}

async function preview(
  path: string[],
  name: string,
  edge: number,
  mime?: string,
): Promise<{ value: OpfsPreviewResult; transfer: Transferable[] }> {
  const file = await (await directory(path, false)).getFileHandle(name).then((handle) => handle.getFile())
  const bitmap = await createImageBitmap(file)
  try {
    const scale = edge > 0 ? Math.min(1, edge / Math.max(bitmap.width, bitmap.height)) : 1
    if (scale >= 1) {
      // Already at or under the asked edge: the stored bytes are the preview.
      const bytes = new Uint8Array(await file.arrayBuffer())
      return { value: { bytes, byteSize: file.size }, transfer: [bytes.buffer] }
    }
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    )
    const context = canvas.getContext("2d")
    if (!context) throw new Error("the OPFS worker cannot draw: OffscreenCanvas 2d is missing")
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const type = mime ?? (file.type === "image/png" ? "image/png" : "image/jpeg")
    const blob = await canvas.convertToBlob({ type, quality: 0.85 })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return { value: { bytes, byteSize: file.size }, transfer: [bytes.buffer] }
  } finally {
    bitmap.close()
  }
}

async function run(request: OpfsWorkerOp): Promise<{ value: unknown; transfer: Transferable[] }> {
  switch (request.op) {
    case "probe":
      return { value: capable(), transfer: [] }
    case "read":
      return read(request.path, request.name)
    case "write":
      return write(request.path, request.name, request.bytes)
    case "preview":
      return preview(request.path, request.name, request.edge, request.mime)
  }
}

function ioKey(request: OpfsWorkerOp): string {
  if (request.op === "read" || request.op === "write") {
    return `${request.path.join("\0")}\0${request.name}`
  }
  return request.op
}

function reply(request: OpfsWorkerRequest, work: Promise<{ value: unknown; transfer: Transferable[] }>): void {
  void work.then(
    ({ value, transfer }) => {
      postMessage({ id: request.id, ok: true, value } satisfies OpfsWorkerResponse, { transfer })
    },
    (error: unknown) => {
      // Error names ride the reply so the caller's NotFoundError /
      // QuotaExceededError handling works exactly as on the Window API.
      postMessage({
        id: request.id,
        ok: false,
        name: (error as { name?: string })?.name ?? "Error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies OpfsWorkerResponse)
    },
  )
}

addEventListener("message", (event) => {
  const request = event.data as OpfsWorkerRequest
  const work = request.op === "preview"
    ? enqueueOpfsPreview(() => run(request))
    : enqueueOpfsIo(ioKey(request), () => run(request))
  reply(request, work)
})
