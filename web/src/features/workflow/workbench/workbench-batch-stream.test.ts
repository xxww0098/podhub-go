import assert from "node:assert/strict"
import test from "node:test"
import type {
  WorkflowOperationRowResult,
  WorkflowProductLifecycle,
} from "@/bindings/commands"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { runWorkflowOperationBatch } from "../batch-operation"
import type { ListingRow } from "../model/listing-row"
import {
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
} from "../prepare/preparation-tracks"
import { workbenchLiveStatus } from "./workbench-live-status"
import { idleLifecycle, instance, projection, row, slice } from "./workbench-test-fixtures"
import { cloudRow, harness, installFetch, routes } from "./workbench-test-harness"

// A committed row projection paints while the rest of the batch is still running.
test("a streamed row projection reaches the table before the Cloud batch returns", async () => {
  const target = row(1)
  const recognised: WorkflowProductLifecycle = {
    ...idleLifecycle,
    revision: 2,
    view_revision: 2,
    stage: "build_stale",
    ai: "ready",
    ai_summary: { tags: ["море", "постер"], model: "test" },
  }
  const base = instance(target)
  const streamed = projection(target, recognised, {
    name: { kind: "text", value: "Постер с морем" },
    description: { kind: "text", value: "Печать на холсте." },
  })
  const scene = harness([target], { [target.draftId]: base })
  const settled: [string, boolean][] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // The returned row carries no projection, so its settle re-reads Cloud once.
  const calls = installFetch((call) =>
    cloudRow(call.url.split("/").pop()!, {
      revision: 2,
      view_revision: 2,
      projection: listingProjection({ stage: "build_stale", ai: "ready" }),
    }),
  )

  const running = runWorkflowOperationBatch(
    [target],
    {
      ...scene.deps,
      settleProgress: (rowId, failed) => settled.push([rowId, failed]),
    },
    async (_request, onRow) => {
      onRow({
        row_id: target.draftId,
        outcome: "start",
        blockers: [],
        product: streamed,
      })
      await held
      return [{ row_id: target.draftId, outcome: "start", blockers: [] }]
    },
    { status: "running", ai: "running", log: "AI 识别已开始" },
    "AI 识别已完成",
  )

  // Everything below holds while the Cloud call is still in flight.
  assert.deepEqual(scene.products[target.draftId]?.draft.values.name, {
    kind: "text",
    value: "Постер с морем",
  })
  assert.deepEqual(scene.products[target.draftId]?.draft.values.description, {
    kind: "text",
    value: "Печать на холсте.",
  })
  assert.equal(scene.row("row-1").ai, "done")
  assert.equal(scene.row("row-1").log, "AI 识别已完成")
  assert.deepEqual(
    settled,
    [["row-1", false]],
    "the live counter may not wait for the whole Cloud batch",
  )
  assert.deepEqual(routes(calls), [], "nothing is read while the Cloud call is in flight")

  release()
  assert.deepEqual(await running, [])
  assert.equal(
    scene.products[target.draftId]?.draft.values.name?.value,
    "Постер с морем",
    "the settle refreshes the lifecycle and must not drop the committed draft",
  )
  assert.deepEqual(
    routes(calls),
    [`GET /api/listing/rows/${target.draftId}`],
    "a returned row without a projection is re-read exactly once",
  )
})

