import assert from "node:assert/strict"
import test from "node:test"
import type { ConsoleLedgerEntry, ListingCardSummary } from "@/bindings/commands"
import { CONSOLE_LEDGER_ROW_CAP } from "@/features/console/console-board"
import { findHomeModules, homeListingCount, homeListingHeadline, homeListingSummary, homeSearchTarget, recentHomePlans, reviewAttention, reviewScopeCount } from "./home-model"

test("module finder resolves business phrases and normalizes input without inventing results", () => {
  assert.equal(findHomeModules(" 帮我发布商品 ")[0]?.id, "listing")
  assert.equal(findHomeModules("SHIPPING")[0]?.id, "ops-shipping")
  assert.equal(findHomeModules("管理店铺")[0]?.id, "stores")
  assert.deepEqual(findHomeModules("不存在的功能"), [])
  assert.equal(findHomeModules("数据大屏")[0]?.id, "console")
  assert.equal(findHomeModules("经营数据")[0]?.id, "console")
  assert.equal(findHomeModules("我的商品")[0]?.id, "products")
  assert.equal(findHomeModules("  ")[0]?.id, "listing")
})

test("home listing totals exclude other seller writes and retain uncertain results", () => {
  const now = Date.now()
  const entry = (kind: ConsoleLedgerEntry["kind"], status: ConsoleLedgerEntry["status"]): ConsoleLedgerEntry => ({
    kind, status, created_at_ms: now, updated_at_ms: now,
  })
  const summary = homeListingSummary([
    entry("listing", "queued"), entry("listing", "result_unknown"),
    entry("listing", "failed"), entry("write", "failed"),
  ], now)
  assert.equal(summary.createdIn7Days, 3)
  assert.equal(summary.inFlight, 1)
  assert.equal(summary.needsAction, 2)
  assert.equal(summary.unknown, 1)
  assert.equal(summary.failed, 1)
})

test("home checks the unfiltered ledger cap before counting listings", () => {
  const now = Date.now()
  const write: ConsoleLedgerEntry = { kind: "write", status: "succeeded", created_at_ms: now, updated_at_ms: now }
  const listing: ConsoleLedgerEntry = { kind: "listing", status: "result_unknown", created_at_ms: now, updated_at_ms: now }
  const below = homeListingSummary([...Array(CONSOLE_LEDGER_ROW_CAP - 2).fill(write), listing], now)
  const atCap = homeListingSummary([...Array(CONSOLE_LEDGER_ROW_CAP - 1).fill(write), listing], now)
  const above = homeListingSummary([...Array(CONSOLE_LEDGER_ROW_CAP).fill(write), listing], now)
  assert.equal(below.mayBeTruncated, false)
  assert.equal(atCap.mayBeTruncated, true)
  assert.equal(above.mayBeTruncated, true)
  assert.equal(atCap.createdIn7Days, 1, "other seller writes do not become listing submissions")
  assert.equal(atCap.needsAction, 1)
  assert.equal(homeListingCount(atCap.needsAction, atCap.mayBeTruncated), "≥1")
  assert.equal(homeListingHeadline(atCap), "至少 1 项上架提交需要核对")
})

test("a truncated ledger with no visible listing exceptions does not claim none exist", () => {
  const now = Date.now()
  const write: ConsoleLedgerEntry = { kind: "write", status: "succeeded", created_at_ms: now, updated_at_ms: now }
  const incomplete = homeListingSummary(Array(CONSOLE_LEDGER_ROW_CAP).fill(write), now)
  const complete = homeListingSummary([], now)
  assert.equal(incomplete.needsAction, 0)
  assert.equal(homeListingCount(incomplete.needsAction, incomplete.mayBeTruncated), "≥0")
  assert.equal(homeListingHeadline(incomplete), "上架账本可能不完整")
  assert.equal(homeListingCount(complete.needsAction, complete.mayBeTruncated), "0")
  assert.equal(homeListingHeadline(complete), "近期上架提交暂无待核对事项")
})

test("one review count feeds the hero, KPI and attention rail", () => {
  const counts = { needs_review: 4, unknown: 1, rejected: 2, conflict: 1, accepted_issue: 1 }
  assert.deepEqual(reviewAttention(counts), [
    { kind: "unknown", label: "结果未知", count: 1, tone: "unknown" },
    { kind: "failed", label: "失败或冲突", count: 3, tone: "bad" },
    { kind: "accepted_issue", label: "受理后需核对", count: 1, tone: "bad" },
  ])
  assert.deepEqual(reviewAttention({ ...counts, unknown: 0, rejected: 0, conflict: 0, accepted_issue: 0 }), [])
})

test("an attention entry opens the count it actually showed", () => {
  const counts = { needs_review: 4, unknown: 1, rejected: 2, conflict: 1, accepted_issue: 1 }
  assert.equal(reviewScopeCount(counts, "all"), 4)
  assert.equal(reviewScopeCount(counts, "unknown"), 1)
  assert.equal(reviewScopeCount(counts, "failed"), 3)
  assert.equal(reviewScopeCount(counts, "accepted_issue"), 1)
})

test("empty or blank search has no destination", () => {
  assert.equal(homeSearchTarget("", 0), undefined)
  assert.equal(homeSearchTarget("   ", 0), undefined)
  assert.equal(homeSearchTarget("上架", 0), "listing")
  assert.equal(homeSearchTarget("不存在的功能", 0), undefined)
  assert.equal(homeSearchTarget("数据", 99), "console")
})

test("recent plans filter by name and show the newest without changing source order", () => {
  const card = (name: string, updated: number): ListingCardSummary => ({
    draft_id: name, display_name: name, description_category_id: 1, type_id: 1,
    language: "zh", ai_prompt_file_name: "", psd_template_file_name: "", target_store_id: "", video_count: 0, updated_at_ms: updated,
  })
  const cards = [card("T恤", 1), card("帆布包", 3), card("T恤蓝", 2)]
  assert.deepEqual(recentHomePlans(cards, "t恤").map((item) => item.draft_id), ["T恤蓝", "T恤"])
  assert.deepEqual(cards.map((item) => item.draft_id), ["T恤", "帆布包", "T恤蓝"])
})

test("recent plans filter by the whole store ID including multi-store plans", () => {
  const card = (id: string, stores: string): ListingCardSummary => ({
    draft_id: id, display_name: id, description_category_id: 1, type_id: 1,
    language: "zh", ai_prompt_file_name: "", psd_template_file_name: "", target_store_id: stores, video_count: 0, updated_at_ms: 1,
  })
  const cards = [card("multi", "store-1, store-2"), card("other", "store-12"), card("unbound", "")]
  assert.deepEqual(recentHomePlans(cards, "", "store-1").map((item) => item.draft_id), ["multi"])
  assert.deepEqual(recentHomePlans(cards, "", "store-2").map((item) => item.draft_id), ["multi"])
  assert.deepEqual(recentHomePlans(cards, "multi", "store-12"), [])
})

