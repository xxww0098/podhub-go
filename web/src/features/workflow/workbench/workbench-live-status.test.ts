import assert from "node:assert/strict"
import test from "node:test"
import {
  closeBatchProgress,
  NO_GUIDED_PREPARATION,
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
  openBatchProgress,
  retainActivePreparationProgress,
  settleBatchProgress,
} from "../prepare/preparation-tracks"
import type { TrackStatus } from "../prepare/pipeline-machine"
import {
  advanceLiveClocks,
  formatLiveClock,
  formatLiveElapsed,
  workbenchLiveStatus,
} from "./workbench-live-status"

const empty = {
  queueRunning: false,
  queuePaused: false,
  storeConfigured: true,
  progress: NO_PREPARATION_PROGRESS,
  guided: NO_GUIDED_PREPARATION,
  activity: NO_PREPARATION_ACTIVITY,
  rows: [] as const,
  retryDisabled: false,
}

test("preparation status stays on the fixed four-state sequence", () => {
  const cards = workbenchLiveStatus({ ...empty,
    guided: { active: true, total: 2, rowIds: ["a", "b"], stopRequested: false },
    nowMs: 125_000,
    rows: [
      { id: "a", ai: "done", render: "running", preparationRender: { stage: "render", state: "waiting", message: "等待上传容量", since_ms: 5_000 } },
      { id: "b", ai: "done", render: "done", upload: "running", preparationUpload: { stage: "upload", state: "waiting", message: "上传繁忙，将自动重试", since_ms: 100_000 } },
    ],
  })
  const steps = cards.find((card) => card.id === "live:steps")
  assert.equal(steps?.description, "识别 已完成 · 切片 进行中 · 上传 未开始")
  assert.doesNotMatch(steps?.description ?? "", /等待上传容量|上传繁忙/)
})

test("a paused queue with Result Unknown is unknown, not a failure", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queuePaused: true,
    unknownImageName: "SZ-9BXIE0611-0015.jpg",
  })
  assert.deepEqual(cards, [
    {
      id: "live:queue",
      type: "unknown",
      title: "发送队列已暂停",
      description: "SZ-9BXIE0611-0015.jpg 还没有确定回执",
      action: { key: "resume-queue", label: "对账并继续" },
    },
  ])
})

test("a typed halt reason names why the queue paused, before any row log", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queuePaused: true,
    queueHaltReason: "auth_expired",
  })
  assert.equal(cards[0]?.title, "发送队列已暂停")
  assert.equal(
    cards[0]?.description,
    "登录已失效，请重新登录后继续 · 对账后才会解锁",
  )
})

test("an operator pause does not claim reconciliation is required", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queuePaused: true,
    queueHaltReason: "operator_pause",
  })
  assert.equal(cards[0]?.description, "操作员已暂停")
})

test("a running queue carries the one control that clears the lock", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queueRunning: true,
    clocks: { startedAt: { queue: 1_000 } },
    nowMs: 13_000,
  })
  assert.equal(cards[0]?.title, "发送队列进行中")
  assert.equal(cards[0]?.type, "loading")
  assert.equal(cards[0]?.action?.label, "停止后续发送")
  assert.equal(
    cards[0]?.description,
    "锁定导入与准备，未派发的行仍可改字段 · 已运行 0:12",
  )
})

test("a persisted pause request is visible while the current dispatch settles", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queueRunning: true,
    queuePaused: true,
  })
  assert.equal(cards[0]?.title, "正在暂停发送队列")
  assert.equal(cards[0]?.action?.label, "停止后续发送")
})

test("a persisted stop request cannot still look like an ordinary running queue", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    queueRunning: true,
    queuePaused: true,
    queueStopRequested: true,
  })
  assert.equal(cards[0]?.title, "正在停止发送队列")
  assert.equal(cards[0]?.action, undefined)
})