/// A job failure does not reject the command: it rides back on its own row,
/// so the products that succeeded keep their answer instead of being failed
/// wholesale by a sibling nobody could recognise.
test("one failed row does not fail its siblings", async () => {
  const refused = row(1)
  const recognised = row(2)
  const ready: WorkflowProductLifecycle = { ...idleLifecycle, ai: "ready" }
  const base = instance(recognised)
  const streamed = projection(recognised, ready, { name: { kind: "text", value: "Постер" } })
  const scene = harness([refused, recognised], {
    [refused.draftId]: instance(refused),
    [recognised.draftId]: base,
  })
  const settled: [string, boolean][] = []
  // Only the refused row is re-read; Cloud answers with its recorded failure.
  const calls = installFetch((call) =>
    cloudRow(call.url.split("/").pop()!, {
      content_state: "failed",
      validation_state: "stale",
      projection: listingProjection({ stage: "recognition_failed", ai: "failed", fields: "dirty" }),
    }),
  )

  const failures = await runWorkflowOperationBatch(
    [refused, recognised],
    {
      ...scene.deps,
      settleRow: async (candidate, log, failed) => {
        settled.push([candidate.id, failed])
        await scene.deps.settleRow(candidate, log, failed)
      },
    },
    async () => [
      {
        row_id: refused.draftId,
        outcome: "start",
        blockers: [],
        error: {
          code: "workflow_ai_failed",
          message: "模型返回了无法解析的结构",
          remediation: null,
        },
      },
      {
        row_id: recognised.draftId,
        outcome: "start",
        blockers: [],
        product: streamed,
      },
    ],
    { status: "running", ai: "running", log: "AI 识别已开始" },
    "AI 识别已完成",
  )

  assert.equal(failures.length, 1)
  assert.match(failures[0]!, /^SZ-0001\.png：/)
  assert.match(failures[0]!, /模型返回了无法解析的结构/)
  assert.deepEqual(settled, [["row-1", true]], "only a failed row is re-read from Cloud")
  assert.deepEqual(routes(calls), [`GET /api/listing/rows/${refused.draftId}`])
  assert.deepEqual(
    scene.products[recognised.draftId]?.draft.values.name,
    { kind: "text", value: "Постер" },
    "the sibling keeps the draft Cloud just wrote",
  )
})

