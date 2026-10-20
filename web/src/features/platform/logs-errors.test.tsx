import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { UsageStatsPanel } from "@/features/usage/usage-stats-panel"

import {
  AdminErrorsScreen,
  detailLabel,
  errorLogsTsv,
  severityLabel,
  sinceForPeriod,
  sourceLabel,
} from "./logs"

test("time presets produce stable inclusive lower bounds", () => {
  const now = Date.parse("2026-08-24T07:00:00.000Z")
  assert.equal(sinceForPeriod("24h", now), "2026-08-23T07:00:00.000Z")
  assert.equal(sinceForPeriod("7d", now), "2026-08-17T07:00:00.000Z")
  assert.equal(sinceForPeriod("30d", now), "2026-07-25T07:00:00.000Z")
})

test("the log range cannot promise data older than the retention window", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  assert.match(source, /period: "30d"/)
  assert.doesNotMatch(source, /<SelectItem value="all">全部时间/)
})

test("source labels name the inbox desktop_error_log sources", () => {
  assert.equal(sourceLabel("workbench"), "工作台")
  assert.equal(sourceLabel("host_panic"), "Host 崩溃")
  assert.equal(sourceLabel("renderer_rejection"), "界面未处理拒绝")
  assert.equal(sourceLabel(""), "")
})

test("the source filter drops the two sources that can never produce a row", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const dropped of ["renderer_gone", "host_unhandled_rejection"]) {
    assert.doesNotMatch(source, new RegExp(dropped), `${dropped} always returns 0 rows`)
  }
  for (const kept of ["host_panic", "host_command", "renderer_uncaught", "renderer_rejection"]) {
    assert.match(source, new RegExp(`SelectItem value="${kept}"`))
  }
})

test("v2 rows read as code plus severity, v1 rows keep their message", () => {
  assert.equal(severityLabel("blocking"), "阻断")
  assert.equal(severityLabel("degraded"), "降级")
  assert.equal(severityLabel(null), "")
  assert.equal(
    detailLabel({ message: null, params: '{"imageIndex":3,"occurrences":2}' }),
    "imageIndex=3 · occurrences=2",
  )
  assert.equal(detailLabel({ message: "draft-1 · 上传失败", params: null }), "draft-1 · 上传失败")
  assert.equal(detailLabel({ message: null, params: null }), "")
})

test("copied rows are spreadsheet-ready and flatten multiline details", () => {
  const text = errorLogsTsv([
    {
      event_id: "event-1",
      workspace_name: "演示 Workspace",
      email: "admin@example.invalid",
      device_uid: "device-1",
      source: "workbench",
      code: "ai:quota",
      severity: "degraded",
      fingerprint: "abc123",
      message: "第一行\n第二行",
      params: null,
      app_version: "0.0.21",
      os: "macos 15 arm64",
      occurred_at: "2026-08-31T01:00:00.000Z",
      received_at: "2026-08-31T01:00:01.000Z",
    },
  ])
  const lines = text.split("\n")
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^接收时间\tWorkspace\t用户邮箱/)
  assert.match(lines[1], /工作台\tai:quota\t降级\t第一行 第二行\tabc123\tdevice-1/)
})

test("workbench system errors stay on the staff-only platform screen", () => {
  const operator = renderToStaticMarkup(<UsageStatsPanel workspaceId={1} workspaceName="演示 Workspace" />)
  for (const column of ["错误码", "用户邮箱", "接收时间"]) {
    assert.doesNotMatch(operator, new RegExp(column), `${column} must stay off the 用量 screen`)
  }

  const staff = renderToStaticMarkup(<AdminErrorsScreen />)
  assert.match(staff, /错误日志/)
  assert.match(staff, /搜索错误日志/)
})

test("the staff error log shows an empty state before any row arrives", () => {
  const html = renderToStaticMarkup(<AdminErrorsScreen />)
  assert.match(html, /暂无错误日志/)
  assert.doesNotMatch(html, /加载失败/)
})

test("the table names Workspace, email, source and detail and exposes no credential column", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const column of ["Workspace", "用户邮箱", "来源", "错误码", "详情", "指纹", "设备", "版本"]) {
    assert.match(source, new RegExp(`TableHead[^>]*>${column}`))
  }
  assert.doesNotMatch(source, /凭据/)
  assert.doesNotMatch(source, /api_key/)
  assert.doesNotMatch(source, /session_token/)
})

test("the staff error log has server-backed source filters", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const label of ["搜索错误日志", "按错误来源筛选", "按接收时间筛选"]) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /adminListErrorLogs\(targetPage, PAGE_SIZE, filters\)/)
  assert.match(source, /没有符合当前筛选条件的错误/)
})

test("the staff error log supports page selection, quick copy and confirmed batch deletion", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const contract of [
    "选择本页错误日志",
    "复制错误日志",
    "adminDeleteErrorLogs",
    "确认删除",
  ]) {
    assert.match(source, new RegExp(contract))
  }
})
