import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  OpsCancellationRowView,
  OpsReturnRowView,
  OpsReturnsListView,
  OzonStoreView,
} from "@/bindings/commands"
import {
  asOpsListError,
  cancellationFilterLabel,
  cancellationStatusLabel,
  displayReason,
  formatOccurredAt,
  isAuthError,
  initiatorLabel,
  loadOpsListPage,
  statusLabel,
  type OpsListState,
} from "./returns-model"
import { ReturnsScreenView, type ReturnsScreenViewProps } from "./returns-screen"

const store: OzonStoreView = {
  id: "store_01",
  label: "主店 · POD Wall Art",
  client_id: "248917",
  watermark_name: "",
  advertising_client_id: "",
  advertising_configured: false,
  configured: true,
  secret_status: "present",
  ref_id: "ozon_store_v1:store_01",
  updated_at_ms: 1,
  verified_at_ms: 1,
  last_used_at_ms: 1,
  active: true,
  cloud_store_uuid: null,
  create_order: null,
  cloud_status: null,
  manual_disabled: null,
  quota_suspended: null,
  cloud_revision: null,
  credential_revision: null,
  needs_reentry: false,
  can_manage: true,
  can_edit_credential: true,
  permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
}

const returnRow: OpsReturnRowView = {
  id: "88120011",
  posting_number: "33920145-0018-1",
  reason: "Товар не подошел / не понравился",
  status: "ArrivedAtReturnPlace",
  status_label: "At the pick-up point",
  schema: "Fbs",
  occurred_at: "2026-08-14T16:02:11Z",
  product_name:
    "Постер на холсте 40×60 — абстракция «Тихий залив», очень длинное название для проверки переноса строки",
  offer_id: "WALL-ART-4060-NAVY",
  sku: "1784451901",
}

const cancellationRow: OpsCancellationRowView = {
  cancellation_id: "91003",
  posting_number: "33920145-0021-1",
  reason: "Покупатель передумал · Нужен другой размер рамки 50×70",
  status: "ON_APPROVAL",
  status_label: "Ожидает решения продавца",
  initiator: "CLIENT",
  occurred_at: "2026-08-15T07:22:00Z",
}

