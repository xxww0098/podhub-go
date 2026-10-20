import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

const CHUNK = 1024 * 1024

self.onmessage = async (event: MessageEvent<{ file: Blob }>) => {
  const file = event.data.file
  const hasher = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const buf = await file.slice(offset, Math.min(file.size, offset + CHUNK)).arrayBuffer()
      hasher.update(new Uint8Array(buf))
      const loaded = Math.min(file.size, offset + CHUNK)
      self.postMessage({ type: "progress", loaded, total: file.size })
    }
    self.postMessage({ type: "done", hex: bytesToHex(hasher.digest()) })
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "hash" })
  } finally {
    hasher.destroy()
  }
}
