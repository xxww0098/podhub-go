/**
 * What each 运维 screen does with a Cloud refusal.
 *
 * The screens branch on Cloud's `OpsErrorCode` (`ozon_auth_failed`,
 * `ozon_shipping_failed`, …). `@/api/client` hands them to the renderer as
 * `cloud_<lowercase>` — every branch is pinned here against a stubbed 4xx
 * carrying the real Cloud body (`OpsErrorResponse`: `{ error, code }`).
 *
 * One test per screen. The four read screens project the rejection into their
 * own failure state, so the assertion is that state; the three write / refresh
 * screens branch inside a component, so the assertion is the code that arrives
 * plus the branch that reads it.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { opsHttp } from "../src/bindings/http-ops"
import {
  commandErrorCode,
  CONSOLE_REFRESH_BUSY_CODE,
  errorMessage,
  SELLER_RESULT_UNKNOWN_CODE,
  WRITES_DISABLED_CODE,
} from "../src/lib/error-message"
import {
  commandFailure,
  describeFailure,
  isAuthFailure,
} from "../src/features/ops/shipping/shipping-model"
import { asOpsListError, isAuthError } from "../src/features/ops/returns/returns-model"
import { runVoiceRead, voiceReadState, emptyReviews } from "../src/features/ops/voice/voice-model"
import { runSupplyRead, EMPTY_SUPPLY_LIST } from "../src/features/ops/supply/supply-model"
import { inboxError, sendError } from "../src/features/message-center/message-center-model"

/** One Cloud refusal, in the body the 运维 routes actually write. */
function refuses(status: number, code: string, error: string): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error, code }), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = previous
  }
}

async function refusal(status: number, code: string, error: string, call: () => Promise<unknown>) {
  const restore = refuses(status, code, error)
  try {
    await call()
    assert.fail(`${code} must reject`)
  } catch (reason) {
    return reason
  } finally {
    restore()
  }
}

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")
}

// --- 发货 --------------------------------------------------------------------

test("发货：被拒的 Ozon 凭据仍然是「无权限」，其他失败仍然是「读取失败」", async () => {
  const refused = await refusal(502, "ozon_auth_failed", "Ozon API Key 无效", () =>
    opsHttp.opsShippingList({
      store_id: "store-1",
      status: "",
      window_days: 7,
      cursor: null,
      limit: 50,
    }),
  )
  const authFailure = commandFailure(refused, "读取 FBS 待发货单失败")
  assert.equal(authFailure.code, "cloud_ozon_auth_failed")
  assert.equal(describeFailure(authFailure), "Ozon API Key 无效")
  assert.ok(isAuthFailure(authFailure))

  const upstream = await refusal(502, "ozon_shipping_failed", "查询时间跨度超出上限", () =>
    opsHttp.opsShippingList({
      store_id: "store-1",
      status: "",
      window_days: 400,
      cursor: null,
      limit: 50,
    }),
  )
  const failure = commandFailure(upstream, "读取 FBS 待发货单失败")
  assert.equal(failure.code, "cloud_ozon_shipping_failed")
  assert.equal(failure.message, "查询时间跨度超出上限")
  assert.ok(!isAuthFailure(failure))
})

// --- 退货 --------------------------------------------------------------------

test("退货：401 走登录失效，屏幕自己的失败码不被当成无权限", async () => {
  const expired = await refusal(401, "auth_required", "登录已失效", () =>
    opsHttp.opsReturnsList({
      store_id: "store-1",
      posting_number: "",
      visual_status_name: "",
      return_schema: "",
      last_id: null,
    }),
  )
  assert.ok(isAuthError(asOpsListError(expired, "读取退货单失败")))

  const upstream = await refusal(502, "ozon_ops_returns_failed", "ONLY_ONE_DATE_FILTER_ALLOWED", () =>
    opsHttp.opsCancellationsList({
      store_id: "store-1",
      posting_number: "",
      state: "",
      initiator: "",
      last_id: null,
    }),
  )
  const error = asOpsListError(upstream, "读取取消申请失败")
  assert.equal(error.code, "cloud_ozon_ops_returns_failed")
  assert.equal(error.message, "ONLY_ONE_DATE_FILTER_ALLOWED")
  assert.ok(!isAuthError(error))
})

// --- 口碑 --------------------------------------------------------------------

test("口碑：读取失败把 Ozon 的原话留在面板上，快照不被清空", async () => {
  let state = voiceReadState(emptyReviews())
  const restore = refuses(502, "ozon_voice_failed", "Ozon 评价列表暂不可用")
  try {
    await assert.rejects(
      runVoiceRead({
        mode: "replace",
        request: () => opsHttp.opsVoiceListReviews({ store_id: "store-1", last_id: null }),
        isCurrent: () => true,
        setState: (update) => {
          state = update(state)
        },
        fallback: "读取未回复评价失败",
      }),
    )
  } finally {
    restore()
  }
  assert.equal(state.error, "Ozon 评价列表暂不可用")
  assert.equal(state.errorMode, "replace")
  assert.equal(state.hasSnapshot, false)
})

