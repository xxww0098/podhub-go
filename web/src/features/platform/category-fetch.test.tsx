import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { components } from "@/api/schema"
import { route } from "@/api/routes"
import { adminHttp, type CatalogFetchConfigData } from "@/bindings/http-admin"

import {
  PlatformCategoryFetchScreen,
  configuredClientIds,
  coordinateFreshnessBadge,
  draftFromView,
  draftIsSubmittable,
  formatLocalDateTime,
  formatOffset,
  minuteOfDayFromTimeInput,
  requestFromDraft,
  timeInputFromMinuteOfDay,
  updateCategoryKey,
  type CategoryFetchDraft,
} from "./category-fetch"

type ConfigView = CatalogFetchConfigData
type KeyView = components["schemas"]["CatalogFetchKeyView"]

function keyView(clientId: string, apiKeyConfigured = true, disabled = false): KeyView {
  return { client_id: clientId, api_key_configured: apiKeyConfigured, disabled }
}

function view(overrides: Partial<ConfigView> = {}): ConfigView {
  return {
    enabled: true,
    schedule_mode: "fixed",
    at_minute: 180,
    window_start_minute: 120,
    window_end_minute: 240,
    utc_offset_minutes: 480,
    keys: [keyView("4995868"), keyView("5111222")],
    next_run_at_ms: 1_788_000_000_000,
    last_run_at_ms: null,
    last_status: null,
    last_error: "",
    last_duration_ms: null,
    last_root_nodes: null,
    last_key_client_id: null,
    last_key_attempts: 0,
    failure_streak: 0,
    running: false,
    coordinate_freshness: { total: 0, fresh: 0, stale: 0, expired: 0, missing: 0 },
    updated_at_ms: 0,
    ...overrides,
  }
}

function draft(overrides: Partial<CategoryFetchDraft> = {}): CategoryFetchDraft {
  return {
    enabled: true,
    scheduleMode: "fixed",
    atMinute: "03:00",
    windowStartMinute: "02:00",
    windowEndMinute: "04:00",
    utcOffsetMinutes: 480,
    keys: [{ clientId: "4995868", apiKey: "", disabled: false }],
    ...overrides,
  }
}

test("类目配置读写使用裸 DTO 并保留服务器拒绝", async () => {
  const original = globalThis.fetch
  const expected = view({ enabled: false, keys: [] })
  const calls: string[] = []
  let refuse = false
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), route("adminCatalogFetchConfig"))
    calls.push(init?.method ?? "GET")
    return refuse
      ? Response.json({ error: "计划未接通", code: "not_ported" }, { status: 501 })
      : Response.json(expected)
  }) as typeof fetch
  try {
    const request = requestFromDraft(draft({ enabled: false, keys: [] }))
    const enabledRequest = requestFromDraft(draft())
    assert.ok(request)
    assert.ok(enabledRequest)
    assert.deepEqual(await adminHttp.catalogFetchConfig(), expected)
    assert.deepEqual(await adminHttp.saveCatalogFetchConfig(request), expected)
    refuse = true
    await assert.rejects(adminHttp.saveCatalogFetchConfig(enabledRequest), { status: 501, message: "计划未接通" })
    assert.deepEqual(calls, ["GET", "PUT", "PUT"])
  } finally { globalThis.fetch = original }
})

test("立即抓取读取裸 DTO，不要求 data 信封", async () => {
  const original = globalThis.fetch
  const expected = view({ running: true })
  const calls: string[] = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), route("adminCatalogFetchConfigRun"))
    calls.push(init?.method ?? "GET")
    return Response.json(expected)
  }) as typeof fetch
  try {
    assert.deepEqual(await adminHttp.runCatalogFetch(), expected)
    assert.deepEqual(calls, ["POST"])
  } finally { globalThis.fetch = original }
})

