import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FieldWorkbench } from "./field-workbench"
import { batchSelectionScopes } from "./workbench-contract"
import { idleLifecycle, instance, readyToPublish, row, schema } from "./workbench-test-fixtures"
import { workbenchProps } from "./workbench-test-harness"

test("multi-store rows keep one switchable colour across quota, row and status", () => {
  const first = row(1)
  const second = row(2)
  const firstProduct = { ...instance(first), target_store_id: "store-a" }
  const secondProduct = { ...instance(second), target_store_id: "store-b" }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[first, second]}
      productDrafts={{
        [first.draftId]: firstProduct,
        [second.draftId]: secondProduct,
      }}
      targetStoreId="store-a,store-b"
      storeLabel="2 个店铺"
      selectedRowIds={new Set([second.id])}
    />,
  )

  assert.equal((html.match(/store-assignment-row/g) ?? []).length, 2)
  assert.match(
    html,
    /style="--store-tone:var\(--store-blue\);--store-tone-ink:var\(--store-blue-ink\)"/,
  )
  assert.match(
    html,
    /data-state="selected" style="--store-tone:var\(--store-amber\);--store-tone-ink:var\(--store-amber-ink\)"/,
    "selection must strengthen Store B's colour instead of replacing it with generic blue",
  )
  assert.match(html, /aria-label="目标店铺：store-a"/)
  assert.match(html, /aria-label="目标店铺：store-b"/)
  assert.equal((html.match(/store-assignment-badge/g) ?? []).length, 2)

  const firstStoreIndex = html.indexOf('aria-label="目标店铺：store-a"')
  const firstOfferIndex = html.indexOf(">SZ-0001</span>")
  const firstStoreCell = html.slice(
    html.lastIndexOf("<td", firstStoreIndex),
    html.indexOf("</td>", firstStoreIndex),
  )
  const firstOfferCell = html.slice(
    html.lastIndexOf("<td", firstOfferIndex),
    html.indexOf("</td>", firstOfferIndex),
  )
  assert.match(firstStoreCell, />待导入</)
  assert.doesNotMatch(firstOfferCell, /目标店铺|store-assignment-badge/)
})

test("status selection scopes derive from visible ListingRowView projections", () => {
  const failed = row(1, { ai: "failed" })
  const rendered = row(2, { ai: "done", render: "done", upload: "idle" })
  const ready = row(3, {
    ai: "done",
    render: "done",
    upload: "done",
    status: "ready",
    readiness: readyToPublish,
  })
  const sent = row(4, { status: "sent", ai: "done", render: "done", upload: "done" })
  const localSentCloudReady = row(5, {
    status: "sent",
    ai: "done",
    render: "done",
    upload: "done",
    readiness: readyToPublish,
  })
  const missingSource = row(6, {
    source: undefined,
    log: "本地源图不可用；已上传媒体仍可发送，重新识别或切片需重新导入",
  })
  const scopes = Object.fromEntries(
    batchSelectionScopes([failed, rendered, ready, sent, localSentCloudReady, missingSource], {
      [failed.draftId]: instance(failed, { ...idleLifecycle, ai: "failed" }),
      [rendered.draftId]: instance(rendered, {
        ...idleLifecycle,
        ai: "ready",
        media: "rendered",
        image_total: 6,
      }),
      [ready.draftId]: instance(ready, {
        ...idleLifecycle,
        stage: "ready_to_publish",
        ai: "ready",
        media: "ready",
        image_total: 6,
        image_completed: 6,
      }),
      [sent.draftId]: instance(sent, {
        ...idleLifecycle,
        stage: "accepted",
        ozon_sku: 123456789,
      }),
      [localSentCloudReady.draftId]: instance(localSentCloudReady, {
        ...idleLifecycle,
        stage: "ready_to_publish",
        ai: "ready",
        media: "ready",
      }),
      [missingSource.draftId]: instance(missingSource, idleLifecycle),
    }).map((scope) => [scope.key, scope.rows.map((entry) => entry.id)]),
  )

  assert.deepEqual(scopes.ai, [failed.id])
  assert.deepEqual(scopes.render, [failed.id])
  assert.deepEqual(scopes.deliver, [rendered.id])
  assert.deepEqual(scopes.send, [ready.id, localSentCloudReady.id])
  assert.deepEqual(scopes.unsent, [
    failed.id,
    rendered.id,
    ready.id,
    localSentCloudReady.id,
    missingSource.id,
  ])
  assert.deepEqual(scopes.listed, [sent.id])
})

