import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HomeStatusBar } from "./home-status-bar"

const counts = (overrides: Partial<{ needs_review: number; unknown: number; rejected: number; conflict: number; accepted_issue: number }> = {}) => ({
  needs_review: 0, unknown: 0, rejected: 0, conflict: 0, accepted_issue: 0, ...overrides,
})
const bar = (props: Partial<Parameters<typeof HomeStatusBar>[0]> = {}) =>
  renderToStaticMarkup(<HomeStatusBar workspaceSelected counts={counts()} overviewFailed={false} reviewFailed={false} onOpenQueue={() => {}} onRetry={() => {}} {...props} />)

test("a review count is one bar with its groups and a direct action", () => {
  const html = bar({ counts: counts({ needs_review: 3, unknown: 1, rejected: 1, conflict: 1 }) })
  assert.match(html, /3 项上架提交需要核对/)
  assert.match(html, /bg-brand-soft/)
  assert.match(html, /结果未知<span class="font-semibold tabular-nums">1<\/span>/)
  assert.match(html, /失败或冲突<span class="font-semibold tabular-nums">2<\/span>/)
  assert.match(html, /核对这3项/)
  assert.doesNotMatch(html, /没有待核对/)
})

test("zero keeps a quiet bar and offers no fake action", () => {
  const html = bar()
  assert.match(html, /没有待核对的上架提交/)
  assert.doesNotMatch(html, /核对这|bg-brand-soft/)
})

test("failures keep the retry next to the status, not in a second card", () => {
  for (const [props, message] of [
    [{ reviewFailed: true }, /待核对结果读取失败/],
    [{ overviewFailed: true }, /上架概况读取失败/],
  ] as const) {
    const html = bar(props)
    assert.match(html, message)
    assert.match(html, /重试/)
  }
})

test("no workspace explains the empty bar without inventing counts", () => {
  const html = bar({ workspaceSelected: false })
  assert.match(html, /选择工作空间后查看上架概况/)
  assert.doesNotMatch(html, /没有待核对|正在读取待核对结果/)
})
