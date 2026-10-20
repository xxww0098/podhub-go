/** SHA-256 of a File off the main thread. Falls back to the incremental hasher. */
import { hashUploadBody } from "./direct-upload"

export type HashProgress = (loaded: number, total: number) => void

export async function hashFile(
  file: Blob,
  options: { signal?: AbortSignal; onProgress?: HashProgress } = {},
): Promise<string> {
  if (options.signal?.aborted) throw abortError()
  if (typeof Worker === "undefined" || file.size < 1024 * 1024) {
    options.onProgress?.(0, file.size)
    const hex = await hashUploadBody(file, options.signal)
    options.onProgress?.(file.size, file.size)
    return hex
  }
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL("./sha256.worker.ts", import.meta.url), { type: "module" })
    } catch {
      hashUploadBody(file, options.signal).then(resolve, reject)
      return
    }
    const fail = (error: unknown) => {
      worker.terminate()
      options.signal?.removeEventListener("abort", onAbort)
      reject(error)
    }
    const onAbort = () => fail(abortError())
    options.signal?.addEventListener("abort", onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<{ type: string; loaded?: number; total?: number; hex?: string; message?: string }>) => {
      const data = event.data
      if (data.type === "progress" && data.loaded != null && data.total != null) {
        options.onProgress?.(data.loaded, data.total)
      } else if (data.type === "done" && data.hex) {
        worker.terminate()
        options.signal?.removeEventListener("abort", onAbort)
        resolve(data.hex)
      } else if (data.type === "error") {
        fail(new Error(data.message ?? "校验失败"))
      }
    }
    worker.onerror = () => {
      worker.terminate()
      hashUploadBody(file, options.signal).then(resolve, reject)
    }
    worker.postMessage({ file })
  })
}

function abortError(): DOMException {
  return new DOMException("已取消", "AbortError")
}
