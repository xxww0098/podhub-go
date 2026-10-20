/** The rendered batch workbench: its columns, batch verbs, scopes and queue locks. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "../../src/bindings/commands"
import type { ListingRow } from "../../src/features/workflow/model/listing-row"
import { FieldWorkbench } from "../../src/features/workflow/workbench/field-workbench"
import {
  READS_DISABLED,
  workbenchDrafts,
  workbenchHandlers,
  workbenchSchema,
} from "./workflow-fixtures"

test("the workbench carries every publishable field as its own column and every batch verb once", () => {
  const rows: ListingRow[] = ["one.png", "two.png"].map((imageName, index) => ({
    id: `row-${index}`,
    draftId: `draft-${index}`,
    imageName,
    status: "ready",
    ai: "done",
    render: "done",
    upload: "done",
    log: "ready",
    readiness: {
      ready_to_publish: false,
      can_start_publish_attempt: true,
      blockers: ["fields_dirty"],
      allowed_actions: ["edit_fields", "publish"],
    },
  }))
  const lifecycle: WorkflowProductLifecycle = {
    revision: 9,
    view_revision: 9,
    stage: "build_stale",
    ai: "ready",
    media: "ready",
    image_total: 7, image_completed: 7,
    fields: "dirty",
    product_videos: [],
    failure_log: [],
    images: Array.from({ length: 7 }, (_, index) => ({
      index,
      file_name: `${String(index + 1).padStart(2, "0")}-slice.jpg`,
      content_hash: `hash-${index}`,
      group_name: `group-${index + 1}`,
      width: 900,
      height: 1200,
      phase: "public_ready" as const,
      public_url: `https://example.test/${index}.jpg`,
    })),
    ai_candidates: [],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchHandlers}
      schema={workbenchSchema}
      rows={rows}
      productDrafts={workbenchDrafts(rows, lifecycle)}
      queuePaused={false}
      queueRunning={false}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(html, /data-slot="table"/)
  assert.equal(
    html.match(/data-slot="table-head"/g)?.length,
    16,
    "selection plus the fifteen fields a row carries to Ozon; a value with no column is a value nobody checks",
  )
  for (const column of [
    "原图",
    "名称",
    "货号",
    "型号",
    "销售价",
    "划线价",
    "简介",
    "搜索标签",
    "主题",
    "JSON富内容",
    "商品图片",
    "360° 图片",
    "主图",
    "颜色样本",
    "发布状态",
  ]) {
    assert.match(html, new RegExp(`>${column}<`), `missing the ${column} column`)
  }

  // Selection, the prose cells and the two price inputs are per row; identity and
  // media are read only, because Rust re-injects the first and delivery owns the second.
  assert.match(html, /aria-label="选择全部商品"/)
  assert.equal(html.match(/aria-label="选择 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="商品名称 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="商品简介 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="搜索标签 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="JSON富内容 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="主题 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="销售价 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="划线价 /g)?.length, rows.length)
  assert.match(html, />画 one\.png</)
  assert.match(html, /简介 one\.png/)
  assert.match(html, />one</, "the Offer ID is shown as text, never as an input")
  assert.doesNotMatch(html, /aria-label="商品货号|aria-label="型号名称/)
  // 货号 and 型号 are one cell each: the instance identity stays read-only text
  // (Rust re-injects the file stem into it) while 型号 carries the operator's own
  // answer and opens its editor.
  assert.equal(html.match(/aria-label="货号 /g)?.length, rows.length)
  assert.equal(html.match(/aria-label="型号 /g)?.length, rows.length)
  // The row action column is gone: a verb that acts on one row is the same verb
  // scoped to one ticked row, and two spellings of it drift.
  assert.doesNotMatch(html, /重新渲染并上传|重新 AI 识别|发送当前商品|删除当前商品/)

  // A media column states its count and opens the zoom on demand; no slice
  // picture paints in the table, delivered or not — eight 20px thumbnails per
  // row would each decode a full-resolution slice.
  assert.doesNotMatch(html, /<img/, "a workbench row paints no slice thumbnail")
  assert.doesNotMatch(html, /example\.test\/0\.jpg/, "the Public Media URL is not dumped as markup")
  assert.match(html, /aria-label="查看大图 商品图片（7 张）"/)
  assert.match(html, /aria-label="查看大图 主图（1 张）"/)
  // No group name here says 360, so 360 is honestly empty rather than borrowing
  // the full set. 颜色样本 and 主图 both use the first slice.
  assert.match(html, /无 360° 切片/)

  // A stale build stamp is not a failure: the row is prepared and send restamps,
  // so the column reads the same as 可发送.
  assert.match(html, />可发送</)
  assert.match(html, /可以发送/)
  assert.doesNotMatch(html, /构建过期/)
  assert.match(html, /bg-st-flight/)

  assert.match(html, /aria-label="商品批量操作"/)
  assert.doesNotMatch(html, /共 2 行 · 识别 2\/2 · 媒体 2\/2 · 已上架 0\/2 · 异常 0/)
  assert.match(html, /aria-label="导入图片"/)
  assert.match(html, /aria-label="默认字段"/)
  assert.doesNotMatch(html, /aria-label="PSD 与提示词"/)
  // Every lane is already ready, so guided preparation has no work to repeat.
  const uploadStart = html.lastIndexOf("<button", html.indexOf('aria-label="一键准备（0）"'))
  assert.match(
    html.slice(uploadStart, html.indexOf(">", uploadStart)),
    READS_DISABLED,
    "rows whose slices are all public_ready must not be offered upload again",
  )

  // 全部发送 is the one control that starts an external effect, and its count is
  // the whole point of the click: a labelled button whose visible text is part of
  // its accessible name (WCAG 2.5.3), never a bare icon.
  const sendAllLabel = html.indexOf('aria-label="全部发送（2）到 测试店铺"')
  assert.notEqual(sendAllLabel, -1, "the send-all button names its count and its store")
  const sendAllStart = html.lastIndexOf("<button", sendAllLabel)
  const sendAllEnd = html.indexOf(">", sendAllStart)
  assert.doesNotMatch(html.slice(sendAllStart, sendAllEnd), READS_DISABLED)
  const sendAllButtonEnd = html.indexOf("</button>", sendAllStart)
  assert.match(html.slice(sendAllStart, sendAllButtonEnd), /<svg/)
  assert.match(html.slice(sendAllStart, sendAllButtonEnd), /全部发送（2）/)

  const retryHtml = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchHandlers}
      schema={workbenchSchema}
      rows={[{
        ...rows[0]!,
        status: "failed",
        log: "",
        readiness: {
          
          ready_to_publish: false,
          can_start_publish_attempt: true,
          blockers: ["publish_rejected"],
          allowed_actions: ["edit_fields", "publish"],
        },
      }]}
      productDrafts={workbenchDrafts([{
        ...rows[0]!,
        status: "failed",
        log: "",
        readiness: {
          
          ready_to_publish: false,
          can_start_publish_attempt: true,
          blockers: ["publish_rejected"],
          allowed_actions: ["edit_fields", "publish"],
        },
      }], { ...lifecycle, stage: "publish_rejected" })}
      queuePaused={false}
      queueRunning={false}
      selectedRowIds={new Set()}
    />,
  )
  // `rejected` is a re-editable terminal, not a sealed one: the row reads as an
  // exception in the failure hue and is still offered to the send button.
  assert.match(retryHtml, />发送未完成</)
  assert.match(retryHtml, /bg-st-bad/)
  assert.match(retryHtml, /发布未成功|需要处理/)
  const retryAllLabel = retryHtml.indexOf('aria-label="全部发送（1）到 测试店铺"')
  assert.notEqual(retryAllLabel, -1)
  const retryAllStart = retryHtml.lastIndexOf("<button", retryAllLabel)
  const retryAllEnd = retryHtml.indexOf(">", retryAllStart)
  assert.doesNotMatch(retryHtml.slice(retryAllStart, retryAllEnd), READS_DISABLED)
  const retryNameLabel = retryHtml.indexOf('aria-label="商品名称 one.png"')
  const retryNameStart = retryHtml.lastIndexOf("<button", retryNameLabel)
  assert.doesNotMatch(
    retryHtml.slice(retryNameStart, retryHtml.indexOf(">", retryNameStart)),
    /\bdisabled(?:=|\s|$)/,
    "a rejected row must stay editable — that is how the operator fixes it",
  )

  const blockedHtml = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchHandlers}
      schema={workbenchSchema}
      rows={[rows[0]!, {
        ...rows[1]!,
        status: "pending",
        ai: "idle",
        render: "idle",
        upload: "idle",
        source: { handle: "pending-source", file_name: "two.png" },
        readiness: {
          
          ready_to_publish: false,
          can_start_publish_attempt: false,
          blockers: ["ai_pending", "media_pending", "fields_dirty"],
          allowed_actions: ["prepare", "edit_fields"],
        },
      }]}
      productDrafts={{
        ...workbenchDrafts([rows[0]!], lifecycle),
        ...workbenchDrafts([{ ...rows[1]!, source: { handle: "pending-source", file_name: "two.png" } }]),
      }}
      queuePaused={false}
      queueRunning={false}
      selectedRowIds={new Set()}
    />,
  )
  // Two rows, one of them still unprepared: the send count is Cloud's own
  // gate, so the unready row is skipped rather than dispatched and refused.
  const blockedLabel = blockedHtml.indexOf('aria-label="全部发送（1）到 测试店铺"')
  assert.notEqual(blockedLabel, -1, "全部发送 counts only rows Cloud admits")
  const blockedStart = blockedHtml.lastIndexOf("<button", blockedLabel)
  const blockedEnd = blockedHtml.indexOf(">", blockedStart)
  assert.doesNotMatch(blockedHtml.slice(blockedStart, blockedEnd), READS_DISABLED)
  // The unprepared row is exactly the one guided preparation is offered for;
  // recognition and slicing are independently available.
  assert.match(blockedHtml, /aria-label="一键准备（1）"/)
  assert.match(blockedHtml, /aria-label="识别（1）"/)
  assert.match(blockedHtml, /aria-label="切片（1）"/)
  assert.doesNotMatch(blockedHtml, /aria-label="分步准备操作"/)
  assert.doesNotMatch(html, /确认发送/)
  assert.doesNotMatch(html, /最终上架|单独上架页|选择店铺/)

  // A locked queue disables nearly every control here, so the lock has to name
  // itself and carry the one action that clears it — never a bare dead toolbar.
  const unknownRow: ListingRow = {
    ...rows[0]!,
    imageName: "SZ-9BXIE0611-0015.jpg",
    status: "running",
    readiness: {
      ready_to_publish: false,
      can_start_publish_attempt: false,
      blockers: ["outcome_unknown"],
      allowed_actions: ["reconcile"],
    },
  }
  const pausedHtml = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchHandlers}
      schema={workbenchSchema}
      rows={[unknownRow]}
      productDrafts={workbenchDrafts([unknownRow], lifecycle)}
      queuePaused={true}
      queueRunning={false}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(pausedHtml, /aria-label="运行状态：发送队列已暂停"/)

  const runningHtml = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchHandlers}
      schema={workbenchSchema}
      rows={[unknownRow]}
      productDrafts={workbenchDrafts([unknownRow], lifecycle)}
      queuePaused={false}
      queueRunning={true}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(runningHtml, /aria-label="运行状态：发送队列进行中"/)

  assert.doesNotMatch(html, /发送队列已暂停|发送队列进行中/)
})

test("an imported image waits for the operator before any AI request or slice", () => {
  const imported: ListingRow[] = ["one.png", "two.png"].map((imageName, index) => ({
    id: `row-${index}`,
    draftId: `draft-${index}`,
    imageName,
    source: { handle: `handle-${index}`, file_name: imageName },
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "已导入，等待确认后开始准备",
    readiness: {
      
      ready_to_publish: false,
      can_start_publish_attempt: false,
      blockers: ["ai_pending", "media_pending", "fields_dirty"],
      allowed_actions: ["prepare", "edit_fields"],
    },
  }))
  const renderWorkspace = (selectedRowIds: ReadonlySet<string>) =>
    renderToStaticMarkup(
      <FieldWorkbench
        {...workbenchHandlers}
        schema={workbenchSchema}
        rows={imported}
        productDrafts={workbenchDrafts(imported, undefined)}
        queuePaused={false}
        queueRunning={false}
        selectedRowIds={selectedRowIds}
      />,
    )

  // Nothing ticked: every verb reads as an offer, not as work already in flight.
  const untouched = renderWorkspace(new Set())
  assert.match(untouched, /等待确认后开始准备/)
  assert.doesNotMatch(untouched, /正在自动准备|正在准备/)
  assert.doesNotMatch(untouched, /AI 正在生成商品名称/, "no recognition may be running")
  assert.match(untouched, /未切片/, "nothing was rendered on import")
  assert.match(untouched, />待导入</)

  // Preparation and independent slicing are reachable once an image lands.
  const enabled = (html: string, label: string) => {
    const index = html.indexOf(`aria-label="${label}"`)
    assert.notEqual(index, -1, `missing ${label}`)
    const start = html.lastIndexOf("<button", index)
    assert.doesNotMatch(
      html.slice(start, html.indexOf(">", start)),
      READS_DISABLED,
      `${label} must be reachable`,
    )
  }
  enabled(untouched, "一键准备（2）")
  enabled(untouched, "识别（2）")
  enabled(untouched, "切片（2）")
  assert.match(untouched, /aria-label="上传：未开始"/)

  // Sending has nothing to act on yet and is unavailable before the Cloud gate.
  for (const label of ["全部发送（0）到 测试店铺"]) {
    const index = untouched.indexOf(`aria-label="${label}"`)
    assert.notEqual(index, -1, `missing ${label}`)
    const start = untouched.lastIndexOf("<button", index)
    const markup = untouched.slice(start, untouched.indexOf(">", start))
    assert.match(
      markup,
      READS_DISABLED,
      `${label} must not be offered before there is anything to act on`,
    )
    // Still hoverable and tabbable: `<button disabled>` takes no pointer
    // events, and the tooltip explaining the 0 would never open.
    assert.match(markup, /tabindex="0"/, `${label} must stay reachable to explain itself`)
  }
  assert.doesNotMatch(untouched, /aria-label="删除所选|aria-label="取消选择"/)

  // Ticked rows scope the guided path. Delete remains visible beside the scope;
  // Cancel stays in the menu and Send keeps the right edge.
  const picked = renderWorkspace(new Set(["row-1"]))
  enabled(picked, "准备选中（1）")
  enabled(picked, "识别（1）")
  enabled(picked, "切片（1）")
  assert.match(picked, />已选 1</)
  assert.match(picked, /aria-label="删除所选 1 张图片"/)
  assert.equal((picked.match(/data-slot="workbench-action-ribbon"/g) ?? []).length, 1)

  // The selection menu lives in the ribbon that renders it.
  const source = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-ribbon.tsx", import.meta.url),
    "utf8",
  )
  const menu = source.slice(
    source.indexOf("<DropdownMenuContent"),
    source.indexOf("</DropdownMenuContent>"),
  )
  assert.match(menu, />\s*取消选择\s*</)
  assert.doesNotMatch(menu, /删除所选/)
})
