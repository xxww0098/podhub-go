import assert from "node:assert/strict"
import test from "node:test"

import { probeVideoDurationMs } from "./supplier-row-media"

/** 最小 ISO BMFF：`moov/mvhd` timescale 1000 / duration 47700。 */
function isoBmffBytes(): ArrayBuffer {
  const bytes = new ArrayBuffer(72)
  const view = new DataView(bytes)
  const type = (offset: number, value: string) => {
    for (const [index, character] of [...value].entries()) {
      view.setUint8(offset + index, character.charCodeAt(0))
    }
  }
  view.setUint32(0, 36)
  type(4, "mdat")
  view.setUint32(36, 36)
  type(40, "moov")
  view.setUint32(44, 28)
  type(48, "mvhd")
  view.setUint32(64, 1_000)
  view.setUint32(68, 47_700)
  return bytes
}

/**
 * 装一个假 `document`，`<video>` 一拿到 `src` 就按 `behaviour` 回事件；
 * `load()` 把 `duration` 复位成 `NaN`（真实媒体元素如此）。
 * `error` 就是生产上 CSP 拦掉 blob:、或浏览器没有该编解码器时的样子。
 */
async function withVideoElement(
  behaviour: "loaded" | "error",
  run: () => Promise<void>,
): Promise<void> {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const video = {
    duration: 10,
    preload: "",
    onloadedmetadata: null as (() => void) | null,
    onerror: null as (() => void) | null,
    set src(_url: string) {
      if (behaviour === "loaded") queueMicrotask(() => video.onloadedmetadata?.())
      else queueMicrotask(() => video.onerror?.())
    },
    removeAttribute(_name: string) {},
    load() {
      video.duration = Number.NaN
    },
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => video },
  })
  try {
    await run()
    assert.equal(video.onloadedmetadata, null)
    assert.equal(video.onerror, null)
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument)
    } else {
      Reflect.deleteProperty(globalThis, "document")
    }
  }
}

test("video duration survives unloading the metadata element", async () => {
  await withVideoElement("loaded", async () => {
    assert.equal(await probeVideoDurationMs(new File(["video"], "clip.mp4")), 10_000)
  })
})

test("a clip the browser cannot decode still reports the movie header duration", async () => {
  await withVideoElement("error", async () => {
    const file = new File([isoBmffBytes()], "clip.mp4")
    assert.equal(await probeVideoDurationMs(file), 47_700)
  })
})

test("a clip with neither a decodable body nor a usable header is refused", async () => {
  await withVideoElement("error", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])], "clip.mp4")
    await assert.rejects(probeVideoDurationMs(file), /无法读取视频时长/)
  })
})