/// 一键准备 streams the recognition leg ahead of the media leg. The interim
/// projections paint the row — 名称 lands, `ai` turns done, the guided banner's
/// 「AI 识别 n/N」 climbs — while the row's own settle waits for its media
/// result; a settled row then closes its share of the batch counter the moment
/// it streams, not when the whole pool returns.
test("一键准备 paints each leg as it streams and settles a row on its own result", async () => {
  const first = row(1)
  const second = row(2)
  const pinned: WorkflowProductLifecycle = { ...idleLifecycle, ai: "running", media: "rendering" }
  const recognised: WorkflowProductLifecycle = { ...idleLifecycle, ai: "ready", media: "rendering" }
  const delivered: WorkflowProductLifecycle = {
    ...idleLifecycle,
    ai: "ready",
    media: "ready",
    images: [slice(0, { phase: "public_ready" })],
  }
  const name = { name: { kind: "text", value: "Постер" } } as const
  const scene = harness([first, second], {
    [first.draftId]: instance(first),
    [second.draftId]: instance(second),
  })
  const settled: [string, boolean][] = []
  const progress: string[] = []
  const guided = { active: true, total: 2, rowIds: ["row-1", "row-2"], stopRequested: false }
  const banner = () => {
    const cards = workbenchLiveStatus({
      queueRunning: false,
      queuePaused: false,
      storeConfigured: true,
      progress: NO_PREPARATION_PROGRESS,
      guided,
      activity: NO_PREPARATION_ACTIVITY,
      rows: [scene.row("row-1"), scene.row("row-2")],
      retryDisabled: false,
    })
    return cards.find((card) => card.id === "live:steps")?.description
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const running = runWorkflowOperationBatch(
    [first, second],
    {
      ...scene.deps,
      settleProgress: (rowId) => {
        if (!progress.includes(rowId)) progress.push(rowId)
      },
      settleRow: async (candidate, log, failed) => {
        settled.push([candidate.id, failed])
        await scene.deps.settleRow(candidate, log, failed)
      },
    },
    async (_request, onRow) => {
      const start = (target: ListingRow): WorkflowOperationRowResult =>
        ({ row_id: target.draftId, outcome: "start", blockers: [] })
      // Row 1: recognition starts, lands, then the media leg delivers.
      onRow({ ...start(first), interim: true, product: projection(first, pinned) })
      assert.equal(scene.row("row-1").ai, "running")
      assert.equal(scene.row("row-1").log, "一键准备已开始", "a start projection keeps the start line")
      assert.equal(banner(), "识别 进行中 · 切片 进行中 · 上传 未开始")
      onRow({ ...start(first), interim: true, product: projection(first, recognised, name) })
      assert.deepEqual(scene.products[first.draftId]?.draft.values.name, name.name)
      assert.equal(scene.row("row-1").ai, "done")
      assert.equal(scene.row("row-1").render, "running")
      assert.equal(scene.row("row-1").log, "AI 字段已写入商品草稿，切片与上传进行中")
      assert.equal(banner(), "识别 进行中 · 切片 进行中 · 上传 未开始")
      assert.deepEqual(progress, [], "an interim projection never settles the row")
      onRow({ ...start(first), product: projection(first, delivered, name) })
      assert.equal(scene.row("row-1").upload, "done")
      assert.equal(scene.row("row-1").log, "准备已完成")
      assert.deepEqual(progress, ["row-1"], "a settled row closes its counter share on the stream")
      assert.equal(banner(), "识别 进行中 · 切片 未开始 · 上传 未开始")
      // Row 2's recognition lands while row 1 is already done and the pool is
      // still open: the table has both names before anything returns.
      onRow({ ...start(second), interim: true, product: projection(second, recognised, name) })
      assert.equal(banner(), "识别 已完成 · 切片 进行中 · 上传 未开始")
      await held
      return [
        { ...start(first), product: projection(first, delivered, name) },
        { ...start(second), product: projection(second, delivered, name) },
      ]
    },
    { status: "running", log: "一键准备已开始" },
    "准备已完成",
    "AI 字段已写入商品草稿，切片与上传进行中",
  )

  assert.deepEqual(settled, [], "the Cloud re-read waits for a missed projection or a failure")
  release()
  assert.deepEqual(await running, [])
  assert.equal(scene.products[first.draftId]?.lifecycle.media, "ready")
  assert.equal(scene.products[second.draftId]?.lifecycle.media, "ready")
  assert.deepEqual(scene.products[second.draftId]?.draft.values.name, name.name)
  assert.deepEqual(progress, ["row-1", "row-2"], "the returned array settles a row the stream missed")
  assert.deepEqual(settled, [], "a successful projection is not re-read from Cloud")
})

/// The command itself rejecting is the one failure that is still everybody's:
/// no row started, so no row may be left 运行中.
test("a rejected command fails every unsettled row", async () => {
  const first = row(1)
  const second = row(2)
  const calls = installFetch((call) =>
    cloudRow(call.url.split("/").pop()!, { content_state: "failed", validation_state: "stale", projection: listingProjection({ stage: "recognition_failed", ai: "failed", fields: "dirty" }) }),
  )
  const scene = harness([first, second], {
    [first.draftId]: instance(first),
    [second.draftId]: instance(second),
  })

  const failures = await runWorkflowOperationBatch(
    [first, second],
    scene.deps,
    async () => {
      throw { code: "workflow_rejected", message: "Cloud 拒绝了本次操作", remediation: null }
    },
    { status: "running", ai: "running", log: "AI 识别已开始" },
    "AI 识别已完成",
  )

  assert.equal(failures.length, 2)
  assert.ok(failures.every((failure) => /Cloud 拒绝了本次操作/.test(failure)))
  for (const target of [first, second]) {
    assert.equal(scene.row(target.id).status, "failed")
    assert.match(scene.row(target.id).log, /Cloud 拒绝了本次操作/)
  }
  assert.deepEqual(
    routes(calls),
    [
      `GET /api/listing/rows/${first.draftId}`,
      `GET /api/listing/rows/${second.draftId}`,
    ],
    "a failed row still asks Cloud what it and its latest send hold",
  )
})

test("a row with no durable Product Instance is failed before any Cloud call", async () => {
  const target = row(1)
  const calls = installFetch(() => assert.fail("an unbound row must never reach Cloud"))
  const scene = harness([target], {})

  const failures = await runWorkflowOperationBatch(
    [target],
    scene.deps,
    async () => assert.fail("an unbound row must never reach Cloud"),
    { status: "running" },
    "AI 识别已完成",
  )

  assert.equal(failures.length, 1)
  assert.match(scene.row(target.id).errorFeedback?.errorId ?? "", /^[0-9]{20}$/)
  assert.deepEqual(routes(calls), [], "an unbound row must never reach Cloud")
  assert.equal(scene.row("row-1").status, "failed")
  assert.match(scene.row("row-1").log, /找不到该图片对应的商品/)
})
