import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { NO_PREPARATION_PROGRESS } from "../prepare/preparation-tracks"
import { FieldWorkbench } from "./field-workbench"
import {
  idleLifecycle,
  instance,
  readyToPublish,
  row,
  schema,
  slice,
} from "./workbench-test-fixtures"
import { buttonMarkup, workbenchProps } from "./workbench-test-harness"

// ---------------------------------------------------------------------------
// The rendered table
// ---------------------------------------------------------------------------

test("核对筛选在有未知导入时出现，普通行不出现", () => {
  const checking = row(1, { stage: "outcome_unknown", status: "exception", imageName: "checking.png" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[checking]}
      productDrafts={{
        [checking.draftId]: instance(checking, { ...idleLifecycle, stage: "outcome_unknown" }),
      }}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(html, /aria-label="核对状态筛选"/)
  assert.match(html, /核对中 1/)
  assert.match(html, /需人工核对 0/)
  const ready = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[row(2)]}
      productDrafts={{}}
      selectedRowIds={new Set()}
    />,
  )
  assert.doesNotMatch(ready, /核对状态筛选/)
})

test("the empty runner lists only source-image formats the browser accepts", () => {
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[]}
      productDrafts={{}}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, />JPG \/ PNG</)
  assert.doesNotMatch(html, />WEBP</)
  assert.doesNotMatch(html, />PSD</)
})

test("a running one-click preparation replaces Prepare with an immediate Stop", () => {
  const target = row(1, { status: "running", ai: "running", render: "running" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[target]}
      productDrafts={{
        [target.draftId]: instance(target, {
          ...idleLifecycle,
          stage: "rendering",
          ai: "running",
          media: "rendering",
        }),
      }}
      selectedRowIds={new Set([target.id])}
      guidedPreparation={{
        active: true,
        total: 1,
        rowIds: [target.id],
        stopRequested: false,
      }}
    />,
  )

  const stop = buttonMarkup(html, "停止准备（1）")
  assert.match(stop, /lucide-square/)
  assert.match(stop, /<span class="tabular-nums">1<\/span>/)
  assert.doesNotMatch(stop, /\sdisabled=""/)
  assert.doesNotMatch(html, /识别与切片中，共 1 个商品/)
  // The publish cell names the leg the row is on: the badge is the stage.
  assert.match(html, />识别中</)
  assert.doesNotMatch(html, />仍需准备</)
})

test("a running publish queue replaces Send with the real pause control", () => {
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[row(1, { status: "running" })]}
      productDrafts={{}}
      selectedRowIds={new Set()}
      queueRunning
    />,
  )

  assert.match(html, /aria-label="暂停发送队列"/)
  assert.doesNotMatch(html, /aria-label="全部发送/)
})