test("时间输入与当天分钟数互为两种写法", () => {
  assert.equal(minuteOfDayFromTimeInput("00:00"), 0)
  assert.equal(minuteOfDayFromTimeInput("03:00"), 180)
  assert.equal(minuteOfDayFromTimeInput("23:59"), 1439)
  assert.equal(minuteOfDayFromTimeInput(" 03:00 "), 180)
  for (const bad of ["", "24:00", "3:00", "03:60", "0300", "3:0"]) {
    assert.equal(minuteOfDayFromTimeInput(bad), null, bad)
  }
  assert.equal(timeInputFromMinuteOfDay(0), "00:00")
  assert.equal(timeInputFromMinuteOfDay(180), "03:00")
  assert.equal(timeInputFromMinuteOfDay(1439), "23:59")
  // Out-of-range input is clamped rather than rendered as an invalid time.
  assert.equal(timeInputFromMinuteOfDay(-5), "00:00")
  assert.equal(timeInputFromMinuteOfDay(5000), "23:59")
})

test("时间按配置的时区渲染，不用浏览器时区", () => {
  // 2026-08-18T16:00:00Z: midnight in Shanghai, still the 18th in UTC.
  const instant = 1_787_068_800_000
  assert.equal(formatLocalDateTime(instant, 480), "2026-08-19 00:00 UTC+8")
  assert.equal(formatLocalDateTime(instant, 0), "2026-08-18 16:00 UTC+0")
  assert.equal(formatOffset(480), "UTC+8")
  assert.equal(formatOffset(0), "UTC+0")
  assert.equal(formatOffset(-300), "UTC-5")
  assert.equal(formatOffset(330), "UTC+5:30")
})

test("草稿到请求保留密钥留空、去空格并按顺位翻译", () => {
  const fromView = draftFromView(view())
  assert.equal(fromView.keys.length, 2)
  assert.equal(fromView.keys[0].clientId, "4995868")
  // The stored secret is never read back, so every row starts blank.
  assert.equal(fromView.keys[0].apiKey, "")
  assert.equal(fromView.atMinute, "03:00")

  const request = requestFromDraft({
    ...fromView,
    keys: [
      { clientId: " 5111222 ", apiKey: "  fresh-key  ", disabled: false },
      { clientId: "4995868", apiKey: "", disabled: false },
    ],
  })
  assert.ok(request)
  assert.deepEqual(request.keys, [
    { client_id: "5111222", api_key: "fresh-key" },
    { client_id: "4995868", api_key: "" },
  ])
  assert.equal(request.at_minute, 180)
  assert.equal(request.enabled, true)
})

test("空配置的首把密钥在编辑时才加入，未填完整不能提交", () => {
  const initial = draft({ enabled: false, keys: [] })
  const withClient = updateCategoryKey(initial, 0, { clientId: "client-1" })
  assert.deepEqual(initial.keys, [])
  assert.equal(draftIsSubmittable(withClient, view({ keys: [] })), false)
  const complete = updateCategoryKey(withClient, 0, { apiKey: "secret" })
  assert.equal(draftIsSubmittable(complete, view({ keys: [] })), true)
  assert.deepEqual(requestFromDraft(complete)?.keys, [{ client_id: "client-1", api_key: "secret" }])
})

test("清空的时间输入不会被当成 00:00 提交", () => {
  assert.equal(requestFromDraft(draft({ atMinute: "" })), null)
  assert.equal(requestFromDraft(draft({ scheduleMode: "random", windowEndMinute: "" })), null)
})

