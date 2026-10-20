import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { deflateSync } from "node:zlib"

import {
  DEFAULT_RENDER_INTENT,
  RenderWasmError,
  createRenderModule,
  type RenderModule,
} from "../src/render/wasm"
import {
  renderProfile,
  sha256Hex,
  staticSliceEntry,
  staticSliceFileName,
} from "../src/render/opfs"

const repository = new URL("../../", import.meta.url)
const wasm = new URL("../../wasm/dist/browser/render/render_wasm.wasm", import.meta.url)

const TEMPLATE = readFileSync(
  new URL("fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd", repository),
)
const DESIGN = readFileSync(
  new URL("fixtures/psd/synthetic/replacement-transparent-edges.png", repository),
)
const CORRUPT = readFileSync(new URL("fixtures/psd/synthetic/corrupt-truncated.psd", repository))

/** `rust/crates/render/tests/end_to_end_render.rs`. The browser executor and Cloud
 * `worker-media` are interchangeable only while these stay byte-identical. */
const TEMPLATE_FINGERPRINT =
  "sha256:cf9170568835190367fa91751306d9ff970c6515a795bbe2bd314af6bb8f667a"
const SLICE_HASHES = [
  "sha256:a7e5d5311407031fbb94332483c195b5d3bd4bd190f92e89e317cdce3ae3b50d",
  "sha256:211b562c146f6c8ec22e8ff362b903c42ff7a22601c22a29fe68f145c002d5dc",
]

/** Missing committed WASM must fail instead of invoking a Rust build in CI. */
async function renderModule(): Promise<RenderModule> {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {
    env: { performance_now: () => performance.now() },
  })
  return createRenderModule(instance.exports)
}

const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

test("the wasm module renders the synthetic template to the pinned slice hashes", async () => {
  const render = await renderModule()
  const template = render.loadTemplate(TEMPLATE)
  assert.ok(template > 0, "a template handle is never 0")

  const result = render.renderProduct(template, DESIGN, "replacement-transparent-edges.png")
  assert.equal(result.slices.length, 2, "two exportable top groups")
  assert.deepEqual(
    result.slices.map((slice) => [slice.index, slice.groupName, slice.fileName, slice.width, slice.height]),
    [
      [0, "back", "replacement-transparent-edges-1.jpg", 56, 42],
      [1, "front", "replacement-transparent-edges-2.jpg", 56, 42],
    ],
  )
  assert.deepEqual(
    result.slices.map((slice) => slice.contentHash),
    SLICE_HASHES,
  )
  for (const slice of result.slices) {
    assert.equal(hash(slice.bytes), slice.contentHash, "the unpacked offsets land on the slice")
    assert.deepEqual([...slice.bytes.subarray(0, 2)], [0xff, 0xd8], "slices are JPEG")
  }

  const manifest = result.manifest as { version: number; templateFingerprint: string }
  assert.equal(manifest.version, 1)
  assert.equal(manifest.templateFingerprint, TEMPLATE_FINGERPRINT)
  const stageTimings = (result.manifest as { stageTimings?: Record<string, { ms: unknown; count: number }> })
    .stageTimings
  assert.ok(
    stageTimings && Object.values(stageTimings).some((stage) => stage.count > 0 && typeof stage.ms === "number" && stage.ms > 0),
    "wasm stage timings include measured milliseconds",
  )

  assert.deepEqual(staticSliceEntry(result.slices[0]), {
    groupIndex: 0,
    groupName: "back",
    width: 56,
    height: 42,
    byteSize: result.slices[0].bytes.length,
    contentHash: SLICE_HASHES[0],
  })

  // The peak-memory measurement reads this.
  assert.ok(render.memoryBytes() > 0, "linear memory is measurable after a render")
  render.dropTemplate(template)
})

test("an explicit intent renders the same as the crate default", async () => {
  const render = await renderModule()
  const template = render.loadTemplate(TEMPLATE)
  const result = render.renderProduct(
    template,
    DESIGN,
    "replacement-transparent-edges.png",
    DEFAULT_RENDER_INTENT,
  )
  assert.deepEqual(
    result.slices.map((slice) => slice.contentHash),
    SLICE_HASHES,
  )
})

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return ~crc >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}

/** An 8-bit greyscale PNG wider than the 1024 px side cap (`docs/ocr.md` §1). */
function widePng(width: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  const row = Buffer.alloc(width + 1)
  for (let x = 0; x < width; x += 1) {
    row[x + 1] = x & 0xff
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(row)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

test("prepare_ai_image downsamples an oversized PNG to JPEG", async () => {
  const render = await renderModule()
  const prepared = render.prepareAiImage(widePng(1600))
  assert.deepEqual([...prepared.subarray(0, 2)], [0xff, 0xd8])
})

test("the wasm renderer accepts grayscale PNG input", async () => {
  const render = await renderModule()
  const template = render.loadTemplate(TEMPLATE)
  try {
    const result = render.renderProduct(template, widePng(20), "grayscale.png")
    assert.equal(result.slices.length, 2)
    for (const slice of result.slices) {
      assert.deepEqual([...slice.bytes.subarray(0, 2)], [0xff, 0xd8])
      assert.ok(slice.width > 0 && slice.height > 0)
    }
  } finally {
    render.dropTemplate(template)
  }
})

test("prepare_ai_image passes an image the relay already accepts through verbatim", async () => {
  const render = await renderModule()
  // Under 128 KB and under 1024 px: re-encoding would only cost fidelity, so
  // the crate returns the source bytes and its own media type (ai_image.rs).
  assert.deepEqual([...render.prepareAiImage(DESIGN)], [...DESIGN])
})

test("a failed call surfaces last_error with a stable code and leaves the instance usable", async () => {
  const render = await renderModule()
  assert.throws(
    () => render.loadTemplate(CORRUPT),
    (error: unknown) => {
      assert.ok(error instanceof RenderWasmError)
      assert.match(error.code, /^[A-Z][A-Z0-9_]+$/)
      assert.notEqual(error.code, "RENDER_FAILED", "the crate's own code, not the glue's fallback")
      return true
    },
  )
  // A `0` return is not a trap: the same instance still renders. This is what
  // lets the worker discard the module only for the errors that are traps.
  const template = render.loadTemplate(TEMPLATE)
  assert.ok(template > 0)
})

test("the static-slice cache key is the Desktop one", async () => {
  assert.equal(renderProfile(DEFAULT_RENDER_INTENT), "v3:trim:3ff0000000000000:82")
  assert.equal(renderProfile(), "v3:trim:3ff0000000000000:82")
  assert.equal(
    renderProfile({ ...DEFAULT_RENDER_INTENT, exportBounds: "canvas", exportScale: 2, presentationQuality: 82 }),
    "v3:canvas:4000000000000000:82",
  )
  assert.equal(staticSliceFileName(0), "slice-1.jpg")
  assert.equal(staticSliceFileName(3), "slice-4.jpg")
  assert.equal(
    await sha256Hex("v3:trim:3ff0000000000000:82"),
    createHash("sha256").update("v3:trim:3ff0000000000000:82").digest("hex"),
  )
})