test("a running prepare notice names the current ordered step", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
    clocks: { startedAt: { ai: 1_000 } },
    nowMs: 13_000,
  })
  const steps = cards.find((card) => card.id === "live:steps")
  assert.equal(steps?.title, "识别 → 切片 → 上传")
  assert.equal(steps?.description, "识别 进行中 · 切片 未开始 · 上传 未开始")
  assert.equal(cards.find((card) => card.id === "live:prepare")?.action?.key, "stop-prepare")
})

test("elapsed clock stays mm:ss past one minute", () => {
  assert.equal(formatLiveClock(0), "0:00")
  assert.equal(formatLiveClock(65_000), "1:05")
  assert.equal(formatLiveElapsed(0), "已运行 0:00")
  assert.equal(formatLiveElapsed(65_000), "已运行 1:05")
})

test("one-click preparation shows progress without invented stages", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    rows: [{ id: "row-1", ai: "idle", upload: "idle" }],
    guided: {
      active: true,
      total: 1,
      rowIds: ["row-1"],
      stopRequested: false,
    },
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
      render: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
    clocks: { startedAt: { ai: 1_000, render: 1_000 } },
    nowMs: 13_000,
  })
  assert.equal(cards.find((card) => card.id === "live:prepare")?.title, "一键准备")
  assert.equal(cards.find((card) => card.id === "live:prepare")?.action?.label, "停止后续准备")
  assert.equal(cards.find((card) => card.id === "live:steps")?.description, "识别 进行中 · 切片 进行中 · 上传 未开始")
})

test("guided progress advances one ordered step after recognition settles", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: `row-${index}`,
    ai: (index < 43 ? "done" : "idle") as TrackStatus,
    upload: (index < 3 ? "done" : "idle") as TrackStatus,
  }))
  const rowIds = rows.map((row) => row.id)
  const inProgress = workbenchLiveStatus({
    ...empty,
    rows,
    guided: { active: true, total: 60, rowIds, stopRequested: false },
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 17, settled: 0, failed: 0, failedRowIds: [], active: true },
      render: { total: 57, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
  })
  assert.equal(inProgress.find((card) => card.id === "live:steps")?.description, "识别 进行中 · 切片 进行中 · 上传 未开始")

  const aiSettled = workbenchLiveStatus({
    ...empty,
    rows: rows.map((row) => ({ ...row, ai: "done" })),
    guided: { active: true, total: 60, rowIds, stopRequested: false },
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 17, settled: 17, failed: 0, failedRowIds: [], active: false },
      render: { total: 57, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
  })
  assert.equal(aiSettled.find((card) => card.id === "live:steps")?.description, "识别 已完成 · 切片 进行中 · 上传 未开始")
})

test("guided stop request keeps progress and the stop control", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    rows: [{ id: "row-1", ai: "done", upload: "idle" }],
    guided: {
      active: true,
      total: 1,
      rowIds: ["row-1"],
      stopRequested: true,
    },
    progress: {
      ...NO_PREPARATION_PROGRESS,
      deliver: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
    clocks: { startedAt: { deliver: 19_000 } },
    nowMs: 23_000,
  })
  assert.equal(cards.find((card) => card.id === "live:prepare")?.description, "停止已生效")
  assert.equal(cards.find((card) => card.id === "live:steps")?.description, "识别 已完成 · 切片 进行中 · 上传 未开始")
})

test("overlapping Host lanes still present one ordered UI sequence", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
      deliver: { total: 1, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
    clocks: { startedAt: { ai: 1_000, deliver: 10_000 } },
    nowMs: 13_000,
  })
  assert.equal(cards.find((card) => card.id === "live:steps")?.description, "识别 进行中 · 切片 未开始 · 上传 未开始")
})