test("提交按钮的判定与 Cloud 的规则一致", () => {
  const saved = view()
  const configured = configuredClientIds(saved)
  assert.deepEqual([...configured].sort(), ["4995868", "5111222"])
  assert.equal(configured.has("3333333"), false)

  // A kept stored secret is enough; enabling with nothing to run with is not.
  assert.equal(draftIsSubmittable(draft(), saved), true)
  assert.equal(draftIsSubmittable(draft({ keys: [] }), saved), false)
  assert.equal(
    draftIsSubmittable(
      draft({ keys: [{ clientId: "3333333", apiKey: "", disabled: false }] }),
      saved,
    ),
    false,
  )
  assert.equal(
    draftIsSubmittable(
      draft({ keys: [{ clientId: "3333333", apiKey: "fresh", disabled: false }] }),
      saved,
    ),
    true,
  )

  // A paused installation may keep an empty list, but new rows still need secrets.
  assert.equal(draftIsSubmittable(draft({ enabled: false, keys: [] }), saved), true)
  assert.equal(
    draftIsSubmittable(
      draft({ enabled: false, keys: [{ clientId: "3333333", apiKey: "", disabled: false }] }),
      saved,
    ),
    false,
  )

  // Duplicates, blanks and a ninth key are all refused before the request.
  assert.equal(
    draftIsSubmittable(
      draft({
        keys: [
          { clientId: "4995868", apiKey: "", disabled: false },
          { clientId: " 4995868 ", apiKey: "", disabled: false },
        ],
      }),
      saved,
    ),
    false,
  )
  assert.equal(
    draftIsSubmittable(
      draft({ keys: [{ clientId: "  ", apiKey: "x", disabled: false }] }),
      saved,
    ),
    false,
  )
  const nine = Array.from({ length: 9 }, (_, index) => ({
    clientId: "50" + index,
    apiKey: "x",
    disabled: false,
  }))
  assert.equal(draftIsSubmittable(draft({ keys: nine }), saved), false)

  // The random window must still advance inside one day.
  assert.equal(
    draftIsSubmittable(
      draft({
        scheduleMode: "random",
        windowStartMinute: "04:00",
        windowEndMinute: "04:00",
      }),
      saved,
    ),
    false,
  )
  // Cloud validates the window even when fixed-time mode is selected.
  assert.equal(
    draftIsSubmittable(draft({ windowStartMinute: "04:00", windowEndMinute: "04:00" }), saved),
    false,
  )
})

test("启用计划需要有效密钥，重新填写已禁用的密钥可恢复", () => {
  const retired = view({ keys: [keyView("4995868", true, true)] })
  assert.equal(draftIsSubmittable(draft(), retired), false)
  assert.equal(draftIsSubmittable(draft({ enabled: false }), retired), true)
  assert.equal(
    draftIsSubmittable(
      draft({ keys: [{ clientId: "4995868", apiKey: "new-secret", disabled: true }] }),
      retired,
    ),
    true,
  )
  // The saved status belongs to Client-Id, not to an editable row's old flag.
  assert.equal(
    draftIsSubmittable(
      draft({ keys: [{ clientId: "5111222", apiKey: "", disabled: true }] }),
      view({ keys: [keyView("4995868", true, true), keyView("5111222")] }),
    ),
    true,
  )
})

test("配置好的密钥按顺位成行，并写清回退与留空规则", () => {
  const html = renderToStaticMarkup(<PlatformCategoryFetchScreen initialConfig={view()} />)
  const sections = [...html.matchAll(/<section aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)]
  const keys = sections.find(([, , body]) => body.includes(">平台密钥</h3>"))
  const schedule = sections.find(([, , body]) => body.includes(">抓取计划</h3>"))
  assert.ok(keys && schedule)
  assert.notEqual(keys[1], schedule[1])
  assert.match(keys[2], /id="catalog-key-client-0"/)
  assert.doesNotMatch(keys[2].split("</header>", 1)[0], /\bsr-only\b/)
  assert.doesNotMatch(schedule[2], /id="catalog-key-client-0"/)
  assert.doesNotMatch(schedule[2].split("</header>", 1)[0], /\bsr-only\b/)
  assert.match(html, /平台密钥/)
  assert.match(html, /4995868/)
  assert.match(html, /5111222/)
  assert.match(html, /第 1 顺位/)
  assert.match(html, /第 2 顺位/)
  assert.match(html, /已保存，留空表示不修改/)
  assert.match(html, /添加密钥/)
  assert.match(html, /按顺位依次尝试/)
  assert.match(html, /抓取计划/)
  assert.match(html, /2 把/)
  // Reorder / delete affordances stay reachable for assistive technology.
  assert.match(html, /上移第 2 把密钥/)
  assert.match(html, /删除第 1 把密钥/)
  assert.match(html, /显示第 1 把 Api-Key/)
  assert.match(html, /id="catalog-key-secret-0"[^>]*type="password"/)
})

