// Dev-only console-mirror check page: the real ConsoleScreen mounts against a
// mocked `/api/ops/console/snapshot`. `role=owner|member`, `state=never`.
import { createRoot } from "react-dom/client"

import type { ConsoleSnapshot, OzonStoreView } from "@/bindings/commands"
import { ConsoleScreen } from "@/features/console/console-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const params = new URLSearchParams(location.search)
const role = params.get("role") ?? "owner"
const state = params.get("state") ?? "mixed"

const NOW = Date.now()
const H = 3_600_000
const D = 24 * H

const permissions = {
  manage_store: role !== "member",
  edit_name: true,
  manage_key_grants: role === "owner",
  test_key: true,
  manage_tags: role !== "member",
  manage_key: true,
  delete_store: role !== "member",
}

function storeView(
  uuid: string,
  label: string,
  over: Partial<OzonStoreView> = {},
): OzonStoreView {
  return {
    id: uuid,
    label,
    client_id: `client-${label}`,
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "present",
    ref_id: uuid,
    updated_at_ms: NOW - D,
    verified_at_ms: NOW - D,
    last_used_at_ms: NOW - H,
    active: false,
    cloud_store_uuid: uuid,
    create_order: null,
    cloud_status: "active",
    manual_disabled: false,
    quota_suspended: false,
    cloud_revision: 1,
    credential_revision: 1,
    needs_reentry: false,
    can_manage: permissions.manage_store,
    can_edit_credential: permissions.manage_key,
    assignee_key_manage: false,
    permissions,
    ...over,
  }
}

function mirrorRow(
  uuid: string,
  over: Partial<ConsoleSnapshot["products"][number]> = {},
): ConsoleSnapshot["products"][number] {
  return {
    store_id: uuid,
    pass: "none",
    ...over,
  }
}

const OWNER_STORES: OzonStoreView[] = [
  storeView("11111111-aaaa-4000-8000-000000000001", "杯具旗舰店", {
    assignee_name: "张三",
    product_quota: {
      fetched_at_ms: NOW - H,
      total: { usage: 920, limit: 1000 },
    },
  }),
  storeView("22222222-bbbb-4000-8000-000000000002", "居家生活馆", { assignee_name: "李四" }),
  storeView("33333333-cccc-4000-8000-000000000003", "新店（待同步）", { assignee_name: "张三" }),
  storeView("44444444-dddd-4000-8000-000000000004", "旧店（密钥过期）"),
]

const OWNER_PRODUCTS = [
  mirrorRow(OWNER_STORES[0].id, {
    count_total: 42,
    count_on_sale: 31,
    count_hidden: 6,
    count_moderation_failed: 1,
    count_zero_stock: 4,
    count_archived: 2,
    last_full_sync_at_ms: NOW - 26 * H,
    priced_at_ms_max: NOW - 2 * H,
  }),
  mirrorRow(OWNER_STORES[1].id, {
    count_total: 17,
    count_on_sale: 12,
    count_hidden: 3,
    count_moderation_failed: 0,
    count_zero_stock: 2,
    count_archived: 0,
    last_full_sync_at_ms: NOW - 4 * D,
    priced_at_ms_max: NOW - 4 * D,
  }),
  mirrorRow(OWNER_STORES[2].id, {}),
  mirrorRow(OWNER_STORES[3].id, {
    count_total: 9,
    count_on_sale: 7,
    count_hidden: 1,
    count_moderation_failed: 0,
    count_zero_stock: 1,
    count_archived: 1,
    last_full_sync_at_ms: NOW - 9 * D,
    pass: "none",
    hold: "cooldown",
    hold_reason: "rate_limited",
    hold_until_ms: NOW + 12 * H,
  }),
]

const MEMBER_STORES = [OWNER_STORES[1]]
const MEMBER_PRODUCTS = [OWNER_PRODUCTS[1]]

const NEVER_STORES = [
  storeView("55555555-eeee-4000-8000-000000000005", "新登记店", { assignee_name: "张三" }),
]
const NEVER_PRODUCTS = [mirrorRow(NEVER_STORES[0].id, {})]

const THROUGH_DAY = new Date(NOW).toISOString().slice(0, 10)

function metric(
  uuid: string,
  units: number[],
): ConsoleSnapshot["metrics"][number] {
  return {
    store_id: uuid,
    ordered_units_30d: units.reduce((sum, value) => sum + value, 0) * 2,
    previous_ordered_units_30d: units.reduce((sum, value) => sum + value, 0),
    day_series_14d: units,
    through_day: THROUGH_DAY,
    last_sync_at_ms: NOW - H,
  }
}

