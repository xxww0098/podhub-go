import assert from "node:assert/strict"
import test from "node:test"

import { downloadGrant, readPresignedObject, type ObjectDownloadGrant } from "./object-download"

const SECRET = "https://s3.example.invalid/bucket/object?X-Amz-Signature=super-secret-token"

function grant(overrides: Partial<ObjectDownloadGrant> = {}): ObjectDownloadGrant {
  return {
    url: SECRET,
    expires_at_ms: Date.now() + 60_000,
    bytes: 4,
    file_name: "a.psd",
    content_type: "application/octet-stream",
    sha256: "ab",
    ...overrides,
  }
}

test("a grant request asks for JSON and the object fetch omits credentials", async () => {
  const original = globalThis.fetch
  const seen: Array<{ url: string, accept: string | null, credentials?: RequestCredentials, redirect?: RequestRedirect }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    seen.push({
      url,
      accept: new Headers(init?.headers).get("accept"),
      credentials: init?.credentials,
      redirect: init?.redirect,
    })
    if (url === "/grant") {
      return Response.json({ data: grant() })
    }
    return new Response(new Uint8Array([1, 2, 3, 4]))
  }
  try {
    const issued = await downloadGrant("/grant")
    assert.equal(issued.url, SECRET)
    assert.deepEqual(await readPresignedObject(issued), new Uint8Array([1, 2, 3, 4]))
    assert.equal(seen[0]?.accept, "application/json")
    assert.equal(seen[0]?.credentials, "include")
    assert.equal(seen[1]?.url, SECRET)
    assert.equal(seen[1]?.credentials, "omit")
    assert.equal(seen[1]?.redirect, "error")
  } finally {
    globalThis.fetch = original
  }
})

test("an unsafe or failed object URL never comes back in the error", async () => {
  const original = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches++
    throw new TypeError(`network ${SECRET}`)
  }
  try {
    await assert.rejects(readPresignedObject(grant({ url: "http://evil.example/object?X-Amz-Signature=super-secret-token" })), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.equal(message.includes("super-secret-token"), false)
      assert.equal(message.includes("evil.example"), false)
      return true
    })
    assert.equal(fetches, 0, "unsafe URLs are refused before fetch")
    await assert.rejects(readPresignedObject(grant()), (error: unknown) => {
      const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error)
      assert.equal(message.includes("super-secret-token"), false)
      assert.equal(message.includes(SECRET), false)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})
