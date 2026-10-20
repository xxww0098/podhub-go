/** The card library and card binding: prompts, card actions, copying and card videos. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowVideoMetadata } from "../../src/bindings/commands"
import { CardBindForm } from "../../src/features/workflow/card-bind-form"
import { ListingCardActions } from "../../src/features/workflow/card-library"
import { CardVideoPanel } from "../../src/features/workflow/media/card-video-panel"
import {
  WorkflowScreen,
  copyListingCardTemplate,
  resolveRunnerEntry,
} from "../../src/features/workflow/workflow-screen"
import { cardBindProps } from "./workflow-fixtures"

test("card bind prompt refresh reads provisioned prompts without a local import path", () => {
  const html = renderToStaticMarkup(<CardBindForm {...cardBindProps} />)

  assert.match(html, /aria-label="刷新提示词"/)
  assert.doesNotMatch(html, /aria-label="导入"/)
})

test("local prompt files are imported by path, never through a host picker", () => {
  const bindings = readFileSync(
    new URL("../../src/features/workflow/workflow-actions.ts", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(bindings, /workflowPickPrompt/)
  assert.match(bindings, /workflowImportPromptPath/)
})

test("card video panel stages videos before manual S3 upload", () => {
  const videos: WorkflowVideoMetadata[] = ["one", "two"].map((name, index) => ({
    role: "product",
    origin: "managed_upload",
    file_name: `${name}.mp4`,
    content_type: "video/mp4",
    size_bytes: (index + 1) * 1024 * 1024,
    duration_ms: (index + 8) * 1000,
    public_url: `https://cdn.example.test/${name}.mp4`,
    object_key: `videos/${name}.mp4`,
    content_hash: `sha256:${name}`,
  }))
  const html = renderToStaticMarkup(
    <CardVideoPanel
      videos={videos}
      pendingVideos={[{
        asset_handle: "asset_pending",
        metadata: {
          ...videos[0]!,
          file_name: "pending.mov",
          content_type: "video/quicktime",
          public_url: undefined,
          object_key: undefined,
          content_hash: undefined,
        },
        status: "pending",
      }]}
      poolVideos={[]}
      phase="idle"
      disabled={false}
      onPickVideos={() => undefined}
      onPickPoolVideo={() => undefined}
      onUploadVideos={() => undefined}
      uploadDisabled={false}
      onRemovePendingVideo={() => undefined}
      onRemoveVideo={() => undefined}
    />,
  )
  assert.match(html, /商品视频/)
  assert.match(html, /继续选择/)
  assert.doesNotMatch(html, /拖入此区域/)
  assert.match(html, /待上传 · 1/)
  assert.match(html, /上传视频/)
  assert.match(html, /填写必填项后，点击“上传视频”才会上传到 S3/)
  assert.match(html, /https:\/\/cdn\.example\.test\/one\.mp4/)
  assert.match(html, /https:\/\/cdn\.example\.test\/two\.mp4/)
  assert.equal(html.match(/移除视频/g)?.length, 3)
})

function pendingPanelVideo(status: "uploading" | "certifying", progress: { sent: number; total: number }) {
  return {
    asset_handle: "asset_pending",
    metadata: {
      role: "product" as const,
      origin: "managed_upload" as const,
      file_name: "装饰画.mp4",
      content_type: "video/mp4",
      size_bytes: 12 * 1024 * 1024,
      duration_ms: 48_000,
    },
    status,
    progress,
  }
}

test("a full byte bar during upload reads as 等待确认, not a finished upload", () => {
  const html = renderToStaticMarkup(
    <CardVideoPanel
      videos={[]}
      pendingVideos={[pendingPanelVideo("uploading", {
        sent: 12 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      })]}
      poolVideos={[]}
      phase="uploading"
      disabled={false}
      onPickVideos={() => undefined}
      onPickPoolVideo={() => undefined}
      onUploadVideos={() => undefined}
      uploadDisabled={false}
      onRemovePendingVideo={() => undefined}
      onRemoveVideo={() => undefined}
    />,
  )
  assert.match(html, /等待确认/)
  assert.doesNotMatch(html, /S3 已就绪/)
  assert.match(html, /12 MB \/ 12 MB/)
})

test("certifying after the byte bar still shows 确认中", () => {
  const html = renderToStaticMarkup(
    <CardVideoPanel
      videos={[]}
      pendingVideos={[pendingPanelVideo("certifying", {
        sent: 12 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      })]}
      poolVideos={[]}
      phase="uploading"
      disabled={false}
      onPickVideos={() => undefined}
      onPickPoolVideo={() => undefined}
      onUploadVideos={() => undefined}
      uploadDisabled={false}
      onRemovePendingVideo={() => undefined}
      onRemoveVideo={() => undefined}
    />,
  )
  assert.match(html, /确认中/)
  assert.doesNotMatch(html, /S3 已就绪/)
})

test("the production create-card video picker is wired to the staging flow", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/card-library-host.tsx", import.meta.url),
    "utf8",
  )
  const library = readFileSync(
    new URL("../../src/features/workflow/card-library.tsx", import.meta.url),
    "utf8",
  )

  assert.match(source, /composePendingVideos=\{composePendingVideos\}/)
  assert.match(source, /onPickComposeVideos=\{\(\) => void pickComposeVideos\(\)\}/)
  assert.doesNotMatch(source, /onDropComposeVideoPaths/)
  assert.match(source, /onUploadComposeVideos=\{\(\) => void uploadComposeVideos\(\)\}/)
  assert.match(source, /onRemovePendingComposeVideo=\{removePendingComposeVideo\}/)
  assert.match(source, /const pendingVideos = uploadVideos \? composePendingVideos : \[\]/)
  assert.match(library, /onUploadVideos=\{onUploadComposeVideos\}/)
  assert.match(
    library,
    /disabled=\{!composeLeafChosen \|\| composeBusy \|\| composePendingVideos\.length > 0\}/,
    "确认不得隐式上传待上传视频",
  )
  assert.match(
    library,
    /if \(composePendingVideos\.length > 0\) return/,
    "Enter 提交也不得在待上传视频未走完时建卡",
  )
  assert.match(
    source,
    /target_store_id: composeStoreId,\s+ai_allowed_field_keys: \[\],/,
    "new cards must let the Rust workflow derive the canonical AI Field Policy",
  )
})

test("workflow library starts as an empty listing-card surface, not an expanded form", () => {
  const html = renderToStaticMarkup(<WorkflowScreen />)
  assert.match(html, /上架方案/)
  assert.match(html, /data-listing-library-skeleton/)
  assert.match(html, /正在加载上架方案/)
  assert.doesNotMatch(html, /还没有上架方案/)
  assert.doesNotMatch(html, /创建第一个上架方案/)
  assert.doesNotMatch(html, /aria-label="刷新上架方案"/)
  assert.doesNotMatch(html, /商品基础信息/)
  assert.doesNotMatch(html, /workflow \/ card/)
  assert.doesNotMatch(html, /创建并进入上架/)
  assert.doesNotMatch(html, /ErrorAlert|WORKFLOW/)
})

test("refreshing into a cardId URL restores behind a spinner, not a library flash", () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?screen=listing&cardId=55c354ac" } },
    writable: true,
  })
  try {
    const html = renderToStaticMarkup(<WorkflowScreen />)
    assert.match(html, /aria-label="正在恢复上架方案"/)
    assert.doesNotMatch(html, /去平台货源选品/)
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window")
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    }
  }
})

test("listing cards expose a clear primary action and an accessible copy action", () => {
  const html = renderToStaticMarkup(
    <ListingCardActions
      title="装饰画模板"
      busy={false}
      dimmed={false}
      copying={false}
      onRun={() => undefined}
      onCopy={() => undefined}
      onDelete={() => undefined}
    />,
  )

  assert.match(html, /aria-label="上架 装饰画模板"/)
  assert.match(html, /aria-label="复制 装饰画模板"/)
  assert.doesNotMatch(html, /aria-label="编辑 装饰画模板"/)
  assert.match(html, /aria-label="删除 装饰画模板"/)
})

test("a card with videos still uploading locks its 上架 / 复制 / 删除 actions", () => {
  const html = renderToStaticMarkup(
    <ListingCardActions
      title="装饰画模板"
      busy
      dimmed={false}
      copying={false}
      onRun={() => undefined}
      onCopy={() => undefined}
      onDelete={() => undefined}
    />,
  )

  for (const action of ["上架", "复制", "删除"]) {
    const button = html.slice(0, html.indexOf(`aria-label="${action} 装饰画模板"`))
    assert.match(button.slice(button.lastIndexOf("<button")), /disabled=""/)
  }
})

test("reopening a card edits that card's own durable category draft", async () => {
  const card = {
    draft_id: "workflow_template_card_1",
    kind: "template" as const,
    draft: {
      values: { price: { kind: "decimal" as const, value: 90 } },
      complex_values: [],
    },
  } as unknown as import("../../src/bindings/commands").WorkflowDraftView
  const opened = resolveRunnerEntry(card)

  assert.equal(opened, card)
  assert.deepEqual(opened.draft.values.price, { kind: "decimal", value: 90 })
})

test("copying a listing card requires a new independent template", async () => {
  const calls: string[] = []
  const copy = async (draftId: string) => {
    calls.push(draftId)
    return {
      draft_id: "workflow_template_copy_1",
      kind: "template" as const,
      display_name: "装饰画模板 · 副本",
    } as unknown as import("../../src/bindings/commands").WorkflowDraftView
  }

  const copied = await copyListingCardTemplate("workflow_template_card_1", copy)
  assert.equal(copied.kind, "template")
  assert.equal(copied.display_name, "装饰画模板 · 副本")
  assert.deepEqual(calls, ["workflow_template_card_1"])

  await assert.rejects(
    () => copyListingCardTemplate("workflow_template_card_1", async () => ({
      draft_id: "workflow_instance_1",
      kind: "instance" as const,
      parent_card_id: "workflow_template_card_1",
    } as unknown as import("../../src/bindings/commands").WorkflowDraftView)),
    /无法打开这个上架方案/,
  )
})

test("card bind dialog keeps video as a dedicated side region", () => {
  const dialogSource = readFileSync(
    new URL("../../src/features/workflow/card-bind-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(dialogSource, /videoPanel/)
  assert.match(dialogSource, /sm:max-w-5xl/)
  assert.doesNotMatch(dialogSource, /展开视频面板/)

  const formHtml = renderToStaticMarkup(<CardBindForm {...cardBindProps} />)
  assert.doesNotMatch(formHtml, /商品视频/)
  assert.doesNotMatch(formHtml, /已添加 1 个视频/)
})
