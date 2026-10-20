/** The original eleven publish scenarios now exercise the only final S16 queue. */
import assert from "node:assert/strict"
import test from "node:test"
import type { LocalRow } from "../rows/types"
import type { PlatformAdapter, PlatformIssue } from "./core"
import type { SendCapability, SendFact } from "../submit/queue/types"
import { createSendQueue } from "../submit/send-queue"
import { finalQueueHarness, queueAccepted, testAdapterCapability, thirdPlatformCapability } from "../submit/send-test-support"
import { createPlatformRegistry } from "./publish"

type Body = { value: string }
function issue(platform: string, code: string): PlatformIssue {
  return { platform, stage: "validate", field: null, code, message: "测试问题", remediation: "测试动作" }
}
function adapter(platform: string, keys: string[], blocked: string[] = []): PlatformAdapter<readonly LocalRow[], Body> {
  return { platform, label: platform.toUpperCase(), async build(rows) {
    const present = (id: string) => rows.some((row) => row.id === id)
    return {
      frozen: keys.filter(present).map((key) => ({ key, body: { value: key }, digest: `sha256:${key}`, clientOperationId: `${platform}:${key}`, provenance: [] })),
      blocked: blocked.filter(present).map((key) => ({ key, issues: [issue(platform, "required")] })),
    }
  } }
}
const selection = [{ platform: "alpha", destination: "s1", rowIds: ["r0", "r1"] }, { platform: "beta", destination: "s1", rowIds: ["r2"] }]
const accepted: SendCapability["send"] = async (_destination, items) => queueAccepted(items)
const receipt = (row: LocalRow | undefined) => row?.submission?.receipt as SendFact | undefined
async function fixture(alpha: SendCapability, beta?: SendCapability) {
  const harness = await finalQueueHarness(3)
  const queue = createSendQueue({ ...harness.scope, rows: harness.rows, current: () => true, capabilities: { alpha, ...(beta ? { beta } : {}) } })
  return { ...harness, queue }
}
const capabilities = (send: SendCapability["send"] = accepted) => testAdapterCapability(adapter("alpha", ["r0", "r1"]), send)
const beta = (send: SendCapability["send"] = accepted) => testAdapterCapability(adapter("beta", ["r2"]), send)

test("platforms send concurrently: the second starts before the first settles", async () => {
  const started: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const slow = (platform: string): SendCapability["send"] => async (_destination, items) => {
    started.push(platform)
    if (started.length === 2) release()
    await gate
    return queueAccepted(items)
  }
  const { rows, queue } = await fixture(capabilities(slow("alpha")), beta(slow("beta")))
  try {
    await queue.start(selection)
    assert.deepEqual(started.sort(), ["alpha", "beta"])
    assert.deepEqual(queue.snapshot().counts, { accepted: 3, rejected: 0, pending: 0, unknown: 0 })
  } finally { release(); await rows.close() }
})

test("a throwing transport is unknown for that platform only, and unknown is never retried", async () => {
  let sends = 0
  let otherSends = 0
  const { rows, queue } = await fixture(capabilities(async () => { sends++; throw new TypeError("Failed to fetch") }),
    beta(async (_destination, items) => { otherSends++; return queueAccepted(items) }))
  try {
    await queue.start(selection)
    assert.deepEqual(queue.snapshot().counts, { accepted: 1, rejected: 0, pending: 0, unknown: 2 })
    assert.equal(receipt(rows.get("r0"))?.code, "send_result_unknown")
    assert.doesNotMatch(JSON.stringify(receipt(rows.get("r0"))), /Failed to fetch/)
    await queue.retry(rows.cardState()!.publish!.blocks[0]!.id)
    await queue.continue()
    assert.equal(sends, 1)
    assert.equal(otherSends, 1)
  } finally { await rows.close() }
})

test("reconcile reads back unknown items without sending, and only for that platform", async () => {
  let sends = 0
  const reads: string[][] = []
  let otherReads = 0
  // Readback may only settle identities actually captured from the server;
  // a wholly lost response with no identity remains unknown (no preview-ID shortcut).
  const first = capabilities(async (_destination, items) => {
    sends++
    return new Map(items.map((item) => [item.rowId, { state: "unknown", intentId: `i-${item.rowId}`, serverOperationId: `server-${item.rowId}`, serverRevision: 0 }]))
  })
  first.reconcile = async (_destination, selected) => {
    reads.push(selected.map((row) => row.rowId))
    return { complete: true, rows: [{ rowId: "r0", candidates: [], fact: { state: "accepted", intentId: "i-r0", serverOperationId: "server-r0", serverRevision: 0, taskId: 42 } }] }
  }
  const second = beta(); second.reconcile = async () => { otherReads++; return { complete: true, rows: [] } }
  const { rows, queue } = await fixture(first, second)
  try {
    await queue.start(selection); await queue.reconcile({ platform: "alpha", destination: "s1", rowIds: ["r0", "r1"] })
    assert.deepEqual(reads, [["r0", "r1"]])
    assert.equal(sends, 1); assert.equal(otherReads, 0)
    assert.deepEqual([rows.get("r0")?.submission?.state, rows.get("r1")?.submission?.state], ["accepted", "unconfirmed"])
    assert.equal(queue.snapshot().counts.unknown, 1)
  } finally { await rows.close() }
})