test("an independent lane keeps the batch start after its clock view resets", () => {
  const clocks = advanceLiveClocks(
    { startedAt: {} },
    {
      queueRunning: false,
      progress: {
        ...NO_PREPARATION_PROGRESS,
        deliver: {
          total: 1,
          settled: 0,
          failed: 0,
          failedRowIds: [],
          active: true,
          startedAtMs: 1_000,
        },
      },
      nowMs: 13_000,
    },
  )
  assert.equal(clocks.startedAt.deliver, 1_000)
})

test("prepare progress is one ordered status line", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 2, settled: 0, failed: 0, failedRowIds: [], active: true },
    },
  })
  assert.deepEqual(cards, [
    {
      id: "live:prepare",
      type: "loading",
      title: "准备进行中",
      action: { key: "stop-prepare", label: "停止后续准备" },
    },
    {
      id: "live:steps",
      type: "loading",
      title: "识别 → 切片 → 上传",
      description: "识别 进行中 · 切片 未开始 · 上传 未开始",
    },
  ])
})

test("a stop request remains retryable while preparation work is still in flight", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    prepareStopRequested: true,
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 2, settled: 1, failed: 0, failedRowIds: [], active: true },
    },
  })
  assert.deepEqual(cards[0]?.action, {
    key: "stop-prepare",
    label: "重试停止",
  })
  assert.equal(cards.find((card) => card.id === "live:prepare")?.description, "停止已生效")
  assert.equal(cards.find((card) => card.id === "live:steps")?.description, "识别 进行中 · 切片 未开始 · 上传 未开始")
})

test("a stop failure stays in the original preparation status", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    guided: {
      ...NO_GUIDED_PREPARATION,
      stopRequested: true,
      stopMessage: "本地准备已停止，但 Cloud 准备作业取消失败；请重试停止。",
      stopFailed: true,
    },
  })
  assert.deepEqual(cards, [
    {
      id: "live:prepare",
      type: "error",
      title: "停止准备失败",
      description: "本地准备已停止，但 Cloud 准备作业取消失败；请重试停止。",
      action: { key: "stop-prepare", label: "重试停止" },
    },
  ])
})

test("leaving the screen drops finished batch leftovers so they cannot resurrect", () => {
  const leftover = {
    total: 1,
    settled: 0,
    failed: 0,
    failedRowIds: [],
    active: false,
  }
  const running = { ...leftover, active: true }
  assert.deepEqual(
    retainActivePreparationProgress({
      ...NO_PREPARATION_PROGRESS,
      ai: leftover,
      render: running,
    }),
    { ...NO_PREPARATION_PROGRESS, render: running },
  )
})

test("only failed or incomplete batches keep a live notice", () => {
  const rows = [
    { id: "a", ai: "failed" as const },
    { id: "b", ai: "done" as const },
    { id: "c", ai: "failed" as const },
  ]
  const cards = workbenchLiveStatus({
    ...empty,
    rows,
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: {
        total: 3,
        settled: 3,
        failed: 2,
        failedRowIds: ["c", "a"],
        active: false,
      },
      render: {
        total: 3,
        settled: 3,
        failed: 0,
        failedRowIds: [],
        active: false,
      },
    },
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.title, "AI 识别：2 失败")
  assert.deepEqual(cards[0]?.action, {
    key: "retry-ai",
    label: "重试识别（2）",
    disabled: false,
    rowIds: ["a", "c"],
  })
})

test("store unavailability yields one error notice", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    storeConfigured: false,
    storeIssue: {
      title: "Workspace 店铺密钥未配置",
      description: "请到「店铺」为 H1 配置 Seller 密钥",
      action: "open-stores",
      actionLabel: "打开店铺",
    },
  })
  assert.deepEqual(cards, [
    {
      id: "live:store",
      type: "error",
      title: "Workspace 店铺密钥未配置",
      description: "请到「店铺」为 H1 配置 Seller 密钥",
      action: { key: "open-stores", label: "打开店铺" },
    },
  ])
})