test("被禁用的密钥有禁用效果：徽标、弱化卡片与重新启用提示", () => {
  const html = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({
        keys: [
          keyView("4995868", true, true),
          keyView("5111222", true, false),
        ],
      })}
    />,
  )
  // The retired key says so and how to bring it back; the live one does not.
  assert.match(html, /已禁用/)
  assert.match(html, /data-disabled="true"/)
  assert.match(html, /已被 Ozon 拒绝，抓取时跳过；重新填写 Api-Key 并保存后重新启用。/)
  assert.match(html, /已禁用 1 把/)
  // Exactly one retired row: the second key's card stays fully enabled.
  assert.equal(html.match(/data-disabled="true"/g)?.length, 1)
  // Drafting a view keeps the flag attached to its Client-Id through reorders.
  const fromView = draftFromView(
    view({ keys: [keyView("4995868", true, true), keyView("5111222")] }),
  )
  assert.equal(fromView.keys[0].disabled, true)
  assert.equal(fromView.keys[1].disabled, false)
})

test("选择器触发器显示选项标签，而不是裸值（时区 480），且不再提供语言选择", () => {
  const html = renderToStaticMarkup(<PlatformCategoryFetchScreen initialConfig={view()} />)
  // 弹层关着时列表不渲染 —— 标签只能来自触发器的 SelectValue。
  assert.match(html, /UTC\+8 北京/)
  assert.doesNotMatch(html, /data-slot="select-value"[^>]*>480</)
  assert.doesNotMatch(html, /id="catalog-language"|抓取语言/)
})

test("失败状态保留尝试次数但不把后端 error 原文写进 DOM", () => {
  const html = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({
        last_status: "failed",
        last_run_at_ms: 1_787_999_000_000,
        last_duration_ms: 1310,
        last_root_nodes: null,
        last_key_client_id: "5111222",
        last_key_attempts: 2,
        last_error:
          "2 把平台密钥都失败：Ozon 拒绝了平台密钥（HTTP 400）：请检查 Client-Id 与 Api-Key",
        failure_streak: 1,
      })}
    />,
  )
  assert.match(html, /尝试 2 把/)
  assert.match(html, /连续失败 1 次/)
  assert.match(html, /已试 2 把/)
  assert.doesNotMatch(html, /Ozon 拒绝了平台密钥/)
  assert.doesNotMatch(html, /role="alert"/)
})

test("进行中的抓取占用状态位并停用手动入口，但不锁表单", () => {
  const html = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({ running: true, last_status: "failed", failure_streak: 2 })}
    />,
  )
  // The in-flight run, not the previous failure, is the lead state.
  assert.match(html, /抓取中/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?抓取中…/)
  // Keys stay editable: a claimed run reads its own snapshot, a mid-run save is legal.
  assert.doesNotMatch(html, /id="catalog-key-client-0"[^>]*disabled=""/)
})

test("run 只发起认领，结果由 running 轮询上报", () => {
  const source = readFileSync(new URL("./category-fetch.tsx", import.meta.url), "utf8")
  const run = source.match(/async function run\(\) \{([\s\S]*?)\n  \}\n/)?.[1]
  assert.ok(run)
  assert.match(run, /runCatalogFetch/)
  // The verdict is not tied to the POST: it only fires for a recorded finish,
  // detected by `lastRunAtMs` advancing rather than the request's own timing.
  assert.doesNotMatch(run, /notifySuccess/)
  assert.match(run, /next\.last_run_at_ms !== view\?\.last_run_at_ms/)
  assert.match(run, /notifyCommandError\(reason, "立即抓取失败，请稍后重试。"\)/)

  const poll = source.match(/const timer = setInterval\(async \(\) => \{([\s\S]*?)\}, RUN_POLL_MS\)/)?.[1]
  assert.ok(poll)
  assert.match(poll, /catalogFetchConfig/)
  assert.match(poll, /reportRunResult/)
})

