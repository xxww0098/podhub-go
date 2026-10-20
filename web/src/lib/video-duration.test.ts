import assert from "node:assert/strict"
import test from "node:test"

import {
  elementVideoDurationMs,
  isoBmffDurationMs,
  readVideoDurationMs,
  validateVideoResolution,
} from "./video-duration"

/** 一个最小 ISO BMFF 文件：`mdat` 里放诱饵 `mvhd`，真值在 `moov` 里。 */
function isoBmffBytes(timescale: number, duration: number): ArrayBuffer {
  const bytes = new ArrayBuffer(72)
  const view = new DataView(bytes)
  const type = (offset: number, value: string) => {
    for (const [index, character] of [...value].entries()) {
      view.setUint8(offset + index, character.charCodeAt(0))
    }
  }
  view.setUint32(0, 36)
  type(4, "mdat")
  view.setUint32(8, 28)
  type(12, "mvhd")
  view.setUint32(28, 1_000)
  view.setUint32(32, 5_000)
  view.setUint32(36, 36)
  type(40, "moov")
  view.setUint32(44, 28)
  type(48, "mvhd")
  view.setUint32(64, timescale)
  view.setUint32(68, duration)
  return bytes
}

type FakeVideo = {
  duration: number
  videoWidth: number
  videoHeight: number
  preload: string
  onloadedmetadata: (() => void) | null
  onerror: (() => void) | null
  src: string
  removeAttribute: (name: string) => void
  load: () => void
}

/**
 * 装一个假 `document`：`<video>` 一拿到 `src` 就按 `behaviour` 回事件。
 * `load()` 把 `duration` 复位成 `NaN`——真实媒体元素就是这样，读值必须
 * 发生在 `load()` 之前。
 */
async function withFakeVideoElement(
  behaviour: "loaded" | "error" | "stalled",
  duration: number,
  run: (video: FakeVideo) => Promise<void>,
): Promise<void> {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const video: FakeVideo = {
    duration,
    videoWidth: 640,
    videoHeight: 422,
    preload: "",
    onloadedmetadata: null,
    onerror: null,
    set src(_url: string) {
      if (behaviour === "loaded") queueMicrotask(() => video.onloadedmetadata?.())
      if (behaviour === "error") queueMicrotask(() => video.onerror?.())
    },
    get src() {
      return ""
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
    await run(video)
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument)
    } else {
      Reflect.deleteProperty(globalThis, "document")
    }
  }
}

test("Ozon video upload rejects 608×400 and accepts 640×422", async () => {
  await withFakeVideoElement("loaded", 10, async (video) => {
    const file = new File(["video"], "clip.mp4")
    video.videoWidth = 608
    video.videoHeight = 400
    await assert.rejects(validateVideoResolution(file), /608×400.*至少 640/)
    video.videoWidth = 640
    video.videoHeight = 422
    await validateVideoResolution(file)
  })
})

test("resolution validation returns duration from the same metadata probe", async () => {
  await withFakeVideoElement("loaded", 10, async () => {
    assert.equal(await validateVideoResolution(new File(["video"], "clip.mp4")), 10_000)
  })
})

test("cancelling a stalled resolution probe rejects immediately and unloads it", async () => {
  await withFakeVideoElement("stalled", 10, async (video) => {
    const controller = new AbortController()
    const result = validateVideoResolution(new File(["video"], "clip.mp4"), controller.signal)
    controller.abort()
    await assert.rejects(result, { name: "AbortError" })
    assert.equal(video.onloadedmetadata, null)
    assert.equal(video.onerror, null)
    assert.ok(Number.isNaN(video.duration))
  })
})

test("undecodable video cannot bypass resolution validation via a duration header", async () => {
  await withFakeVideoElement("error", Number.NaN, async () => {
    await assert.rejects(
      validateVideoResolution(new File([isoBmffBytes(1_000, 10_000)], "clip.mp4")),
      /无法读取视频分辨率/,
    )
  })
})

test("the movie header gives the duration without a video decoder", () => {
  assert.equal(isoBmffDurationMs(isoBmffBytes(1_000, 47_700)), 47_700)
  assert.equal(isoBmffDurationMs(isoBmffBytes(480_000, 9_605_120)), 20_011)
})

test("a file that is not ISO BMFF, or is truncated, yields 0 rather than a guess", () => {
  assert.equal(isoBmffDurationMs(new ArrayBuffer(0)), 0)
  assert.equal(isoBmffDurationMs(new TextEncoder().encode("not a video").buffer as ArrayBuffer), 0)
  assert.equal(isoBmffDurationMs(isoBmffBytes(1_000, 47_700).slice(0, 50)), 0)
  assert.equal(isoBmffDurationMs(isoBmffBytes(0, 47_700)), 0)
})

test("element metadata is captured before unloading the element", async () => {
  await withFakeVideoElement("loaded", 10, async (video) => {
    assert.equal(await elementVideoDurationMs(new File(["video"], "clip.mp4"), 50), 10_000)
    assert.equal(video.onloadedmetadata, null)
    assert.equal(video.onerror, null)
  })
})

test("an element that cannot load the blob reports 0 instead of throwing", async () => {
  await withFakeVideoElement("error", 10, async () => {
    assert.equal(await elementVideoDurationMs(new File(["video"], "clip.mp4"), 50), 0)
  })
})

test("a duration the element cannot tell (non-finite) reports 0", async () => {
  await withFakeVideoElement("loaded", Number.POSITIVE_INFINITY, async () => {
    assert.equal(await elementVideoDurationMs(new File(["video"], "clip.mp4"), 50), 0)
  })
})

test("a blocked or undecodable blob still gets its duration from the movie header", async () => {
  await withFakeVideoElement("error", Number.NaN, async () => {
    const file = new File([isoBmffBytes(1_000, 47_700)], "clip.mp4")
    assert.equal(await readVideoDurationMs(file), 47_700)
  })
})

test("an undecodable file whose header is missing stays unknown", async () => {
  await withFakeVideoElement("error", Number.NaN, async () => {
    const file = new File([new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])], "clip.mp4")
    assert.equal(await readVideoDurationMs(file), 0)
  })
})

test("a stalled probe gives up at the timeout instead of hanging the upload", async () => {
  await withFakeVideoElement("stalled", 10, async () => {
    const file = new File([isoBmffBytes(1_000, 47_700)], "clip.mp4")
    assert.equal(await elementVideoDurationMs(file, 20), 0)
    assert.equal(await readVideoDurationMs(file, { timeoutMs: 20 }), 47_700)
  })
})

test("already-read bytes are reused instead of reading the file twice", async () => {
  await withFakeVideoElement("error", Number.NaN, async () => {
    const bytes = new Uint8Array(isoBmffBytes(1_000, 47_700))
    const file = new File(["video"], "clip.mp4")
    let reads = 0
    Object.defineProperty(file, "arrayBuffer", {
      value: () => {
        reads += 1
        return Promise.resolve(new ArrayBuffer(0))
      },
    })
    assert.equal(await readVideoDurationMs(file, { knownBytes: bytes }), 47_700)
    assert.equal(reads, 0)
  })
})
