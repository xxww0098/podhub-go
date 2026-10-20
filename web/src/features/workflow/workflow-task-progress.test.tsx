import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  sameWorkflowTaskProgress,
  WorkflowTaskProgress,
  workflowTaskProgressView,
} from "./workflow-task-progress"

test("projects only the frozen queue generation into cross-page progress", () => {
  const progress = workflowTaskProgressView({
    cardName: "双店铺上架",
    frozenDraftIds: ["draft-a", "draft-b", "draft-c"],
    paused: false,
    running: true,
    rows: [
      { draftId: "draft-a", status: "sent" },
      { draftId: "draft-b", status: "failed" },
      { draftId: "draft-c", status: "running" },
      { draftId: "other-generation", status: "sent" },
    ],
  })

  assert.deepEqual(progress, {
    cardName: "双店铺上架",
    completed: 2,
    total: 3,
    issues: 1,
    state: "running",
  })
})

test("progress equality ignores object identity", () => {
  const left = {
    cardName: "双店铺上架",
    completed: 2,
    total: 3,
    issues: 1,
    state: "running" as const,
  }
  assert.equal(sameWorkflowTaskProgress(left, { ...left }), true)
  assert.equal(sameWorkflowTaskProgress(left, { ...left, completed: 3 }), false)
  assert.equal(sameWorkflowTaskProgress(left, null), false)
})

test("hides the shell affordance when no queue is active", () => {
  assert.equal(
    workflowTaskProgressView({
      cardName: "已结束",
      frozenDraftIds: ["draft-a"],
      paused: false,
      running: false,
      rows: [{ draftId: "draft-a", status: "sent" }],
    }),
    null,
  )
})

test("renders one compact keyboard-accessible return control", () => {
  const html = renderToStaticMarkup(
    <WorkflowTaskProgress
      progress={{
        cardName: "双店铺上架",
        completed: 2,
        total: 10,
        issues: 1,
        state: "paused",
      }}
      onOpen={() => undefined}
    />,
  )

  assert.match(html, /<button/)
  assert.match(html, /返回上架：上架已暂停，已完成 2\/10，1 件需处理/)
  assert.match(html, /双店铺上架/)
  assert.match(html, /上架已暂停/)
  assert.match(html, />2\/10</)
  assert.match(html, /width:20%/)
  assert.match(html, /bg-st-unknown/)
  assert.doesNotMatch(html, /st-warn/)
})