// --- 供货 --------------------------------------------------------------------

test("供货：限流不是空列表，画面保留上一页并说明原因", async () => {
  let state = { view: EMPTY_SUPPLY_LIST, loading: false, error: "" }
  const restore = refuses(429, "ozon_rate_limited", "Ozon 读取频率已达上限，请稍后重试")
  try {
    const accepted = await runSupplyRead({
      request: () =>
        opsHttp.opsSupplyList({
          store_id: "store-1",
          last_id: null,
          states: [],
          document_number_search: null,
        }),
      isCurrent: () => true,
      setState: (update) => {
        state = update(state)
      },
      fallback: "读取供货单失败",
    })
    assert.equal(accepted, false)
  } finally {
    restore()
  }
  assert.equal(state.error, "Ozon 读取频率已达上限，请稍后重试")
  assert.deepEqual(state.view, EMPTY_SUPPLY_LIST)
})

// --- 商品 --------------------------------------------------------------------

test("商品：未确认的写入变成 Result Unknown 行，只提供对账；写入停用只说停用", async () => {
  const command = {
    operation_id: "op-1",
    store_id: "store-1",
    request: { kind: "archive" as const, product_ids: [7] },
  }
  const unknown = await refusal(
    409,
    "seller_result_unknown",
    "这次商品写入已发出，Ozon 未确认结果",
    () => opsHttp.productsMutate(command),
  )
  assert.equal(commandErrorCode(unknown), SELLER_RESULT_UNKNOWN_CODE)
  assert.equal(errorMessage(unknown, "写入失败"), "这次商品写入已发出，Ozon 未确认结果")

  const disabled = await refusal(503, "writes_disabled", "Ozon 实时写入已停止", () =>
    opsHttp.productsMutate(command),
  )
  assert.equal(commandErrorCode(disabled), WRITES_DISABLED_CODE)

  // The products screen is the read-only mirror now — the write paths these
  // refusals belong to stay live on the surfaces that still own them (the
  // console's reconcile action keeps the unknown-write contract).
  const consoleScreen = source("features/console/console-screen.tsx")
  assert.match(consoleScreen, /result_unknown/)
  assert.match(consoleScreen, /consoleReconcileActiveWorkspace\(\)/)
})

// --- 客服 --------------------------------------------------------------------

test("客服：未确认的发送清掉草稿并禁止重发，读取失败仍是读取失败的原话", async () => {
  const send = {
    store_id: "store-1",
    chat_id: "chat-9",
    text: "Здравствуйте",
  }
  const unknown = await refusal(
    409,
    "seller_result_unknown",
    "这条消息已发出，Ozon 未确认结果",
    () => opsHttp.messageCenterSend(send),
  )
  assert.equal(commandErrorCode(unknown), SELLER_RESULT_UNKNOWN_CODE)
  assert.equal(sendError(unknown), "这条消息已发出，Ozon 未确认结果")

  const readFailure = await refusal(502, "ozon_message_center_failed", "Ozon 会话列表暂不可用", () =>
    opsHttp.messageCenterInbox({ stores: [] }),
  )
  assert.equal(commandErrorCode(readFailure), "cloud_ozon_message_center_failed")
  assert.equal(inboxError(readFailure), "Ozon 会话列表暂不可用")

  const screen = source("features/message-center/message-center-screen.tsx")
  assert.match(screen, /SELLER_RESULT_UNKNOWN_CODE/)
  assert.match(screen, /setDraftRu\(""\)\n\s*notifyError\("结果未知"/)
  assert.match(screen, /notifyError\("写入已停用"/)
})

// --- 概览 --------------------------------------------------------------------

test("概览：刷新冲突映射为 busy 码，真正的读取失败仍保留 Ozon 原话", async () => {
  const busy = await refusal(409, "console_refresh_busy", "另一次刷新仍在进行", () =>
    opsHttp.consoleRefreshMetrics(),
  )
  assert.equal(commandErrorCode(busy), CONSOLE_REFRESH_BUSY_CODE)

  const failed = await refusal(502, "ozon_console_failed", "Ozon 经营指标暂不可用", () =>
    opsHttp.consoleRefreshMetrics(),
  )
  assert.equal(commandErrorCode(failed), "cloud_ozon_console_failed")
  assert.equal(errorMessage(failed, "无法刷新当前 Workspace 的经营指标。"), "Ozon 经营指标暂不可用")
})
