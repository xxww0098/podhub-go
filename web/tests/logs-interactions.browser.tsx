import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AdminErrorLogView, AdminUsageRequestView, AdminUsageSummaryData } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { AdminErrorsScreen, AdminUsageScreen, RequestRow } from "@/features/platform/logs"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

const request: AdminUsageRequestView = {
  request_id: "req-fixture", workspace_name: "测试空间", email: "test@example.invalid", model: "model",
  channel_name: "测试渠道", thinking_depth: "high", api_format: "responses", operation: "ai_token", status: "failed",
  input_tokens: 100, output_tokens: 50, cached_input_tokens: 25, reasoning_output_tokens: 10,
  total_microfen: 100, charged_microfen: 80, absorbed_microfen: 20, error_class: "upstream_error",
  upstream_error: "测试上游错误", created_at: "2026-10-28T00:00:00Z", latency_ms: 1200, generation_speed_milli_tps: 42000,
}
const error: AdminErrorLogView = {
  event_id: "event-fixture", workspace_name: "测试空间", email: "test@example.invalid", device_uid: "device-fixture",
  source: "workbench", code: "test:error", severity: "degraded", fingerprint: "fingerprint", message: "测试错误".repeat(40),
  params: null, app_version: "1.0", os: "test", occurred_at: "2026-10-28T00:00:00Z", received_at: "2026-10-28T00:00:00Z",
}
const summary: AdminUsageSummaryData = {
  total_rows: 0, settled_rows: 0, failed_rows: 0, unbilled_unknown_rows: 0, in_flight_rows: 0,
  input_tokens: 0, cached_input_tokens: 0, cache_hit_rate_bps: 0, output_tokens: 0, charged_microfen: 0,
  absorbed_microfen: 0, latency_p50_ms: null, latency_p90_ms: null, latency_p99_ms: null,
  upstream_latency_p50_ms: null, upstream_latency_p90_ms: null, upstream_latency_p99_ms: null,
  generation_speed_milli_tps_median: null, failure_classes: [],
}
const empty = { page: 1, page_size: 10, total_pages: 1, total_rows: 0, rows: [] }

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const originalRequests = adminHttp.adminListAiRequests
  const originalSummary = adminHttp.adminAiUsageSummary
  const originalErrors = adminHttp.adminListErrorLogs
  const root = createRoot(fixture)
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 2000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  try {
    flushSync(() => root.render(<table><tbody><RequestRow row={request} /></tbody></table>))
    const detail = fixture.querySelector<HTMLButtonElement>("button[aria-expanded]")!
    detail.click()
    await settle(() => detail.getAttribute("aria-expanded") === "true", "request details did not open")
    for (const value of ["测试渠道", "high", "responses", "42.0 t/s", "upstream_error", "测试上游错误"]) {
      check(fixture.textContent?.includes(value), `request detail lost ${value}`)
    }
    detail.click()
    await settle(() => detail.getAttribute("aria-expanded") === "false", "request details did not close")

    adminHttp.adminListAiRequests = async () => { throw new Error("offline") }
    adminHttp.adminAiUsageSummary = async () => summary
    flushSync(() => root.render(<AdminUsageScreen />))
    await settle(() => !!fixture.querySelector('[role="alert"]'), "request read failure not shown")
    check(!fixture.textContent?.includes("暂无 API 请求日志"), "failed request read was presented as empty")
    adminHttp.adminListAiRequests = async () => empty
    fixture.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
    await settle(() => !!fixture.textContent?.includes("暂无 API 请求日志"), "request retry did not load empty result")
    check(fixture.querySelector("thead")?.textContent?.includes("时间"), "empty request table lost its headings")
    const stats = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("统计"))!
    check(stats.getAttribute("aria-expanded") === "false", "summary should start collapsed")
    stats.click()
    await settle(() => stats.getAttribute("aria-expanded") === "true" && !!fixture.textContent?.includes("上游延迟"), "summary did not expand")
    const calls: Array<[number, number, string | undefined]> = []
    adminHttp.adminListAiRequests = async (page, size, filters) => { calls.push([page, size, filters.since]); return { ...empty, page, page_size: size, total_pages: 3, total_rows: 25 } }
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新 API 请求日志"]')!.click()
    await settle(() => calls.length > 0 && !!fixture.textContent?.includes("共 25 条"), "request refresh did not load")
    const defaultAge = Date.now() - Date.parse(calls.at(-1)?.[2] ?? "")
    check(Math.abs(defaultAge - 30 * 86_400_000) < 10_000, "default 30-day filter was not sent")
    fixture.querySelector<HTMLButtonElement>('[aria-label="第 2 页"]')!.click()
    await settle(() => calls.some(([page]) => page === 2), "request next page did not load")
    fixture.querySelector<HTMLButtonElement>('[aria-label="每页日志条数"]')!.click()
    await settle(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === "20 条"), "page size options did not open")
    ;([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === "20 条"))!.click()
    await settle(() => calls.some(([page, size]) => page === 1 && size === 20), "changing page size did not reset the page")
    fixture.querySelector<HTMLButtonElement>('[aria-label="按访问时间筛选"]')!.click()
    await settle(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.trim() === "最近 7 天"), "time options did not open")
    ;([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === "最近 7 天"))!.click()
    await settle(() => !!fixture.querySelector('[aria-label="按访问时间筛选"]')?.textContent?.includes("最近 7 天"), "time selection did not update")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选"]')!.click()
    await settle(() => calls.some(([, , since]) => Math.abs(Date.now() - Date.parse(since ?? "") - 7 * 86_400_000) < 10_000), "seven-day filter was not sent")

    let errorSince: string | undefined
    adminHttp.adminListErrorLogs = async (_page, _size, filters) => { errorSince = filters.since; return { ...empty, total_rows: 1, rows: [error] } }
    flushSync(() => root.render(<AdminErrorsScreen />))
    await settle(() => !!fixture.textContent?.includes("test:error"), "error row did not load")
    check(Math.abs(Date.now() - Date.parse(errorSince ?? "") - 30 * 86_400_000) < 10_000, "default error filter was not sent")
    const errorDetail = fixture.querySelector<HTMLButtonElement>('[aria-label="展开错误详情 test:error"]')!
    errorDetail.click()
    await settle(() => errorDetail.getAttribute("aria-expanded") === "true", "error detail did not expand")
    errorDetail.click()
    await settle(() => errorDetail.getAttribute("aria-expanded") === "false", "error detail did not collapse")
    fixture.querySelector<HTMLElement>('[aria-label="选择错误日志 test:error"]')!.click()
    await settle(() => !!fixture.textContent?.includes("删除 1 条"), "error selection did not work")
    adminHttp.adminListErrorLogs = async () => { throw new Error("offline") }
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新错误日志"]')!.click()
    await settle(() => !!fixture.textContent?.includes("读取失败，当前显示上次读取结果"), "stale error result not identified")
    check(!fixture.textContent?.includes("删除 1 条"), "stale selection remained actionable")
    const staleCheckbox = fixture.querySelector<HTMLElement>('[aria-label="选择错误日志 test:error"]')
    check(staleCheckbox?.hasAttribute("disabled") || staleCheckbox?.getAttribute("aria-disabled") === "true", `stale row can be selected: ${staleCheckbox?.outerHTML}`)
    adminHttp.adminListErrorLogs = async () => empty
    fixture.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
    await settle(() => !!fixture.textContent?.includes("暂无错误日志"), "error retry did not load empty result")
    check(fixture.querySelector("thead")?.textContent?.includes("接收时间"), "empty error table lost its headings")
    const emptyCheckbox = fixture.querySelector<HTMLElement>('[aria-label="选择本页错误日志"]')
    check(emptyCheckbox?.hasAttribute("disabled") || emptyCheckbox?.getAttribute("aria-disabled") === "true", "empty error table allowed selection")
    results.textContent = "PASS: details, failed reads, stale selection and retry"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    adminHttp.adminListAiRequests = originalRequests
    adminHttp.adminAiUsageSummary = originalSummary
    adminHttp.adminListErrorLogs = originalErrors
    run.disabled = false
  }
}
