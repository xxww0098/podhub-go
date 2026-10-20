import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { mediaCellState, slicesForRole } from "../media/workflow-media-roles"
import { FieldWorkbench } from "./field-workbench"
import { MediaDeliveryInspector } from "./media-delivery-inspector"
import { idleLifecycle, instance, row, schema, slice } from "./workbench-test-fixtures"
import { buttonMarkup, workbenchProps } from "./workbench-test-harness"

// ---------------------------------------------------------------------------
// Media roles
// ---------------------------------------------------------------------------

test("media columns split slices by PSD group name, and 360 outranks colour", () => {
  const images = [
    slice(0, { group_name: "主体" }),
    slice(1, { group_name: "颜色对比" }),
    slice(2, { group_name: "Color swatch" }),
    slice(3, { group_name: "360 color turntable" }),
    slice(4, { group_name: "细节 360" }),
  ]

  assert.deepEqual(slicesForRole(images, "images").map((image) => image.index), [0, 1, 2, 3, 4])
  assert.deepEqual(slicesForRole(images, "primary_image").map((image) => image.index), [0])
  assert.deepEqual(
    slicesForRole(images, "images360").map((image) => image.index),
    [3, 4],
    "any group name containing 360 is a 360 slice, in render order",
  )
  assert.deepEqual(
    slicesForRole(images, "color_image").map((image) => image.index),
    [1],
    "the colour swatch is the first slice claiming the role, not the primary image",
  )
  assert.deepEqual(
    slicesForRole(
      [slice(0, { group_name: "主体" }), slice(1, { group_name: "细节" })],
      "color_image",
    ).map((image) => image.index),
    [0],
    "with no colour group the column falls back to the first slice, as Cloud does",
  )

  const delivered = images.map((image) => ({
    ...image,
    phase: "public_ready" as const,
    public_url: `https://cdn.example.test/${image.index}.jpg`,
  }))
  const lifecycle: WorkflowProductLifecycle = { ...idleLifecycle, media: "ready", images: delivered }
  assert.deepEqual(mediaCellState(lifecycle, "images").urls.length, 5)
  assert.deepEqual(mediaCellState(lifecycle, "images360").urls, [
    "https://cdn.example.test/3.jpg",
    "https://cdn.example.test/4.jpg",
  ])
  assert.deepEqual(mediaCellState(lifecycle, "color_image").urls, [
    "https://cdn.example.test/1.jpg",
  ])
  // A record predating group-name persistence still shows the colour swatch the
  // payload will publish; only the 360° column has to admit it cannot attribute.
  const blankColor = mediaCellState(
    { ...idleLifecycle, media: "rendered", images: [slice(0, { group_name: "" })] },
    "color_image",
  )
  assert.deepEqual(blankColor.slices.map((image) => image.index), [0])
  assert.equal(blankColor.label, "1 切片 · 未上传")

  // Nothing rendered, something rendered but undelivered, and a record written
  // before group names were persisted each say so in their own words.
  assert.equal(mediaCellState(idleLifecycle, "images").label, "未切片")
  assert.equal(
    mediaCellState({ ...idleLifecycle, media: "rendered", images: [slice(0), slice(1)] }, "images").label,
    "2 切片 · 未上传",
  )
  const blankGroups = mediaCellState(
    { ...idleLifecycle, media: "rendered", images: [slice(0, { group_name: "" })] },
    "images360",
  )
  assert.equal(blankGroups.label, "组名缺失 · 需重新切片")
  assert.equal(blankGroups.tone, "unknown")
  assert.equal(
    mediaCellState({ ...idleLifecycle, media: "rendered", images: [slice(0, { phase: "failed", error_code: "s3_denied" })] }, "images").label,
    "切片上传未完成 · 请查看媒体步骤并重试上传",
  )
})

test("media roles restore render order and always use slice 1 as the primary image", () => {
  const images = [
    slice(2, { file_name: "SZ-0001-3.jpg", group_name: "细节" }),
    slice(0, { file_name: "SZ-0001-1.jpg", group_name: "主图" }),
    slice(1, { file_name: "SZ-0001-2.jpg", group_name: "细节" }),
  ]

  assert.deepEqual(
    slicesForRole(images, "images").map((image) => image.file_name),
    ["SZ-0001-1.jpg", "SZ-0001-2.jpg", "SZ-0001-3.jpg"],
  )
  assert.deepEqual(
    slicesForRole(images, "primary_image").map((image) => image.file_name),
    ["SZ-0001-1.jpg"],
  )
})