test("save chips stay on the row, not the action ribbon", () => {
  const entry = row(1)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[entry]}
      productDrafts={{ [entry.draftId]: instance(entry) }}
      rowSaveStates={{ [entry.draftId]: "saved" }}
      selectedRowIds={new Set()}
    />,
  )
  const ribbonStart = html.indexOf('data-slot="workbench-action-ribbon"')
  assert.notEqual(ribbonStart, -1)
  const ribbon = html.slice(ribbonStart, html.indexOf("</section>", ribbonStart))
  assert.doesNotMatch(ribbon, /已保存到云端/)
  assert.match(html, /已保存到云端/)
})

test("workbench rows subscribe to previews only while near the table scrollport", () => {
  // The row, the grid and the assembly root each own part of this contract
  // since the workbench split, so the check reads all three.
  const source = ["./field-workbench.tsx", "./workbench-row.tsx", "./workbench-grid.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n")
  // The scrollport geometry lives in its own hook, so the visible window is
  // derived from the table viewport even though the workbench does not
  // spell the range arithmetic itself.
  const windowing = readFileSync(
    new URL("./use-workbench-row-window.ts", import.meta.url),
    "utf8",
  )
  assert.match(source, /useInTableView\(\)/)
  // The row subscribes to its source thumbnail only. Slice previews live in
  // the delivery popover, which mounts on open.
  assert.doesNotMatch(source, /useSlicePreviews\(row\./)
  assert.match(source, /useSourcePreview\(row\.source\?\.handle, inView\)/)
  assert.match(source, /ref=\{rowRef\}/)
  assert.match(source, /useWorkbenchRowWindow\(shownRows\.length\)/)
  assert.match(windowing, /workbenchVisibleRange\(/)
  assert.match(source, /data-workbench-window/)
})

test("a thousand-row workbench does not mount every Product Instance", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => row(index + 1))
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={rows}
      productDrafts={Object.fromEntries(rows.map((item) => [item.draftId, instance(item)]))}
      selectedRowIds={new Set()}
    />,
  )
  const mounted = html.match(/aria-label="选择 SZ-/g) ?? []
  assert.equal(mounted.length, 48, "static markup mounts the unmeasured window, not 1000 rows")
  assert.match(html, /data-workbench-window="0:48"/)
  assert.match(html, /data-testid="workbench-virtual-bottom"/)
  assert.match(html, /data-preparation-step="ai" data-state="idle"/)
})

test("workbench renders the Pro Ledger keyboard matrix HUD status bar", () => {
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[row(1)]}
      productDrafts={{ "draft-1": instance(row(1)) }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /aria-label="工作台键盘矩阵导航状态"/)
  assert.match(html, /Pro Ledger 矩阵导航已就绪/)
  assert.match(html, />↑↓←→<\/kbd>/)
  assert.match(html, />⌘D \/ Ctrl\+D<\/kbd>/)
  assert.match(html, />Enter<\/kbd>/)
  assert.match(html, />Space<\/kbd>/)
  assert.match(html, />⌘C<\/kbd>/)
})

test("fill down is a real button and requires a focused source cell", () => {
  const target = row(1)
  const html = renderToStaticMarkup(
    <FieldWorkbench {...workbenchProps} schema={schema} rows={[target]}
      productDrafts={{ [target.draftId]: instance(target) }} selectedRowIds={new Set()} />,
  )
  const button = html.match(/<button[^>]*title="将当前单元格填充到选中行或下方可编辑行（⌘D \/ Ctrl\+D）"[^>]*>[\s\S]*?<\/button>/)?.[0]
  assert.ok(button, "fill-down needs a clickable affordance, not just a shortcut legend")
  assert.match(button, /disabled=""/)
  assert.match(button, /向下填充/)
})
