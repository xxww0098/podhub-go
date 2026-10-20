/**
 * Wave-0 structural admission in the browser: the bind-time pre-check refuses
 * only what the first bytes make certain, and a renderer refusal reaches the
 * operator as Chinese remediation with its stable code intact.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  PSD_CONTENT_REFUSAL_COPY,
  psdFileStructuralRefusal,
  renderFailure,
  renderFailureCode,
} from "./psd-admission"

const TEMPLATE = new Uint8Array(readFileSync(new URL(
  "../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd", import.meta.url,
)))

function withHeader(depth: number, mode: number): Uint8Array {
  const bytes = TEMPLATE.slice()
  const view = new DataView(bytes.buffer)
  view.setUint16(22, depth)
  view.setUint16(24, mode)
  return bytes
}

/** A 2×2 RGB8 PSD whose layer-and-mask section is `layerAndMask`. */
function psd(layerAndMask: number[], version = 1): Uint8Array {
  const out: number[] = [..."8BPS"].map((c) => c.charCodeAt(0))
  const u16 = (v: number) => out.push(v >> 8, v & 0xff)
  const u32 = (v: number) => out.push(v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
  u16(version); out.push(0, 0, 0, 0, 0, 0); u16(3); u32(2); u32(2); u16(8); u16(3)
  u32(0) // colour mode data
  u32(0) // image resources
  if (version === 2) u32(0)
  u32(layerAndMask.length)
  out.push(...layerAndMask)
  u16(0); out.push(...Array.from({ length: 12 }, () => 200))
  return new Uint8Array(out)
}

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart])

test("an RGB8 layered template passes the bind-time pre-check", async () => {
  assert.equal(await psdFileStructuralRefusal(blob(TEMPLATE)), undefined)
})

test("non-8-bit depths and non-RGB modes are refused from the header", async () => {
  for (const depth of [1, 16, 32]) {
    assert.equal(await psdFileStructuralRefusal(blob(withHeader(depth, 3))), "PSD_RENDER_UNSUPPORTED_DEPTH")
  }
  for (const mode of [0, 1, 2, 4, 7, 8, 9]) {
    assert.equal(await psdFileStructuralRefusal(blob(withHeader(8, mode))), "PSD_RENDER_UNSUPPORTED_COLOR_MODE")
  }
})

test("composite-only documents are refused; layers carried elsewhere defer to the renderer", async () => {
  assert.equal(await psdFileStructuralRefusal(blob(psd([]))), "PSD_RENDER_COMPOSITE_ONLY")
  // Empty layer info + empty global mask info.
  assert.equal(await psdFileStructuralRefusal(blob(psd([0, 0, 0, 0, 0, 0, 0, 0]))), "PSD_RENDER_COMPOSITE_ONLY")
  // Empty layer info, but a global `Layr` block: not certain, leave it to WASM.
  const layr = [0, 0, 0, 0, 0, 0, 0, 0, ..."8BIMLayr".split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 4, 0, 1, 0, 0]
  assert.equal(await psdFileStructuralRefusal(blob(psd(layr))), undefined)
  // Truncated or foreign bytes never become a refusal here.
  assert.equal(await psdFileStructuralRefusal(blob(TEMPLATE.subarray(0, 30))), undefined)
  assert.equal(await psdFileStructuralRefusal(blob(new Uint8Array([1, 2, 3]))), undefined)
})

test("crate codes survive the worker boundary and become Chinese, non-retryable copy", () => {
  const text = "Error: PSD_RENDER_UNSUPPORTED_DEPTH during header-admission: bitsPerChannel=16"
  assert.equal(renderFailureCode(text), "PSD_RENDER_UNSUPPORTED_DEPTH")
  assert.equal(renderFailureCode("MEDIA_ENCODED_OUTPUT_LIMIT during encode: x"), "MEDIA_ENCODED_OUTPUT_LIMIT")
  assert.equal(renderFailureCode("Error: RENDER_CANCELLED"), "RENDER_CANCELLED")
  assert.equal(renderFailureCode("boom"), undefined)

  const failure = renderFailure(text, "PSD_RENDER_UNSUPPORTED_DEPTH")
  assert.equal(failure.code, "PSD_RENDER_UNSUPPORTED_DEPTH")
  assert.equal(failure.message, PSD_CONTENT_REFUSAL_COPY.PSD_RENDER_UNSUPPORTED_DEPTH)
  assert.equal(failure.detail, text)
  assert.equal(failure.retryable, false)
  for (const copy of Object.values(PSD_CONTENT_REFUSAL_COPY)) assert.doesNotMatch(copy, /重试/)

  const other = renderFailure("Render failed", "RENDER_WORKER_ERROR")
  assert.equal(other.message, "Render failed")
  assert.equal(other.code, "RENDER_WORKER_ERROR")
})