test("a half-delivered media cell reads as in flight, never as delivered", () => {
  // The 7/8 wedge looked finished: the delivered popover wins on any URL, so a
  // green「N 张已就绪」dot sat on a row that still owed a slice.
  const stalled = row(1)
  const halfDelivered: WorkflowProductLifecycle = {
    ...idleLifecycle,
    media: "uploading", image_total: 2, image_completed: 1,
    images: [
      slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" }),
      slice(1, { phase: "uploading" }),
    ],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[stalled]}
      productDrafts={{ [stalled.draftId]: instance(stalled, halfDelivered) }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /1\/2 上传中/)
  assert.doesNotMatch(html, /商品图片：1 张已就绪/)
  assert.match(html, /data-preparation-step="deliver"/)
})

test("a failed slice trades its copy and open controls for 重试, and keeps URL order", () => {
  const partial: WorkflowProductLifecycle = {
    ...idleLifecycle,
    media: "failed", media_failure_stage: "upload", image_total: 3, image_completed: 2,
    images: [
      slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" }),
      slice(1, { phase: "failed", error_code: "media_public_read_failed" }),
      slice(2, { phase: "public_ready", public_url: "https://cdn.example.test/2.jpg" }),
    ],
  }
  const state = mediaCellState(partial, "images")
  // The delivered list is keyed by slice index, so the retry lands the missing
  // URL back between its neighbours instead of appending it.
  assert.deepEqual(state.urls, [
    "https://cdn.example.test/0.jpg",
    "https://cdn.example.test/2.jpg",
  ])

  let retried = 0
  const html = renderToStaticMarkup(
    <MediaDeliveryInspector
      draftId="workflow_instance_1"
      role="images"
      slices={state.slices}
      urls={state.urls}
      onRetryMedia={() => {
        retried += 1
      }}
    />,
  )

  // The undelivered slice has no link, so it offers the only control that helps.
  assert.doesNotMatch(html, /复制第 2 张图片链接/)
  assert.doesNotMatch(html, /在浏览器查看第 2 张图片/)
  assert.match(html, /重试第 2 张图片/)
  const copyFirst = html.indexOf("复制第 1 张图片链接")
  const retry = html.indexOf("重试第 2 张图片")
  const copyThird = html.indexOf("复制第 3 张图片链接")
  assert.ok(copyFirst >= 0 && copyThird >= 0, "delivered siblings keep their controls")
  assert.ok(copyFirst < retry && retry < copyThird, "slices stay in index order")
  assert.equal(retried, 0)
})

test("media columns render all slice chips wrapped across rows instead of showing +N text", () => {
  const target = row(1)
  const eightSlices: WorkflowProductLifecycle = {
    ...idleLifecycle,
    media: "rendered",
    images: Array.from({ length: 8 }, (_, i) => slice(i)),
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[target]}
      productDrafts={{
        [target.draftId]: instance(target, eightSlices),
      }}
      selectedRowIds={new Set()}
    />,
  )

  // The media cell states the count and opens the zoom on demand: a 20px chip
  // still paid for a full-resolution decode, eight times a row.
  assert.doesNotMatch(html, /查看大图 \d+-slice\.jpg/, "no per-slice thumbnail paints in the table")
  assert.match(html, /aria-label="查看大图 商品图片（8 张）"/)
  assert.match(html, /8 切片 · 未上传/)
})

test("delivered public images expose their own public URL in a new tab", () => {
  const urls = ["https://cdn.example.test/first.jpg", "https://cdn.example.test/second.jpg"]
  const html = renderToStaticMarkup(
    <MediaDeliveryInspector
      draftId="row-1"
      role="images"
      slices={[
        ...urls.map((url, index) => slice(index, { phase: "public_ready", public_url: url })),
        slice(2, { phase: "uploading" }),
        slice(3, { phase: "failed" }),
      ]}
      urls={urls}
      onRetryMedia={() => undefined}
    />,
  )
  const links = html.match(/<a\b[^>]*>/g) ?? []
  assert.equal(links.length, urls.length, "unfinished slices have no public link")
  for (const [index, url] of urls.entries()) {
    const link = links.find((item) => item.includes(`aria-label="在浏览器查看第 ${index + 1} 张图片"`))
    assert.ok(link, `missing public link for slice ${index + 1}`)
    assert.ok(link.includes(`href="${url}"`), `slice ${index + 1} must use its own URL`)
    assert.match(link, /target="_blank"/)
    assert.match(link, /rel="noreferrer"/)
  }
  assert.match(html, /上传中/)
  assert.doesNotMatch(buttonMarkup(html, "重试第 4 张图片"), /\sdisabled=/)
})
