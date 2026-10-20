import assert from "node:assert/strict"
import test from "node:test"
import { createDiagnosticMemory } from "./diagnostic-memory"
import type { DiagnosticEvent } from "./diagnostic-summary"
import { diagnosticTestClock, testId } from "./diagnostic-test-support"

const event = (id: number): DiagnosticEvent => ({
  schema_version: 4, diagnostic_id: testId(id), code: "wasm_exception", platform: "wb", stage: "freeze",
  trace_id: "shared-trace", field: null, occurred_at: "2026-10-01T00:00:00.000Z", payload_sha256: "a".repeat(64),
  summary: [{ field: "title", value_type: "string", field_id: null, length: 4, enum_value: null }],
})
const original = (jsonText: string) => ({ provenance: "native_freeze" as const, jsonText })

test("same trace retains distinguishable IDs and readonly detail never exposes originals", () => {
  const memory = createDiagnosticMemory()
  for (const id of [1, 2]) memory.retain(event(id), original(`{"title":"raw-${id}"}`))
  const detail = memory.detail(testId(1))
  assert.equal(detail.event?.trace_id, memory.detail(testId(2)).event?.trace_id)
  assert.notEqual(detail.diagnosticId, memory.detail(testId(2)).diagnosticId)
  assert.equal(detail.hasOriginal, true)
  assert.ok(!JSON.stringify(detail).includes("raw-1"))
  assert.ok(Object.isFrozen(detail.event?.summary[0]))
  assert.equal(memory.copyData(testId(1)).originalJson, '{"title":"raw-1"}')
  memory.retain(event(1), original("overwritten"))
  assert.equal(memory.copyData(testId(1)).originalJson, '{"title":"raw-1"}', "same ID never overwrites an independent original")
})

test("100-entry oldest eviction reports not retained rather than a fictitious original", () => {
  const memory = createDiagnosticMemory()
  for (let id = 1; id <= 101; id++) memory.retain(event(id), original(String(id)))
  assert.deepEqual(memory.detail(testId(1)), { diagnosticId: testId(1), event: null, hasOriginal: false, originalUnavailableReason: "not_retained" })
  assert.equal(memory.copyData(testId(1)).originalJson, null)
  assert.equal(memory.copyData(testId(2)).originalJson, "2")
  assert.equal(memory.copyData(testId(101)).originalJson, "101")
})

test("combined 32 MiB budget evicts oldest originals while retaining hash and summary", () => {
  const memory = createDiagnosticMemory()
  const text = "x".repeat(7 * 1024 * 1024)
  for (let id = 1; id <= 5; id++) memory.retain(event(id), original(text))
  assert.equal(memory.detail(testId(1)).originalUnavailableReason, "byte_limit")
  assert.equal(memory.copyData(testId(1)).originalJson, null)
  assert.equal(memory.detail(testId(1)).event?.payload_sha256, "a".repeat(64))
  for (let id = 2; id <= 5; id++) assert.equal(memory.detail(testId(id)).hasOriginal, true)
})

test("single 8 MiB limit counts UTF8 bytes and keeps only structural evidence above the limit", () => {
  const memory = createDiagnosticMemory()
  memory.retain(event(1), original("x".repeat(8 * 1024 * 1024)))
  assert.equal(memory.detail(testId(1)).hasOriginal, true)
  memory.retain(event(2), original("界".repeat(3 * 1024 * 1024)))
  assert.equal(memory.detail(testId(2)).originalUnavailableReason, "oversize")
  assert.equal(memory.detail(testId(2)).event?.payload_sha256, "a".repeat(64))
  assert.equal(memory.copyData(testId(2)).originalJson, null)
  assert.equal(memory.copyData(testId(2)).provenance, "native_freeze", "known provenance survives original eviction")
})

test("30-minute TTL is absolute, copy does not extend it, and clear fences all generations", () => {
  let now = 0
  const memory = createDiagnosticMemory(() => now)
  memory.retain(event(1), original("raw"))
  now = 30 * 60 * 1000 - 1
  assert.equal(memory.copyData(testId(1)).originalJson, "raw")
  now++
  assert.equal(memory.detail(testId(1)).originalUnavailableReason, "expired")
  assert.equal(memory.detail(testId(1)).event?.summary.length, 1)
  assert.equal(memory.copyData(testId(1)).originalJson, null)
  memory.clear()
  assert.equal(memory.detail(testId(1)).event, null)
  memory.retain(event(1), original("new-generation"))
  assert.equal(memory.copyData(testId(1)).originalJson, "new-generation")
})

test("absence of exact text has a truthful no-exact-payload copy result", () => {
  const memory = createDiagnosticMemory()
  memory.retain({ ...event(1), payload_sha256: null, summary: [] }, null)
  assert.equal(memory.detail(testId(1)).originalUnavailableReason, "no_exact_payload")
  assert.equal(memory.copyData(testId(1)).provenance, null)
})

test("physical TTL cleanup runs during idle without reads and clear cancels its timer", async () => {
  const time = diagnosticTestClock()
  const memory = createDiagnosticMemory(time.clock.now, time.clock)
  memory.retain(event(1), original("raw"))
  assert.equal(time.timers.size, 1)
  await time.advance(30 * 60 * 1000)
  assert.equal(time.timers.size, 0, "expiry ran without detail/copy access")
  assert.equal(memory.detail(testId(1)).originalUnavailableReason, "expired")
  memory.retain(event(2), original("new"))
  assert.equal(time.timers.size, 1)
  memory.clear()
  assert.equal(time.timers.size, 0)
  assert.equal(memory.copyData(testId(2)).originalJson, null)
})

test("a stale expiry callback cannot discard or unschedule originals from a newer generation", () => {
  const time = diagnosticTestClock()
  const memory = createDiagnosticMemory(time.clock.now, time.clock)
  memory.retain(event(1), original("old"))
  const stale = [...time.timers.values()][0]!.callback
  memory.clear()
  memory.retain(event(1), original("new"))
  stale()
  assert.equal(memory.copyData(testId(1)).originalJson, "new")
  assert.equal(time.timers.size, 1)
  memory.clear()
})