test("only items blocked by a known retryable refusal are resent", async () => {
  const sent: string[][] = []
  let otherSends = 0
  const first = capabilities(async (_destination, items) => {
    sent.push(items.map((item) => item.rowId))
    if (sent.length === 1) return new Map<string, SendFact>([
      ["r0", queueAccepted(items).get("r0")!], ["r1", { state: "rejected", canResume: true, admission: "submit_capacity_full" }],
    ])
    return queueAccepted(items)
  })
  const { rows, queue } = await fixture(first, beta(async () => { otherSends++; return new Map([["r2", { state: "rejected", canResume: false, code: "store_unbound" }]]) }))
  try {
    await queue.start(selection)
    assert.equal(receipt(rows.get("r1"))?.canResume, true)
    assert.equal(receipt(rows.get("r2"))?.canResume, false)
    const blocks = rows.cardState()!.publish!.blocks
    await queue.retry(blocks[0]!.id); await queue.retry(blocks[1]!.id)
    assert.deepEqual(sent, [["r0", "r1"], ["r1"]])
    assert.equal(rows.get("r1")?.submission?.state, "accepted")
    assert.equal(otherSends, 1)
  } finally { await rows.close() }
})

test("a typed pre-dispatch refusal is blocked, not unknown", async () => {
  const { rows, queue } = await fixture(capabilities(async (_destination, items) => new Map(items.map((item) => [item.rowId,
    { state: "rejected", canResume: false, admission: "store_unavailable", issues: [issue("alpha", "store_unavailable")] }]))))
  try {
    await queue.start(selection.slice(0, 1))
    assert.equal(queue.snapshot().counts.rejected, 2)
    assert.equal(queue.snapshot().counts.unknown, 0)
    assert.equal(receipt(rows.get("r0"))?.canResume, false)
  } finally { await rows.close() }
})

test("a platform without a transport is blocked with an action and never sent", async () => {
  const { rows, queue } = await fixture(capabilities())
  try {
    await queue.start(selection)
    assert.equal(rows.get("r2")?.submission?.state, "rejected")
    const problem = receipt(rows.get("r2"))?.issues?.[0]
    assert.equal(problem?.code, "transport_unavailable")
    assert.ok(problem?.remediation)
    assert.equal(queue.snapshot().counts.accepted, 2)
    assert.equal(rows.cardState()!.publish!.blocks[1]!.budget.submits, 0)
  } finally { await rows.close() }
})

test("build refusals block their own items while the rest still send", async () => {
  const sent: string[][] = []
  const { rows, queue } = await fixture(testAdapterCapability(adapter("alpha", ["r0"], ["r1"]), async (_destination, items) => {
    sent.push(items.map((item) => item.rowId)); return queueAccepted(items)
  }))
  try {
    await queue.start(selection.slice(0, 1))
    assert.deepEqual(sent, [["r0"]])
    assert.deepEqual([rows.get("r0")?.submission?.state, rows.get("r1")?.submission?.state], ["accepted", "rejected"])
    assert.equal(receipt(rows.get("r1"))?.issues?.[0]?.code, "required")
    assert.equal(queue.snapshot().counts.rejected, 1)
  } finally { await rows.close() }
})

test("a stop before dispatch is a retryable known refusal, not unknown", async () => {
  let sends = 0
  const { rows, queue } = await fixture(capabilities(async (_destination, items) => { sends++; return queueAccepted(items) }))
  try {
    const running = queue.start(selection.slice(0, 1)); queue.stop(); await running
    assert.equal(sends, 0)
    assert.equal(queue.snapshot().phase, "paused")
    assert.equal(queue.snapshot().counts.unknown, 0)
    assert.equal(rows.get("r0")?.submission, undefined)
    await queue.continue()
    assert.equal(sends, 1, "the untouched pending block can be explicitly continued")
  } finally { await rows.close() }
})