test("the table offers 全部发送 only the rows Cloud would admit", () => {
  const ready = row(1, { status: "ready", readiness: readyToPublish })
  const unready = row(2)
  const delivered: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "ready_to_publish",
    media: "ready",
    images: [
      slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" }),
      slice(1, {
        group_name: "颜色",
        phase: "public_ready",
        public_url: "https://cdn.example.test/1.jpg",
      }),
    ],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[ready, unready]}
      productDrafts={{
        [ready.draftId]: instance(ready, delivered),
        [unready.draftId]: instance(unready),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /aria-label="全部发送（1）到 测试店铺"/)
  assert.match(html, /全部发送（1）/, "the visible label carries the count (WCAG 2.5.3)")
  assert.doesNotMatch(html, /共 2 行 · 识别 0\/2 · 媒体 1\/2 · 已上架 0\/2 · 异常 0/)
  assert.match(html, /aria-label="一键准备（2）"/)
  assert.match(html, /data-preparation-step="ai" data-state="idle"/)
  assert.match(html, /data-preparation-step="render" data-state="idle"/)
  assert.match(html, /data-preparation-step="deliver" data-state="idle"/)
  // An idle strip has nothing to repeat yet, so it exposes no retry control.
  assert.doesNotMatch(html, /aria-label="重试/)
  assert.doesNotMatch(html, /aria-label="分步准备操作"/)
  // A colour group name reached the colour column rather than the full set.
  assert.match(html, /aria-label="商品图片：2 张已就绪/)
  assert.match(html, /aria-label="颜色样本：1 张已就绪/)
  assert.match(html, /无 360° 切片/)
  assert.match(html, />可发送</)
  assert.match(html, />待导入</)
  assert.match(html, /未切片/)
  // The cell opens the zoom on demand; the Public Media URL is read there, not
  // painted into every mounted row.
  assert.doesNotMatch(html, /src="https:\/\/cdn\.example\.test\/0\.jpg"/)
  assert.match(html, /aria-label="查看大图 商品图片（2 张）"/)
})

test("a conflicted row can be sent again after the queue pauses", () => {
  const failed = row(1, {
    status: "failed",
    readiness: {
      ready_to_publish: false, can_start_publish_attempt: true,
      blockers: [],
      allowed_actions: ["publish"],
    },
  })
  const conflicted: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "publish_rejected",
    ai: "ready",
    media: "ready",
    fields: "valid",
    last_error_code: "OZON_RECONCILE_CONFLICT",
    last_error_detail:
      "Ozon 导入任务失败：currency_differs_from_contract (currency)",
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[failed]}
      productDrafts={{ [failed.draftId]: instance(failed, conflicted) }}
      queuePaused
      queueRunning={false}
      selectedRowIds={new Set([failed.id])}
    />,
  )
  const send = buttonMarkup(html, "发送选中（1）到 测试店铺")
  // The ribbon soft-disables, so「可点」is the absence of both markers rather
  // than the absence of the native attribute alone.
  assert.doesNotMatch(send, /data-disabled|aria-disabled="true"|\sdisabled="/)
  assert.doesNotMatch(buttonMarkup(html, "默认字段"), /\bdisabled(?:=|\s|$)/)
})

test("a paused queue projects one status button in the workbench toolbar", () => {
  const html = renderToStaticMarkup(
    <FieldWorkbench {...workbenchProps} schema={schema} rows={[]}
      productDrafts={{}} selectedRowIds={new Set()} queuePaused />,
  )
  assert.equal((html.match(/data-toolbar-slot="live-status"/g) ?? []).length, 1)
  assert.match(buttonMarkup(html, "运行状态：发送队列已暂停"), /发送队列已暂停/)
})

test("completed batches keep exact failures available for one-click retry", () => {
  const rows = [row(1), row(2), row(3)]
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={rows}
      productDrafts={Object.fromEntries(rows.map((entry) => [entry.draftId, instance(entry)]))}
      preparationProgress={{
        ...NO_PREPARATION_PROGRESS,
        ai: {
          total: 3,
          settled: 3,
          failed: 2,
          failedRowIds: [rows[2]!.id, rows[0]!.id],
          active: false,
        },
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.doesNotMatch(html, /AI 识别：1 成功 · 2 失败/)
  assert.doesNotMatch(html, /最近批次/)
})

test("发送选中 scopes the same Cloud gate to the ticked rows", () => {
  const ready = row(1, { status: "ready", readiness: readyToPublish })
  const alsoReady = row(2, { status: "ready", readiness: readyToPublish })
  const unready = row(3)
  const rows = [ready, alsoReady, unready]
  const drafts = Object.fromEntries(
    rows.map((entry) => [
      entry.draftId,
      instance(entry, entry === unready ? idleLifecycle : { ...idleLifecycle, stage: "ready_to_publish" }),
    ]),
  )
  const render = (selected: ReadonlySet<string>) =>
    renderToStaticMarkup(
      <FieldWorkbench
        {...workbenchProps}
        schema={schema}
        rows={rows}
        productDrafts={drafts}
        selectedRowIds={selected}
      />,
    )

  // Nothing ticked: the ribbon sends every admitted row.
  const untouched = render(new Set())
  assert.match(untouched, /aria-label="清空生成内容（3）"/)
  // The counts on every verb are scope counts, so the scope itself is named:
  // without this chip a ribbon of numbers next to an empty checkbox column
  // reads as a selection nobody made.
  assert.match(untouched, />全部 3</)
  assert.match(untouched, /aria-label="全部发送（2）到 测试店铺"/)
  assert.doesNotMatch(
    untouched,
    /发送选中|aria-label="删除所选|aria-label="取消选择"/,
  )
  assert.equal((untouched.match(/data-slot="workbench-action-ribbon"/g) ?? []).length, 1)

  // Ticking expands the selection group only as far as the visible Delete and
  // 型号 buttons. Cancel stays in the scope menu and Send keeps the right edge.
  const picked = render(new Set(["row-2", "row-3"]))
  assert.match(picked, /aria-label="清空生成内容（2）"/)
  assert.match(picked, />已选 2</)
  assert.match(picked, /aria-label="发送选中（1）到 测试店铺"/)
  assert.match(picked, />发送 1</)
  assert.doesNotMatch(picked, /aria-label="全部发送（2）到 测试店铺"/)
  assert.match(picked, /aria-label="准备选中（2）"/)
  assert.match(picked, /aria-label="删除所选 2 张图片"/)
  assert.match(picked, />删除</)
  // 型号 is a batch verb over the same ticked rows; it has no unselected scope.
  assert.match(picked, /aria-label="设置所选 2 行的型号"/)
  assert.doesNotMatch(untouched, /aria-label="设置所选/)
  assert.equal((picked.match(/data-slot="workbench-action-ribbon"/g) ?? []).length, 1)
  assert.equal((picked.match(/h-8 w-full min-w-0 px-2 text-xs/g) ?? []).length > 5, true)
  for (const slot of ["selection", "media", "prepare", "publish"]) {
    assert.equal(
      (untouched.match(new RegExp(`data-toolbar-slot="${slot}"`, "g")) ?? []).length,
      1,
    )
    assert.equal(
      (picked.match(new RegExp(`data-toolbar-slot="${slot}"`, "g")) ?? []).length,
      1,
    )
  }
  assert.doesNotMatch(untouched, /data-toolbar-slot="selection-actions"/)
  assert.doesNotMatch(picked, /data-toolbar-slot="selection-actions"/)
  assert.match(untouched, /data-toolbar-slot="selection"[^>]*grid w-\[84px\]/)
  assert.match(picked, /data-toolbar-slot="selection"[^>]*grid[^>]*w-\[212px\]/)
  assert.match(untouched, /data-toolbar-slot="media"[^>]*grid w-\[174px\]/)
  assert.match(picked, /data-toolbar-slot="media"[^>]*grid w-\[174px\]/)
  const prepareMarkup = untouched.slice(
    untouched.indexOf('data-toolbar-slot="prepare"'),
    untouched.indexOf('data-toolbar-slot="publish"'),
  )
  assert.match(prepareMarkup, /aria-label="清空生成内容（3）"/)
  assert.match(prepareMarkup, /data-toolbar-slot="prepare"[^>]*grid w-\[256px\]/)
  assert.doesNotMatch(
    untouched.slice(
      untouched.indexOf('data-toolbar-slot="media"'),
      untouched.indexOf('data-toolbar-slot="prepare"'),
    ),
    /aria-label="清空生成内容/,
  )

  // The ribbon owns the selection menu and the publish group since the
  // workbench split; the source order checks read it there.
  const source = readFileSync(new URL("./workbench-ribbon.tsx", import.meta.url), "utf8")
  const selectionMenu = source.slice(
    source.indexOf("<DropdownMenuContent"),
    source.indexOf("</DropdownMenuContent>"),
  )
  assert.match(selectionMenu, />\s*取消选择\s*</)
  assert.doesNotMatch(selectionMenu, /删除所选/)
  const publish = source.slice(
    source.indexOf('data-toolbar-slot="publish"'),
    source.indexOf("</div>", source.indexOf('data-toolbar-slot="publish"')),
  )
  assert.ok(
    publish.indexOf('aria-label={') < publish.indexOf("<SendAllButton"),
    "secondary stock action precedes the irreversible Send action",
  )

  // A ticked set with nothing publishable in it offers no send at all.
  const unsendable = render(new Set(["row-3"]))
  assert.match(unsendable, />已选 1</)
  const start = unsendable.lastIndexOf(
    "<button",
    unsendable.indexOf('aria-label="发送选中（0）到 测试店铺"'),
  )
  assert.match(
    unsendable.slice(start, unsendable.indexOf(">", start)),
    /\bdisabled(?:=|\s|$)/,
  )
})

test("a supplier softlink card drops the 默认字段 track instead of disabling it", () => {
  const target = row(1, { status: "pending" })
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      <FieldWorkbench
        {...workbenchProps}
        {...props}
        schema={schema}
        rows={[target]}
        productDrafts={{ [target.draftId]: instance(target) }}
        selectedRowIds={new Set([target.id])}
      />,
    )

  const editable = render({ supplierBound: false })
  assert.match(editable, /aria-label="默认字段"/)
  assert.match(editable, /data-toolbar-slot="media"[^>]*grid w-\[174px\]/)

  // The online supplier config owns those defaults and `updateCardDefault` is a
  // no-op there, so the control leaves the ribbon and its track leaves with it
  // — the grid names one track per child, which is why the width changes too.
  const bound = render({ supplierBound: true })
  assert.doesNotMatch(bound, /aria-label="默认字段"|默认字段由在线商库维护/)
  assert.match(bound, /aria-label="导入图片"/)
  assert.match(bound, /aria-label="清空生成内容（1）"/)
  assert.match(
    bound,
    /data-toolbar-slot="media"[^>]*w-\[88px\] shrink-0 grid-cols-\[84px\]/,
  )
  assert.match(
    render({ supplierBound: true, targetStoreId: "store-1,store-2" }),
    /data-toolbar-slot="media"[^>]*w-\[194px\][^"]*grid-cols-\[84px_104px\]/,
  )
})

test("selected rows stay deletable regardless of send or preparation", () => {
  const target = row(1, { status: "running", ai: "running", render: "running" })
  const scenarios = [
    { name: "row running", props: {} },
    { name: "busy", props: { busy: true } },
    { name: "sending", props: { queueRunning: true } },
    { name: "paused", props: { queuePaused: true } },
    {
      name: "preparing",
      props: {
        activity: { ai: new Set([target.id]), render: new Set([target.id]), deliver: new Set<string>() },
        guidedPreparation: { active: true, total: 1, rowIds: [target.id], stopRequested: false },
      },
    },
  ]
  for (const { name, props } of scenarios) {
    const html = renderToStaticMarkup(
      <FieldWorkbench
        {...workbenchProps}
        {...props}
        schema={schema}
        rows={[target]}
        productDrafts={{ [target.draftId]: instance(target) }}
        selectedRowIds={new Set([target.id])}
      />,
    )
    const button = buttonMarkup(html, "删除所选 1 张图片")
    assert.doesNotMatch(button, /(?:\sdisabled(?:=|\s|>)|aria-disabled="true")/, name)
  }
})

test("the ribbon omits post-submit stock and promotion operations", () => {
  const listed = row(1, { status: "sent" })
  const pending = row(2)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[listed, pending]}
      productDrafts={{
        [listed.draftId]: instance(listed, {
          ...idleLifecycle,
          stage: "accepted",
          ozon_sku: 123456789,
          ozon_product_id: 11,
        }),
        [pending.draftId]: instance(pending),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.doesNotMatch(html, /设置库存|活动折扣|库存待上架|折扣待上架/)

  const empty = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[pending]}
      productDrafts={{ [pending.draftId]: instance(pending) }}
      selectedRowIds={new Set()}
    />,
  )
  assert.doesNotMatch(empty, /设置库存|活动折扣|库存待上架|折扣待上架/)
})

test("ready workbench SSR labels the complete send cohort and Store", () => {
  const ready = row(1, { status: "ready", readiness: readyToPublish })
  const delivered: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "ready_to_publish",
    media: "ready",
    images: [
      slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" }),
    ],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[ready]}
      productDrafts={{
        [ready.draftId]: instance(ready, delivered),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /aria-label="全部发送（1）到 测试店铺"/)


})

test("workbench restores stock editing and disables it during active work", () => {
  for (const busy of [false, true]) {
    const html = renderToStaticMarkup(
      <FieldWorkbench {...workbenchProps} schema={schema} rows={[]}
        productDrafts={{}} selectedRowIds={new Set()} busy={busy} />,
    )
    const button = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<span>改库存<\/span><\/button>/)?.[0]
    assert.ok(button, "stock dialog must remain reachable from the workbench")
    assert.equal(button.includes('disabled=""'), busy)
  }
})