test("a failed OCR leftover does not offer a media retry", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    rows: [
      { id: "ocr", ai: "failed", render: "done", upload: "done" },
      { id: "up", ai: "done", render: "done", upload: "failed" },
    ],
    progress: {
      ...NO_PREPARATION_PROGRESS,
      deliver: {
        total: 2,
        settled: 2,
        failed: 2,
        failedRowIds: ["ocr", "up"],
        active: false,
      },
    },
  })
  const ai = cards.find((card) => card.id === "live:batch-ai")
  const upload = cards.find((card) => card.id === "live:batch-deliver")
  assert.deepEqual(ai?.action, {
    key: "retry-ai",
    label: "重试识别（1）",
    disabled: false,
    rowIds: ["ocr"],
  })
  assert.deepEqual(upload?.action, {
    key: "retry-deliver",
    label: "重试上传（1）",
    disabled: false,
    rowIds: ["up"],
  })
  assert.equal(cards.some((card) => card.id === "live:batch-render"), false)
})

test("a completed branch is not shown as a retry after leftover remapping", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    rows: [
      { id: "ok", ai: "done", render: "done", upload: "done" },
      { id: "up", ai: "done", render: "done", upload: "failed" },
    ],
    progress: {
      ...NO_PREPARATION_PROGRESS,
      ai: { total: 2, settled: 2, failed: 0, failedRowIds: [], active: false },
      deliver: { total: 2, settled: 2, failed: 2, failedRowIds: ["ok", "up"], active: false },
    },
  })
  assert.equal(cards.some((card) => card.id === "live:batch-ai" || card.action?.key === "retry-ai"), false)
  assert.deepEqual(cards.find((card) => card.id === "live:batch-deliver")?.action, {
    key: "retry-deliver",
    label: "重试上传（1）",
    disabled: false,
    rowIds: ["up"],
  })
})

test("guided delivery opened once per row stays one batch without inventing retry-upload", () => {
  // The guided run holds the slot, then one open/settle/close per rendered row.
  let progress = openBatchProgress(NO_PREPARATION_PROGRESS, "deliver", 0, 1_000)
  for (const rowId of ["a", "b", "c"]) {
    progress = openBatchProgress(progress, "deliver", 1, 5_000)
    progress = settleBatchProgress(progress, "deliver", rowId, rowId !== "b")
    // Row a's delivery finishes before row c has even started rendering.
    progress = closeBatchProgress(progress, "deliver")
    assert.equal(progress.deliver?.active, true, `${rowId} closed the batch early`)
  }
  progress = closeBatchProgress(progress, "deliver")
  assert.deepEqual(progress.deliver, {
    total: 3,
    settled: 3,
    failed: 2,
    failedRowIds: ["a", "c"],
    active: false,
    startedAtMs: 1_000,
    open: 0,
  })

  const cards = workbenchLiveStatus({
    ...empty,
    rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
    progress,
  })
  assert.equal(
    cards.some((card) => card.action?.key === "retry-deliver"),
    false,
    "trackless leftover ids must not become 重试上传",
  )
  assert.equal(cards.find((card) => card.id === "live:batch-deliver")?.action, undefined)
})

test("a guided leftover remaps OCR failure to retry-ai and omits trackless retry-deliver", () => {
  const cards = workbenchLiveStatus({
    ...empty,
    rows: [
      { id: "ocr", ai: "failed" },
      { id: "ghost" },
    ],
    progress: {
      ...NO_PREPARATION_PROGRESS,
      deliver: {
        total: 2,
        settled: 2,
        failed: 2,
        failedRowIds: ["ocr", "ghost"],
        active: false,
      },
    },
  })
  assert.deepEqual(cards.find((card) => card.id === "live:batch-ai")?.action, {
    key: "retry-ai",
    label: "重试识别（1）",
    disabled: false,
    rowIds: ["ocr"],
  })
  assert.equal(cards.some((card) => card.action?.key === "retry-deliver"), false)
  assert.equal(
    cards.find((card) => card.action?.rowIds?.includes("ghost")),
    undefined,
  )
})
