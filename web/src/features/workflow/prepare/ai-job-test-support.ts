import assert from "node:assert/strict"

import { route } from "@/api/routes"
import { record as recordBase } from "./executor-test-support"

// Private OCR staging stays separate from the shared executor transport fixture.
export function record(...args: Parameters<typeof recordBase>) {
  const stub = recordBase(...args)
  const deviceFetch = globalThis.fetch
  const uploads: { image: { bytes: number; content_type: string }; body?: Uint8Array }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === route("aiOcrUploads")) {
      const { image } = JSON.parse(String(init?.body))
      uploads.push({ image })
      return Response.json({ data: { upload_ticket: "private-ocr-ticket", upload: {
        url: "https://private-ocr.invalid/upload", expires_at_ms: Date.now() + 600_000,
        headers: { content_type: image.content_type, if_none_match: "*" },
      } } })
    }
    if (String(input) === "https://private-ocr.invalid/upload") {
      uploads.at(-1)!.body = init?.body as Uint8Array
      assert.equal(init?.credentials, "omit")
      assert.equal(init?.redirect, "error")
      return new Response(null, { status: 200 })
    }
    return deviceFetch(input, init)
  }) as typeof fetch
  return { ...stub, uploads }
}
