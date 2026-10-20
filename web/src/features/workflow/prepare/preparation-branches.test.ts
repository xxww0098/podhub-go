import assert from "node:assert/strict"
import test from "node:test"
import {
  failedStageRetries,
  leftoverStageRetries,
  preparationSequenceViews,
  preparationStepHint,
  preparationStepRetryable,
  preparationStepViews,
  remapFailedStages,
} from "./preparation-branches"
import { NO_PREPARATION_ACTIVITY, NO_PREPARATION_PROGRESS } from "./preparation-tracks"

test("preparation is one strict four-state sequence", () => {
  assert.deepEqual(
    preparationStepViews({ id: "row", ai: "done", render: "running", upload: "done" })
      .map(({ title, state }) => [title, state]),
    [["识别", "done"], ["切片", "running"], ["上传", "idle"]],
  )
})

test("only the current failed step can retry", () => {
  const steps = preparationStepViews({
    id: "row",
    ai: "failed",
    render: "failed",
    upload: "failed",
  })
  assert.deepEqual(steps.map(({ state }) => state), ["failed", "failed", "idle"])
  assert.deepEqual(failedStageRetries({
    id: "row",
    ai: "failed",
    render: "failed",
    upload: "failed",
  }), [{ verb: "ai", label: "重试识别" }])
  assert.deepEqual(failedStageRetries({
    id: "row",
    ai: "done",
    render: "done",
    upload: "failed",
  }), [{ verb: "deliver", label: "重试上传" }])
})

test("failed browser feedback survives an idle projection until that stage completes", () => {
  const row = {
    id: "row", ai: "idle" as const, render: "done" as const, upload: "done" as const,
    preparationAi: { stage: "ai" as const, state: "failed" as const, message: "识别结果待核实", since_ms: 1 },
  }
  assert.deepEqual(preparationStepViews(row).map(({ state }) => state), ["failed", "done", "done"])
  assert.deepEqual(failedStageRetries(row), [{ verb: "ai", label: "重试识别" }])
  assert.deepEqual(preparationStepViews({ ...row, ai: "done" }).map(({ state }) => state), ["done", "done", "done"])
  assert.deepEqual(failedStageRetries({ ...row, ai: "done" }), [])
})

test("render keeps its durable state before recognition completes", () => {
  assert.deepEqual(
    preparationStepViews({ id: "row", ai: "running", render: "done", upload: "done" })
      .map(({ state }) => state),
    ["running", "done", "done"],
  )
  assert.deepEqual(
    preparationStepViews({ id: "row", ai: "idle", render: "failed", upload: "done" })
      .map(({ state }) => state),
    ["idle", "failed", "idle"],
  )
})

test("delivery progress is visible as soon as rendered media exists", () => {
  assert.deepEqual(
    preparationStepViews({ id: "row", ai: "idle", render: "done", upload: "running" })
      .map(({ state }) => state),
    ["idle", "done", "running"],
  )
  assert.deepEqual(
    preparationSequenceViews(
      [{ id: "row", ai: "idle", render: "done", upload: "idle" }],
      { ...NO_PREPARATION_ACTIVITY, deliver: new Set(["row"]) },
      NO_PREPARATION_PROGRESS,
    ).map(({ state }) => state),
    ["idle", "done", "running"],
  )
})

test("batch status blocks downstream steps behind the current state", () => {
  const steps = preparationSequenceViews(
    [
      { id: "a", ai: "done", render: "done", upload: "done" },
      { id: "b", ai: "running", render: "idle", upload: "idle" },
    ],
    NO_PREPARATION_ACTIVITY,
    NO_PREPARATION_PROGRESS,
  )
  assert.deepEqual(steps.map(({ state }) => state), ["running", "idle", "idle"])
})

test("guided fallback marks only the next stage running", () => {
  assert.deepEqual(
    preparationSequenceViews(
      [{ id: "row", ai: "idle", render: "idle", upload: "idle" }],
      NO_PREPARATION_ACTIVITY,
      NO_PREPARATION_PROGRESS,
      true,
    ).map(({ state }) => state),
    ["running", "idle", "idle"],
  )
  assert.deepEqual(
    preparationSequenceViews(
      [{ id: "row", ai: "running", render: "done", upload: "idle" }],
      NO_PREPARATION_ACTIVITY,
      {
        ...NO_PREPARATION_PROGRESS,
        deliver: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
      },
      true,
    ).map(({ state }) => state),
    ["running", "done", "running"],
  )
})

test("a step's tooltip carries its state, its own words and its action", () => {
  const [ai, render] = preparationStepViews({
    id: "row",
    ai: "failed",
    render: "failed",
    upload: "idle",
  })
  assert.equal(preparationStepRetryable("done"), true)
  assert.equal(preparationStepRetryable("failed"), true)
  assert.equal(preparationStepRetryable("idle"), false)
  assert.equal(preparationStepRetryable("running"), false)
  assert.equal(preparationStepHint(ai!, undefined), "识别：失败；点击重试识别")
  assert.equal(
    preparationStepHint(render!, "无法读取在线 PSD 模板"),
    "切片：失败 · 无法读取在线 PSD 模板；点击重试切片",
  )
  assert.equal(
    preparationStepHint({ verb: "deliver", title: "上传", state: "done" }),
    "上传：已完成；点击重试上传（Cloud 已确认完成时需先清空生成内容）",
  )
  assert.equal(
    preparationStepHint({ verb: "render", title: "切片", state: "running" }),
    "切片：进行中",
    "a batch already owns a running step",
  )
})

test("settled leftovers remap to each row's first failed step", () => {
  const rows = [
    { id: "ocr", ai: "failed" as const, render: "failed" as const, upload: "failed" as const },
    { id: "upload", ai: "done" as const, render: "done" as const, upload: "failed" as const },
    { id: "ok", ai: "done" as const, render: "done" as const, upload: "done" as const },
  ]
  assert.deepEqual(remapFailedStages(rows, ["ocr", "upload", "ok"]), {
    ai: ["ocr"],
    render: [],
    deliver: ["upload"],
  })
  assert.deepEqual(leftoverStageRetries(rows, {
    ai: { active: false, failedRowIds: ["ocr"] },
    deliver: { active: false, failedRowIds: ["upload", "ok"] },
  }), {
    ai: ["ocr"],
    render: [],
    deliver: ["upload"],
  })
})