const OWNER_METRICS = [
  metric(OWNER_STORES[0].id, [4, 6, 5, 7, 3, 8, 6, 9, 7, 5, 8, 6, 10, 9]),
  metric(OWNER_STORES[1].id, [1, 0, 2, 1, 0, 1, 2, 2, 1, 0, 3, 1, 2, 1]),
]
const MEMBER_METRICS = [OWNER_METRICS[1]]

const OWNER_LEDGER: ConsoleSnapshot["ledger"] = [
  { kind: "listing", status: "succeeded", created_at_ms: NOW - 2 * D, updated_at_ms: NOW - 2 * D + H },
  { kind: "listing", status: "succeeded", created_at_ms: NOW - D, updated_at_ms: NOW - D + 2 * H },
  { kind: "listing", status: "dispatching", created_at_ms: NOW - H, updated_at_ms: NOW - H },
  { kind: "write", status: "succeeded", created_at_ms: NOW - 3 * H, updated_at_ms: NOW - 2 * H },
  { kind: "listing", status: "result_unknown", created_at_ms: NOW - 5 * H, updated_at_ms: NOW - 4 * H },
]

const rosterStoreCount = state === "never" ? 1 : role === "member" ? 1 : 4

const roster = (stores: OzonStoreView[]) => ({
  stores,
  active_id: null,
  tags: [],
  store_limit: 10,
  stores_used: state === "never" ? 1 : OWNER_STORES.length,
  suspended: 0,
})

const snapshot: ConsoleSnapshot = {
  roster:
    state === "never" ? roster(NEVER_STORES) : role === "member" ? roster(MEMBER_STORES) : roster(OWNER_STORES),
  ledger: state === "never" || role === "member" ? [] : OWNER_LEDGER,
  metrics:
    state === "never" ? [] : role === "member" ? MEMBER_METRICS : OWNER_METRICS,
  products:
    state === "never" ? NEVER_PRODUCTS : role === "member" ? MEMBER_PRODUCTS : OWNER_PRODUCTS,
} as ConsoleSnapshot

const hits: string[] = []
window.fetch = async (input) => {
  const url = String(input)
  hits.push(url)
  if (url === "/api/ops/console/snapshot") {
    return new Response(JSON.stringify({ data: snapshot }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return new Response(JSON.stringify({ error: { code: "unexpected", message: url } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })
}

createRoot(fixture).render(<ConsoleScreen workspaceId={1} onNavigate={() => {}} />)

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  await frame()
  await frame()
  await frame()
}

async function main() {
  for (let i = 0; i < 100; i++) {
    await settle()
    if (fixture.textContent?.includes("商品生命周期分布")) break
  }
  await settle()
  const text = fixture.textContent ?? ""
  const lines: string[] = []
  const check = (ok: boolean, name: string) => lines.push(`${ok ? "PASS" : "FAIL"} ${name}`)

  check(text.includes("30 日出单"), "card 30 日出单")
  check(text.includes("在售商品"), "card 在售商品")
  check(text.includes("7 日上架与收效"), "card 7 日上架与收效")
  check(text.includes("额度占用"), "card 额度占用")
  check(text.includes("商品生命周期分布"), "lifecycle panel")
  check(text.includes("店铺出单排行"), "ranking panel")
  check(text.includes("出单趋势"), "trend panel")
  check(text.includes("覆盖"), "coverage footnote")
  check(/同步于 .*前/.test(text) || text.includes("尚未同步"), "footnote sync age")
  if (role === "member") {
    check(!text.includes("杯具旗舰店"), "member never sees unassigned stores")
    check(text.includes("居家生活馆"), "member sees the assigned store")
    check(text.includes("我的 1 家店"), "member scope label")
  } else if (state === "never") {
    check(text.includes("尚未同步"), "never store state")
  } else {
    check(text.includes(`全部 ${rosterStoreCount} 家店`), "owner scope label")
    check(text.includes("杯具旗舰店"), "ranking lists the top store")
    check(text.includes("待介入"), "attention banner on unknown/failed writes")
  }
  check(hits.every((u) => u.startsWith("/api/ops/console/")), `no Seller reads: ${hits.join(",")}`)

  document.querySelector<HTMLPreElement>("#results")!.textContent =
    `${lines.join("\n")}\n\nfetch calls:\n${hits.join("\n")}`
}

void main()
