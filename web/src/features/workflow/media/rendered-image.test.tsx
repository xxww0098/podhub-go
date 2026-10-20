import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  deliveredSlicePreview,
  formatFileSize,
  SliceZoom,
  stepSlice,
} from "./rendered-image"

const slice = {
  index: 0,
  file_name: "complete-slice.jpg",
  content_hash: "sha256:complete-slice",
  group_name: "主图",
  width: 900,
  height: 1200,
  phase: "public_ready" as const,
  public_url: "https://cdn.example.test/complete-slice.jpg",
}
const draftId = "workflow_instance_preview"
const undelivered = { ...slice, phase: "rendered" as const, public_url: undefined }

test("a delivered slice paints the Public Media URL without waiting for an OPFS read", () => {
  const html = renderToStaticMarkup(
    <SliceZoom draftId={draftId} image={slice} onClose={() => undefined} />,
  )

  assert.match(
    html,
    /src="https:\/\/cdn\.example\.test\/complete-slice\.jpg"/,
    "a delivered slice reads the Public Media URL (listing-design.md §3.1.1)",
  )
  assert.doesNotMatch(html, /正在加载切片/, "the public original needs no local read")
})

test("the zoom shows the whole slice without cropping its edges", () => {
  const html = renderToStaticMarkup(
    <SliceZoom draftId={draftId} image={slice} onClose={() => undefined} />,
  )
  const imageStart = html.indexOf("<img")
  const picture = html.slice(imageStart, html.indexOf(">", imageStart))

  assert.notEqual(imageStart, -1, "the zoom must paint the slice")
  assert.match(picture, /object-contain/)
  assert.doesNotMatch(picture, /object-cover/)
})

test("an undelivered slice waits on its own OPFS read instead of inventing a URL", () => {
  const html = renderToStaticMarkup(
    <SliceZoom draftId={draftId} image={undelivered} onClose={() => undefined} />,
  )

  assert.doesNotMatch(html, /<img/, "nothing paints until the local read lands")
  assert.doesNotMatch(html, /cdn\.example\.test/, "an undelivered slice has no public URL")
  assert.match(html, /正在加载切片/)
  assert.match(html, /aria-busy="true"/)
})

test("deliveredSlicePreview returns only a trimmed Public Media URL", () => {
  assert.equal(deliveredSlicePreview(slice), slice.public_url)
  assert.equal(deliveredSlicePreview(undelivered), undefined)
  assert.equal(deliveredSlicePreview({ ...slice, public_url: "  " }), undefined)
})

test("a walkable strip carries its position and both step controls", () => {
  const walking = renderToStaticMarkup(
    <SliceZoom
      draftId={draftId}
      image={slice}
      onClose={() => undefined}
      strip={{ at: 2, total: 8, step: () => undefined }}
    />,
  )
  assert.match(walking, /aria-label="第 3 张，共 8 张"/)
  assert.match(walking, /aria-label="上一张"/)
  assert.match(walking, /aria-label="下一张"/)

  const alone = renderToStaticMarkup(
    <SliceZoom draftId={draftId} image={slice} onClose={() => undefined} />,
  )
  assert.doesNotMatch(alone, /aria-label="上一张"/, "a lone slice has nowhere to walk")
})

test("formatFileSize formats byte quantities into readable units", () => {
  assert.equal(formatFileSize(undefined), "")
  assert.equal(formatFileSize(0), "")
  assert.equal(formatFileSize(512), "512 B")
  assert.equal(formatFileSize(1024), "1.0 KB")
  assert.equal(formatFileSize(45 * 1024), "45.0 KB")
  assert.equal(formatFileSize(350 * 1024), "350 KB")
  assert.equal(formatFileSize(1.5 * 1024 * 1024), "1.5 MB")
  assert.equal(formatFileSize(12 * 1024 * 1024), "12 MB")
})

test("arrow-key stepping wraps around the slice strip", () => {
  assert.equal(stepSlice(0, 1, 8), 1)
  assert.equal(stepSlice(7, 1, 8), 0)
  assert.equal(stepSlice(0, -1, 8), 7)
  assert.equal(stepSlice(null, 1, 8), null)
  assert.equal(stepSlice(0, -1, 1), 0)
})
