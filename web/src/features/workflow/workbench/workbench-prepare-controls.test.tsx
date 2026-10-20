import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import {
  NO_GUIDED_PREPARATION,
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
} from "../prepare/preparation-tracks"
import { FieldWorkbench } from "./field-workbench"
import { workbenchLiveStatus } from "./workbench-live-status"
import { idleLifecycle, instance, row, schema, slice } from "./workbench-test-fixtures"
import { buttonMarkup, workbenchProps } from "./workbench-test-harness"

test("the toolbar presents one ordered sequence while preparation runs", () => {
  const first = row(1)
  const second = row(2)
  const sliced: WorkflowProductLifecycle = {
    ...idleLifecycle,
    media: "rendered", image_total: 1,
    images: [slice(0)],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[first, second]}
      productDrafts={{
        [first.draftId]: instance(first, sliced),
        [second.draftId]: instance(second, sliced),
      }}
      activity={{ ai: new Set([first.id, second.id]), render: new Set(), deliver: new Set() }}
      preparationProgress={{
        ...NO_PREPARATION_PROGRESS,
        ai: {
          total: 2,
          settled: 0,
          failed: 0,
          failedRowIds: [],
          active: true,
        },
      }}
      selectedRowIds={new Set()}
    />,
  )

  // The main control stops existing preparation; direct lane buttons still
  // retain the independent prepare lanes for cutting or uploading.
  assert.doesNotMatch(buttonMarkup(html, "停止准备（2）"), /aria-disabled="true"|\sdisabled=""/)
  assert.match(html, /data-preparation-step="ai" data-state="running"/)
  assert.match(html, /data-preparation-step="render" data-state="idle"/)
  assert.match(html, /data-preparation-step="deliver" data-state="idle"/)
  assert.match(html, /aria-label="运行状态：准备进行中"/)
  assert.doesNotMatch(html, /data-slot="status-popup/)
  // Card defaults are the template, not the instance a running lane writes.
  assert.doesNotMatch(buttonMarkup(html, "默认字段"), /disabled=""/)
  assert.doesNotMatch(html, /aria-label="PSD 与提示词"/)
  assert.match(buttonMarkup(html, "导入图片"), /disabled=""/)
})

test("recognition and slicing are independently available for eligible rows", () => {
  const pending = row(1)
  const sliced = row(2, { render: "done" })
  const props = {
    ...workbenchProps,
    schema,
    rows: [pending, sliced],
    productDrafts: {
      [pending.draftId]: instance(pending),
      [sliced.draftId]: instance(sliced, {
        ...idleLifecycle, media: "rendered" as const, image_total: 1, images: [slice(0)],
      }),
    },
  }
  const html = renderToStaticMarkup(<FieldWorkbench {...props} selectedRowIds={new Set()} />)
  assert.doesNotMatch(buttonMarkup(html, "切片（1）"), /aria-disabled="true"|\sdisabled=""/)
  assert.doesNotMatch(buttonMarkup(html, "识别（2）"), /aria-disabled="true"|\sdisabled=""/)
  assert.doesNotMatch(
    buttonMarkup(html, "上传（1）"),
    /aria-disabled="true"|\sdisabled=""/,
    "rendered media can upload before AI completes",
  )

  const selected = renderToStaticMarkup(<FieldWorkbench {...props} selectedRowIds={new Set([sliced.id])} />)
  assert.match(buttonMarkup(selected, "切片：已完成"), /disabled=""/)
  assert.doesNotMatch(buttonMarkup(selected, "识别（1）"), /aria-disabled="true"|\sdisabled=""/)

  const locked = renderToStaticMarkup(<FieldWorkbench {...props} selectedRowIds={new Set()}
    guidedPreparation={{ ...NO_GUIDED_PREPARATION, active: true }} />)
  assert.match(buttonMarkup(locked, "切片（1）"), /aria-disabled="true"|\sdisabled=""/)
  assert.match(buttonMarkup(locked, "识别（2）"), /aria-disabled="true"|\sdisabled=""/)
})

test("a fully recognised scope advances the sequence to slicing", () => {
  const first = row(1, { ai: "done" })
  const second = row(2, { ai: "done" })
  const recognised: WorkflowProductLifecycle = { ...idleLifecycle, ai: "ready" }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[first, second]}
      productDrafts={{
        [first.draftId]: instance(first, recognised),
        [second.draftId]: instance(second, recognised),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /data-preparation-step="ai" data-state="done"/)
  assert.match(buttonMarkup(html, "识别：已完成"), /disabled=""/)
  assert.match(html, /data-preparation-step="render" data-state="idle"/)
  assert.doesNotMatch(html, /重新识别|重新计费|⌥\/Alt/)
})

/// The regression the redo path must not reintroduce: while rows still owe an
/// answer, the plain click buys those and nothing else. Every recognised row it
/// swept back in would be charged a second time.
test("a plain 识别 click leaves the already-recognised rows unbought", () => {
  const pending = row(1)
  const answered = row(2, { ai: "done" })
  const recognised: WorkflowProductLifecycle = { ...idleLifecycle, ai: "ready" }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[pending, answered]}
      productDrafts={{
        [pending.draftId]: instance(pending),
        [answered.draftId]: instance(answered, recognised),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /data-preparation-step="ai" data-state="idle"/)
  assert.doesNotMatch(buttonMarkup(html, "识别（1）"), /aria-disabled="true"|\sdisabled=""/)
  assert.doesNotMatch(html, /aria-label="识别（2）/)
  assert.doesNotMatch(html, /aria-label="全部重新识别/)
})

test("retained preparation claims expose Stop without reconstructing progress", () => {
  const target = row(121)
  const activity = {
    ai: new Set([target.id]),
    render: new Set([target.id]),
    deliver: new Set<string>(),
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[target]}
      productDrafts={{ [target.draftId]: instance(target) }}
      selectedRowIds={new Set()}
      activity={activity}
      preparationProgress={NO_PREPARATION_PROGRESS}
      guidedPreparation={NO_GUIDED_PREPARATION}
    />,
  )
  assert.doesNotMatch(buttonMarkup(html, "停止准备（1）"), /aria-disabled="true"|\sdisabled=""/)
  assert.match(html, /aria-label="运行状态：准备进行中"/)
  const statusInput = {
    queueRunning: false,
    queuePaused: false,
    storeConfigured: true,
    progress: NO_PREPARATION_PROGRESS,
    guided: NO_GUIDED_PREPARATION,
    activity,
    rows: [target],
    retryDisabled: false,
  }
  const card = workbenchLiveStatus(statusInput).find(card => card.id === "live:prepare")
  assert.equal(card?.action?.key, "stop-prepare")
  assert.doesNotMatch(card?.description ?? "", /\d+\/\d+|已运行|\d+:\d+/)
  assert.equal(
    workbenchLiveStatus({ ...statusInput, activity: NO_PREPARATION_ACTIVITY })
      .some(card => card.id === "live:prepare"),
    false,
    "the retained preparation card disappears after its claims settle",
  )
})
