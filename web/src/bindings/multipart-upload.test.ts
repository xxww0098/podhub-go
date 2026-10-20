import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test } from "node:test"
import {
  PSD_PART_BYTES,
  clearSession,
  estimateSeconds,
  formatEta,
  formatRate,
  readSession,
  uploadParts,
  writeSession,
  type MultipartPlan,
} from "./multipart-upload"

const sha = "ab".repeat(32)
const memory = new Map<string, string>()

function plan(bytes: number): MultipartPlan {
  const count = Math.ceil(bytes / PSD_PART_BYTES)
  return {
    uploadId: "up-1",
    partSize: PSD_PART_BYTES,
    ticket: "ticket",
    parts: Array.from({ length: count }, (_, index) => ({
      partNumber: index + 1,
      url: `https://s3.invalid/part-${index + 1}`,
      byteLength: index + 1 === count ? bytes - index * PSD_PART_BYTES : PSD_PART_BYTES,
      expiresAtMs: Date.now() + 60_000,
    })),
  }
}

describe("psd multipart client", () => {
  let previousStorage: PropertyDescriptor | undefined

  beforeEach(() => {
    previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    memory.clear()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => { memory.set(key, value) },
        removeItem: (key: string) => { memory.delete(key) },
        clear: () => memory.clear(),
        key: () => null,
        get length() { return memory.size },
      },
    })
  })

  afterEach(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    memory.clear()
  })

  test("140 MiB is nine parts and a shared pipe is not faster than one PUT", () => {
    const bytes = 140 * 1024 * 1024
    assert.equal(plan(bytes).parts.length, 9)
    const single = estimateSeconds({ bytes, mode: "single", overheadSec: 1.5, bytesPerSec: 3.5 * 1000 * 1000 })
    const shared = estimateSeconds({
      bytes, mode: "multipart", overheadSec: 1.5, bytesPerSec: 3.5 * 1000 * 1000, sharedPipe: true,
    })
    const capped = estimateSeconds({
      bytes, mode: "multipart", overheadSec: 1.5, bytesPerSec: 3.5 * 1000 * 1000, sharedPipe: false,
    })
    assert.ok(shared > single)
    assert.ok(capped < single)
  })

  test("rate and eta stay in decimal megabytes and seconds", () => {
    assert.equal(formatRate(3_200_000), "3.2 MB/s")
    assert.equal(formatEta(40), "剩余 40 秒")
    assert.equal(formatEta(90), "剩余 1 分 30 秒")
  })

  test("resume skips finished parts and a missing ETag is a Chinese error", async () => {
    writeSession(sha, {
      uploadId: "up-1", ticket: "ticket", partSize: PSD_PART_BYTES, bytes: PSD_PART_BYTES + 10,
      completed: [{ partNumber: 1, etag: "\"done\"" }],
    })
    const seen: string[] = []
    const file = new Blob([new Uint8Array(PSD_PART_BYTES + 10)])
    const parts = await uploadParts(file, plan(file.size), {
      sha256: sha,
      fetchImpl: (async (url: string) => {
        seen.push(url)
        return new Response(null, { status: 200, headers: { etag: "\"next\"" } })
      }) as typeof fetch,
    })
    assert.deepEqual(seen, ["https://s3.invalid/part-2"])
    assert.equal(parts[0]?.etag, "\"done\"")
    assert.equal(readSession(sha)?.completed.length, 2)
    clearSession(sha)
    const limited = plan(8)
    let sleeps = 0
    const once = await uploadParts(new Blob([new Uint8Array(8)]), limited, {
      sleep: async () => { sleeps += 1 },
      fetchImpl: (async () => {
        if (sleeps === 0) return new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        return new Response(null, { status: 200, headers: { etag: "\"ok\"" } })
      }) as typeof fetch,
    })
    assert.equal(sleeps, 1)
    assert.equal(once[0]?.etag, "\"ok\"")
    await assert.rejects(() => uploadParts(file, plan(file.size), {
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    }), /暴露 ETag/)
  })
})
