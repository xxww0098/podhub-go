import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { ListingCoreClient } from "../src/listing-core/client"
import { loadRenderModule } from "../src/render/wasm"

const loaders = [
  {
    name: "listing-core",
    bytes: readFileSync(new URL("../../wasm/dist/browser/listing-state.wasm", import.meta.url)),
    async load(url: string) {
      const client = new ListingCoreClient(url)
      assert.ok((await client.issueManifest()).length > 0)
    },
  },
  {
    name: "legacy-render",
    bytes: readFileSync(new URL("../../wasm/dist/browser/render/render_wasm.wasm", import.meta.url)),
    async load(url: string) {
      assert.ok((await loadRenderModule(url)).memoryBytes() > 0)
    },
  },
]

// (module (import "env" "missing" (func)))
const missingImport = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  2, 15, 1, 3, 101, 110, 118, 7, 109, 105, 115, 115, 105, 110, 103, 0, 0,
)
// (module (func $start unreachable) (start $start))
const trappingStart = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  8, 1, 0,
  10, 5, 1, 3, 0, 0, 11,
)
const url = "https://wasm.invalid/module.wasm"

async function withResponse(
  respond: () => Response | Promise<Response>,
  run: (counts: { fetches: number; streams: number }) => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch
  const previousStreaming = WebAssembly.instantiateStreaming
  const counts = { fetches: 0, streams: 0 }
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), url)
    counts.fetches += 1
    return respond()
  }) as typeof fetch
  WebAssembly.instantiateStreaming = (source, imports) => {
    counts.streams += 1
    return previousStreaming(source, imports)
  }
  try {
    await run(counts)
  } finally {
    globalThis.fetch = previousFetch
    WebAssembly.instantiateStreaming = previousStreaming
  }
}

for (const loader of loaders) {
  for (const contentType of ["application/wasm", "application/octet-stream", ""] as const) {
    test(`${loader.name} loads real WASM with one fetch (${contentType || "missing MIME"})`, async () => {
      await withResponse(
        () => new Response(loader.bytes, { headers: contentType ? { "Content-Type": contentType } : {} }),
        async (counts) => {
          await loader.load(url)
          assert.equal(counts.fetches, 1, "MIME fallback must consume the original response")
          assert.equal(counts.streams, contentType === "application/wasm" ? 1 : 0)
        },
      )
    })
  }

  test(`${loader.name} rejects HTTP errors before compiling a valid body`, async () => {
    await withResponse(
      () => new Response(loader.bytes, { status: 503, headers: { "Content-Type": "application/wasm" } }),
      async (counts) => {
        await assert.rejects(() => loader.load(url), /HTTP 503/)
        assert.deepEqual(counts, { fetches: 1, streams: 0 })
      },
    )
  })

  test(`${loader.name} propagates the original network error without retry`, async () => {
    const reason = new TypeError("offline fixture")
    await withResponse(
      () => { throw reason },
      async (counts) => {
        await assert.rejects(() => loader.load(url), error => error === reason)
        assert.equal(counts.fetches, 1)
      },
    )
  })

  for (const [kind, bytes, ErrorClass] of [
    ["compile", Uint8Array.of(0, 1, 2, 3), WebAssembly.CompileError],
    ["link", missingImport, WebAssembly.LinkError],
    ["start trap", trappingStart, WebAssembly.RuntimeError],
  ] as const) {
    test(`${loader.name} does not retry a ${kind} failure`, async () => {
      await withResponse(
        () => new Response(bytes, { headers: { "Content-Type": "application/wasm" } }),
        async (counts) => {
          await assert.rejects(() => loader.load(url), ErrorClass)
          assert.equal(counts.fetches, 1, "an instantiation failure is not a download failure")
        },
      )
    })
  }
}

test("listing-core restart reuses its compiled module without another fetch", async () => {
  await withResponse(
    () => new Response(loaders[0]!.bytes, { headers: { "Content-Type": "application/wasm" } }),
    async (counts) => {
      const client = new ListingCoreClient(url)
      const before = await client.issueManifest()
      await client.restart()
      assert.deepEqual(await client.issueManifest(), before)
      assert.equal(client.generation, 1)
      assert.equal(counts.fetches, 1)
    },
  )
})