test("坐标时效汇总只渲染后端计数：stale/expired/missing 进提示徽标，全新鲜报总数", () => {
  // 前端不重算年龄——计数到哪档是后端 `catalog_freshness` 的事。
  assert.equal(
    coordinateFreshnessBadge({ total: 5, fresh: 4, stale: 1, expired: 0, missing: 0 })?.label,
    "1 个类目超过 24h 未刷新，0 个已过期，0 个缺失",
  )
  assert.equal(
    coordinateFreshnessBadge({ total: 5, fresh: 4, stale: 1, expired: 0, missing: 0 })?.tone,
    "attest",
  )
  // 已过期/缺失的行此刻就过不了上架门，提示升级为 bad。
  assert.equal(
    coordinateFreshnessBadge({ total: 5, fresh: 2, stale: 1, expired: 1, missing: 1 })?.tone,
    "bad",
  )
  assert.equal(
    coordinateFreshnessBadge({ total: 5, fresh: 2, stale: 1, expired: 1, missing: 1 })?.label,
    "1 个类目超过 24h 未刷新，1 个已过期，1 个缺失",
  )
  // 全 fresh → 一句安心账；无引用坐标/旧版响应缺字段 → 不显示。
  assert.deepEqual(
    coordinateFreshnessBadge({ total: 12, fresh: 12, stale: 0, expired: 0, missing: 0 }),
    { tone: "good", label: "类目数据新鲜（12 个）" },
  )
  assert.equal(
    coordinateFreshnessBadge({ total: 0, fresh: 0, stale: 0, expired: 0, missing: 0 }),
    null,
  )
  assert.equal(coordinateFreshnessBadge(undefined), null)
})

test("摘要区按计数渲染时效徽标", () => {
  const stale = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({
        coordinate_freshness: { total: 4, fresh: 2, stale: 1, expired: 1, missing: 0 },
      })}
    />,
  )
  assert.match(stale, /1 个类目超过 24h 未刷新，1 个已过期，0 个缺失/)
  assert.match(stale, /data-tone="bad"/)

  const fresh = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({
        coordinate_freshness: { total: 7, fresh: 7, stale: 0, expired: 0, missing: 0 },
      })}
    />,
  )
  assert.match(fresh, /类目数据新鲜（7 个）/)

  const zero = renderToStaticMarkup(<PlatformCategoryFetchScreen initialConfig={view()} />)
  assert.doesNotMatch(zero, /类目数据新鲜|超过 24h 未刷新/)
})

test("未配置时给出空列表提示与禁用态抓取按钮", () => {
  const html = renderToStaticMarkup(
    <PlatformCategoryFetchScreen
      initialConfig={view({ keys: [], enabled: false, next_run_at_ms: null })}
    />,
  )
  assert.match(html, /还没有配置平台密钥/)
  assert.match(html, /待配置密钥/)
  assert.match(html, /还没有执行过抓取/)
})

test("手动抓取只在已有可用的服务端密钥时开放", () => {
  for (const [keys, enabled] of [
    [[], false],
    [[keyView("retired", true, true)], false],
    [[keyView("unconfigured", false, false)], false],
    [[keyView("retired", true, true), keyView("active")], true],
  ] as const) {
    const html = renderToStaticMarkup(
      <PlatformCategoryFetchScreen initialConfig={view({ keys: [...keys], enabled: false })} />,
    )
    const button = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*立即抓取<\/button>/)?.[0]
    assert.ok(button)
    assert.equal(/\bdisabled=""/.test(button), !enabled)
    if (!enabled && keys.length > 0) assert.match(html, /无可用密钥/)
  }
})

test("类目配置不展示未开放的 WB 凭证表单", () => {
  const html = renderToStaticMarkup(<PlatformCategoryFetchScreen initialConfig={view()} />)
  assert.doesNotMatch(html, /WB|wb-content-api-token|类目抓取平台/)
})