function view(overrides: Partial<ReturnsScreenViewProps> = {}) {
  const props: ReturnsScreenViewProps = {
    storesLoading: false,
    storesError: "",
    stores: [store],
    hasUnavailableStores: false,
    storeId: store.id,
    onStoreChange: () => {},
    onRetryStores: () => {},
    returnPosting: "",
    returnSchema: "",
    returnStatus: "",
    onReturnPostingChange: () => {},
    onReturnSchemaChange: () => {},
    onReturnStatusChange: () => {},
    onApplyReturnFilters: () => {},
    onRefreshReturns: () => {},
    onLoadMoreReturns: () => {},
    returns: {
      loading: false,
      loadingMore: false,
      error: null,
      view: { items: [returnRow], has_next: true, last_id: "88120011" },
    },
    cancelPosting: "",
    cancelState: "ON_APPROVAL",
    cancelInitiator: "",
    onCancelPostingChange: () => {},
    onCancelStateChange: () => {},
    onCancelInitiatorChange: () => {},
    onApplyCancelFilters: () => {},
    onRefreshCancellations: () => {},
    onLoadMoreCancellations: () => {},
    cancellations: {
      loading: false,
      loadingMore: false,
      error: null,
      view: {
        items: [cancellationRow],
        last_id: "91003",
        counter: 3,
        has_next: false,
      },
    },
    ...overrides,
  }
  return renderToStaticMarkup(<ReturnsScreenView {...props} />)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("ReturnsScreen mounts and 同意 stays in the tab order", () => {
  const source = readFileSync(
    new URL("./returns-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /export function ReturnsScreen/)
  assert.match(source, /aria-label=\{`同意 \$\{row\.posting_number/)
  assert.doesNotMatch(source, /tabIndex=\{-1\}/)
  assert.match(source, /from "@\/components\/ui\/table"/)
  assert.match(source, /from "@\/components\/ui\/dialog"/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/sheet"/)
  assert.doesNotMatch(source, /space-y-/)
  assert.match(source, /RETURNS_READ_LIVE = "returns-read"/)
  assert.match(source, /notifyLive\(\{/)
  assert.doesNotMatch(source, /role="alert"/)
})

test("the AppShell owns the page title and the two lists stay apart", () => {
  const html = view()
  assert.doesNotMatch(html, /退货单与取消申请的处理进度/)
  assert.doesNotMatch(html, /<h1/)
  assert.match(html, />退货单</)
  assert.match(html, />取消申请</)
  assert.match(html, /33920145-0018-1/)
  assert.match(html, /33920145-0021-1/)
  assert.match(html, /Товар не подошел/)
  assert.match(html, /Покупатель передумал/)
  assert.match(html, /At the pick-up point/)
  assert.match(html, /Ожидает решения продавца/)
  assert.match(html, /aria-label="刷新退货单"/)
  assert.match(html, /aria-label="刷新取消申请"/)
  assert.match(html, /aria-label="同意 33920145-0021-1"/)
  assert.match(html, /aria-label="拒绝 33920145-0021-1"/)
})

test("identifiers use the measured mono face and stay selectable", () => {
  const html = view()
  assert.match(html, /select-all[^>]*>33920145-0018-1/)
  assert.match(html, /font-mono[^>]*>33920145-0021-1/)
  assert.match(html, /tabular-nums/)
})

test("long russian copy is clamped instead of stretching the row", () => {
  const html = view()
  assert.match(html, /line-clamp-3 max-w-\[46ch\]/)
  assert.doesNotMatch(html, /title="Товар не подошел/)
})

test("status chips resolve through the shared tone table", () => {
  const html = view()
  assert.match(html, /data-tone="flight"/)
  assert.match(html, /At the pick-up point/)
  assert.match(html, />待处理</)
  assert.match(html, /3/)
  assert.match(html, />买家</)
  assert.doesNotMatch(html, />ON_APPROVAL</)
  assert.doesNotMatch(html, />CLIENT</)

  const fallback = view({
    cancellations: {
      loading: false,
      loadingMore: false,
      error: null,
      view: {
        items: [{ ...cancellationRow, status_label: "" }],
        last_id: cancellationRow.cancellation_id,
        counter: 0,
        has_next: false,
      },
    },
  })
  assert.match(fallback, />待审批</)
})

test("a true empty page does not pretend the list was never asked", () => {
  const html = view({
    returns: {
      loading: false,
      loadingMore: false,
      error: null,
      view: { items: [], has_next: false, last_id: "" },
    },
    cancellations: {
      loading: false,
      loadingMore: false,
      error: null,
      view: { items: [], last_id: "", counter: 0, has_next: false },
    },
  })
  assert.match(html, /没有退货单/)
  assert.match(html, /没有取消申请/)
})

test("a roster failure is not presented as an unconfigured Workspace", () => {
  const html = view({
    stores: [],
    storeId: "",
    storesError: "Cloud session expired",
  })
  // The failure rides the live toast; the gate paints only the retry.
  assert.doesNotMatch(html, /无法读取店铺配置/)
  assert.doesNotMatch(html, /Cloud session expired/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /还没有已接入的店铺/)
})

test("a next-page failure keeps both painted lists and retries at the tail", () => {
  const error = {
    code: "cloud_ozon_rate_limited",
    message: "RATE_LIMIT_EXCEEDED",
    retry: "append" as const,
  }
  const html = view({
    returns: {
      loading: false,
      loadingMore: false,
      error,
      view: { items: [returnRow], has_next: true, last_id: "88120011" },
    },
    cancellations: {
      loading: false,
      loadingMore: false,
      error,
      view: {
        items: [cancellationRow],
        last_id: "91003",
        counter: 3,
        has_next: true,
      },
    },
  })
  assert.match(html, /33920145-0018-1/)
  assert.match(html, /33920145-0021-1/)
  assert.equal((html.match(/重试下一页/g) ?? []).length, 2)
  assert.doesNotMatch(html, /RATE_LIMIT_EXCEEDED/)
})

test("a refresh failure keeps the painted list and retries the same query", () => {
  const html = view({
    returns: {
      loading: false,
      loadingMore: false,
      error: {
        code: "cloud_ozon_ops_returns_failed",
        message: "Cloud temporarily unavailable",
        retry: "replace",
      },
      view: {
        items: [returnRow],
        has_next: false,
        last_id: "88120011",
      },
    },
  })
  assert.match(html, /33920145-0018-1/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /Cloud temporarily unavailable/)
  assert.match(html, />重试</)
  assert.doesNotMatch(html, /重试下一页/)
})

test("the list controller preserves committed rows and fences stale waves", async () => {
  let generation = 1
  let state: OpsListState<OpsReturnsListView> = {
    loading: false,
    loadingMore: false,
    error: null,
    view: { items: [returnRow], has_next: true, last_id: "88120011" },
  }
  const setState = (
    update: (previous: OpsListState<OpsReturnsListView>) => OpsListState<OpsReturnsListView>,
  ) => {
    state = update(state)
  }

  const pending = deferred<OpsReturnsListView>()
  const stale = loadOpsListPage({
    append: false,
    request: () => pending.promise,
    isCurrent: () => generation === 1,
    setState,
    fallback: "无法读取退货单。",
  })
  assert.equal(state.loading, true)
  assert.equal(state.view.items[0]?.posting_number, returnRow.posting_number)
  generation = 2
  state = {
    ...state,
    loading: true,
    view: {
      items: [{ ...returnRow, id: "new-store", posting_number: "new-store" }],
      has_next: false,
      last_id: "new-store",
    },
  }
  pending.resolve({ items: [], has_next: false, last_id: "" })
  await stale
  assert.equal(state.view.items[0]?.posting_number, "new-store")

  state = {
    loading: false,
    loadingMore: false,
    error: null,
    view: { items: [returnRow], has_next: true, last_id: "88120011" },
  }
  await loadOpsListPage({
    append: true,
    request: async () => ({
      items: [{ ...returnRow, id: "9007199254740993", posting_number: "page-2" }],
      has_next: false,
      last_id: "9007199254740993",
    }),
    isCurrent: () => generation === 2,
    setState,
    fallback: "无法读取退货单。",
  })
  assert.deepEqual(
    state.view.items.map((item) => item.posting_number),
    [returnRow.posting_number, "page-2"],
  )
  assert.equal(state.view.last_id, "9007199254740993")

  const reason = { code: "cloud_ozon_rate_limited", message: "RATE_LIMIT_EXCEEDED", serverCode: "OZON_RATE_LIMITED", traceId: "returns-trace" }
  await loadOpsListPage({
    append: true,
    request: async () => {
      throw reason
    },
    isCurrent: () => generation === 2,
    setState,
    fallback: "无法读取退货单。",
  })
  assert.equal(state.view.items.length, 2)
  assert.equal(state.view.last_id, "9007199254740993")
  assert.equal(state.error?.retry, "append")
  assert.equal(state.error?.reason, reason)

  await loadOpsListPage({
    append: false,
    request: async () => {
      throw { code: "unauthenticated", message: "登录已过期" }
    },
    isCurrent: () => generation === 2,
    setState,
    fallback: "无法读取退货单。",
  })
  assert.equal(state.view.items.length, 2)
  assert.equal(state.error?.retry, "replace")
})

test("loading names the list that is still in flight", () => {
  const html = view({
    returns: {
      loading: true,
      loadingMore: false,
      error: null,
      view: { items: [], has_next: false, last_id: "" },
    },
    cancellations: {
      loading: true,
      loadingMore: false,
      error: null,
      view: { items: [], last_id: "", counter: 0, has_next: false },
    },
  })
  assert.match(html, /正在读取退货单/)
  assert.match(html, /正在读取取消申请/)
  assert.equal((html.match(/role="status"/g) ?? []).length, 2)
})

test("an Ozon failure keeps the API reason off the page", () => {
  const html = view({
    returns: {
      loading: false,
      loadingMore: false,
      error: {
        code: "cloud_ozon_ops_returns_failed",
        message: "ONLY_ONE_DATE_FILTER_ALLOWED",
      },
      view: { items: [], has_next: false, last_id: "" },
    },
  })
  assert.doesNotMatch(html, /ONLY_ONE_DATE_FILTER_ALLOWED/)
  assert.doesNotMatch(html, /读取失败，请稍后重试/)
  assert.match(html, />重试</)
})

test("a missing-permission failure paints the permission icon, not the copy", () => {
  const html = view({
    cancellations: {
      loading: false,
      loadingMore: false,
      error: {
        code: "cloud_ozon_auth_failed",
        message: "PERMISSION_DENIED",
        remediation: "到「店铺」重新检查 Client ID / API Key 后再同步。",
      },
      view: { items: [], last_id: "", counter: 0, has_next: false },
    },
  })
  assert.doesNotMatch(html, /当前店铺没有权限读取/)
  assert.doesNotMatch(html, /PERMISSION_DENIED/)
  assert.doesNotMatch(html, /到「店铺」重新检查 Client ID/)
  assert.match(html, /text-st-attest-ink/)
  assert.match(html, />重试</)
})

test("an unconfigured roster points at 店铺 instead of an empty table", () => {
  const html = view({ stores: [], storeId: "" })
  assert.match(html, /还没有已接入的店铺/)
  assert.doesNotMatch(html, /没有退货单/)
})

test("disabled Cloud stores are unavailable rather than unconfigured", () => {
  const html = view({
    stores: [],
    storeId: "",
    hasUnavailableStores: true,
  })
  assert.match(html, /已接入的店铺当前不可用/)
  assert.match(html, /超出当前名额/)
  assert.doesNotMatch(html, /还没有已接入的店铺/)
})

test("stores still loading do not claim an empty roster", () => {
  const html = view({ storesLoading: true, stores: [], storeId: "" })
  assert.match(html, /正在读取店铺配置/)
  assert.doesNotMatch(html, /还没有已接入的店铺/)
})

test("pagination to the last page is offered only while Ozon says there is more", () => {
  const withMore = view()
  assert.match(withMore, /加载下一页/)
  const lastPage = view({
    returns: {
      loading: false,
      loadingMore: false,
      error: null,
      view: { items: [returnRow], has_next: false, last_id: "88120011" },
    },
  })
  assert.doesNotMatch(lastPage, /加载下一页/)
})

test("model helpers keep Ozon text and do not invent a category", () => {
  assert.equal(displayReason(""), "—")
  assert.equal(displayReason("Брак"), "Брак")
  assert.equal(
    statusLabel({ status: "ArrivedAtReturnPlace", status_label: "" }),
    "ArrivedAtReturnPlace",
  )
  assert.equal(
    cancellationStatusLabel({
      status: "ON_APPROVAL",
      status_label: "Ожидает решения продавца",
    }),
    "Ожидает решения продавца",
  )
  assert.equal(
    cancellationStatusLabel({ status: "ON_APPROVAL", status_label: "" }),
    "待审批",
  )
  assert.equal(formatOccurredAt(""), "—")
  assert.equal(formatOccurredAt("not-a-date"), "not-a-date")
  assert.match(formatOccurredAt("2026-08-14T16:02:11Z"), /2026/)
  assert.equal(
    asOpsListError(
      { code: "cloud_ozon_ops_returns_failed", message: "ONLY_ONE_DATE_FILTER_ALLOWED" },
      "fallback",
    ).message,
    "ONLY_ONE_DATE_FILTER_ALLOWED",
  )
  assert.equal(isAuthError({ code: "cloud_ozon_auth_failed", message: "x" }), true)
  assert.equal(isAuthError({ code: "unauthenticated", message: "x" }), true)
  assert.equal(isAuthError({ code: "cloud_forbidden", message: "x" }), true)
  assert.equal(isAuthError({ code: "cloud_ozon_ops_returns_failed", message: "x" }), false)
  assert.equal(cancellationFilterLabel("APPROVED"), "已批准")
  assert.equal(initiatorLabel("CLIENT"), "买家")
})