test("a future platform registers at the composition root without changing the runner", async () => {
  const { rows, scope } = await finalQueueHarness()
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { demo: thirdPlatformCapability() } })
  try {
    await queue.start([{ platform: "demo", destination: "s1", rowIds: ["r0"] }])
    assert.equal(queue.snapshot().counts.accepted, 1)
    assert.throws(() => createPlatformRegistry({ wrong: adapter("demo", []) }), /registered under "wrong"/)
  } finally { await rows.close() }
})

test("an adapter that throws blocks only its own platform with a Chinese message", async () => {
  const broken: PlatformAdapter<readonly LocalRow[], Body> = { platform: "beta", label: "BETA", build: async () => { throw new Error("boom") } }
  const { rows, queue } = await fixture(capabilities(), testAdapterCapability(broken, accepted))
  try {
    await queue.start(selection)
    assert.equal(queue.snapshot().counts.accepted, 2)
    const problem = receipt(rows.get("r2"))?.issues?.[0]
    assert.equal(problem?.code, "build_failed")
    assert.match(problem!.message, /beta.*商品内容生成失败/)
    assert.doesNotMatch(problem!.message, /boom/)
  } finally { await rows.close() }
})

test("an adapter answering twice under one key gets that key reported once and nothing sent for it", async () => {
  const twice: PlatformAdapter<readonly LocalRow[], Body> = { platform: "alpha", label: "ALPHA", async build() {
    const item = (value: string) => ({ key: "r0", body: { value }, digest: `sha256:${value}`, clientOperationId: value, provenance: [] })
    return { frozen: [item("a"), item("b"), { ...item("c"), key: "r1" }], blocked: [{ key: "r0", issues: [issue("alpha", "required")] }] }
  } }
  const sent: string[][] = []
  const { rows, queue } = await fixture(testAdapterCapability(twice, async (_destination, items) => {
    sent.push(items.map((item) => item.rowId)); return queueAccepted(items)
  }))
  try {
    await queue.start(selection.slice(0, 1))
    assert.deepEqual(sent, [["r1"]])
    assert.deepEqual([rows.get("r0")?.submission?.state, rows.get("r1")?.submission?.state], ["rejected", "accepted"])
    assert.deepEqual(receipt(rows.get("r0"))?.issues?.map((entry) => entry.code), ["item_key_duplicate", "required"])
    assert.equal(rows.cardState()!.publish!.evidence.filter((item) => item.rowId === "r0").length, 1)
  } finally { await rows.close() }
})

test("blank and duplicate selections make zero prepare/transport calls", async () => {
  let prepares = 0
  const cap = capabilities()
  const prepare = cap.prepare
  cap.prepare = async (...args) => { prepares++; return prepare(...args) }
  const { rows, queue } = await fixture(cap)
  try {
    for (const rowIds of [[""], [" r0"], ["r0", "r0"]]) {
      await assert.rejects(queue.start([{ platform: "alpha", destination: "s1", rowIds }]), /空白或重复/)
    }
    await assert.rejects(queue.start([{ platform: " ", destination: "s1", rowIds: ["r0"] }]))
    assert.equal(prepares, 0)
    assert.equal(rows.get("r0")?.submission, undefined)
    assert.equal(rows.cardState()?.publish, undefined)
  } finally { await rows.close() }
})

test("queue instances share two slots and serialize the same platform/destination across cards", async () => {
  const harnesses = await Promise.all(["a", "b", "c"].map((cardId, index) => finalQueueHarness(1, index === 2 ? "s2" : "s1", { workspaceUuid: "shared", cardId })))
  let release!: () => void
  let twoStarted!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { twoStarted = resolve })
  const calls: string[] = []
  const activeKeys = new Set<string>()
  let maximum = 0
  const queues = harnesses.map(({ rows, scope }, index) => createSendQueue({ rows, ...scope, current: () => true, capabilities: {
    demo: { ...thirdPlatformCapability(), async send(destination, items) {
      assert.equal(activeKeys.has(destination), false, "same platform/store must be serial even in another card")
      activeKeys.add(destination); maximum = Math.max(maximum, activeKeys.size)
      calls.push(scope.cardId)
      if (calls.length === 2) twoStarted()
      if (index !== 1) await gate
      activeKeys.delete(destination)
      return queueAccepted(items)
    } },
  } }))
  const jobs = queues.map((queue, index) => queue.start([{ platform: "demo", destination: index === 2 ? "s2" : "s1", rowIds: ["r0"] }]))
  try {
    await started
    assert.deepEqual(calls, ["a", "c"])
    assert.equal(maximum, 2)
    release(); await Promise.all(jobs)
    assert.deepEqual(calls, ["a", "c", "b"])
    assert.ok(queues.every((queue) => queue.snapshot().counts.accepted === 1))
  } finally { release(); await Promise.allSettled(jobs); await Promise.all(harnesses.map(({ rows }) => rows.close())) }
})
