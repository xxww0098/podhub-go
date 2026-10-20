import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { Table } from "@/components/ui/table"

import type { DelegateBinding, DelegatePosting } from "./delegate-http"
import { DelegatePostingsTable } from "./delegate-postings-view"
import { DelegateBindingsTable } from "./delegate-bindings-view"

const product = (offerId: string, quantity = 1) => ({
  name: `数字油画 ${offerId}`,
  offer_id: offerId,
  quantity,
  sku: 5_188_441_002,
})

const posting = (
  overrides: Partial<DelegatePosting> & { posting_number: string },
): DelegatePosting => ({
  covered_lines: 0,
  delegate_state: "ready",
  in_process_at: "2026-08-16T08:11:04Z",
  order_id: null,
  order_state: null,
  products: [product("ART-40X50-0001", 2)],
  quantity: 2,
  shipment_date: "2026-08-17T10:00:00Z",
  status: "awaiting_packaging",
  substatus: "",
  total_lines: 1,
  ...overrides,
})

test("四态行内呈现：delegated 徽标+单级状态、partial N/M、ready/partial 的按钮", () => {
  const html = renderToStaticMarkup(
    <DelegatePostingsTable
      postings={[
        posting({
          posting_number: "DEL-1",
          delegate_state: "delegated",
          order_id: "order-1",
          order_state: "in_production",
        }),
        posting({
          posting_number: "DEL-2",
          delegate_state: "partial",
          covered_lines: 1,
          total_lines: 2,
          order_id: "order-2",
          order_state: "ready",
          products: [product("ART-1"), product("ART-2")],
        }),
        posting({ posting_number: "DEL-3", delegate_state: "ready" }),
        posting({ posting_number: "DEL-4", delegate_state: "needs_setup" }),
      ]}
      onOpenOrder={() => {}}
      onDelegate={() => {}}
      onDelegateRest={() => {}}
      onSetup={() => {}}
    />,
  )

  // delegated：徽标 + 单级状态；无行内按钮，整行可点进详情（点行进详情）。
  assert.match(html, />已委托</)
  assert.match(html, />生产中</)
  const delegatedRow = html.slice(html.indexOf("DEL-1"), html.indexOf("DEL-2"))
  assert.match(delegatedRow, /cursor-pointer/)
  assert.doesNotMatch(html, /aria-label="查看委托单 DEL-1"/)
  assert.doesNotMatch(html, /aria-label="委托 DEL-1"/)

  // partial：N/M 行 + 「委托剩余行」仍可用（对抗验收 14）。
  assert.match(html, />已委托 1\/2 行</)
  assert.match(html, /aria-label="委托剩余行 DEL-2"/)

  // ready：确认即建单（对抗验收 13 的另一半：已全覆盖的行不显「委托」按钮）。
  assert.match(html, /aria-label="委托 DEL-3"/)

  // needs_setup：补齐流（选厂家/传图后建单，对抗验收 2）。
  assert.match(html, /aria-label="补齐并委托 DEL-4"/)
})

test("delegated 全覆盖行没有「委托」按钮——重复建单被入口挡住", () => {
  const html = renderToStaticMarkup(
    <DelegatePostingsTable
      postings={[
        posting({
          posting_number: "DEL-FULL",
          delegate_state: "delegated",
          order_id: "order-1",
          order_state: "shipped",
        }),
      ]}
      onOpenOrder={() => {}}
      onDelegate={() => {}}
      onDelegateRest={() => {}}
      onSetup={() => {}}
    />,
  )
  assert.doesNotMatch(html, /aria-label="委托 DEL-FULL"/)
  assert.doesNotMatch(html, /aria-label="委托剩余行 DEL-FULL"/)
  assert.match(html, />已发货</)
})

test("委托屏失败文案不进 DOM：无 role=alert、无内联错误块", () => {
  const html = renderToStaticMarkup(
    <DelegatePostingsTable
      postings={[posting({ posting_number: "DEL-5", delegate_state: "ready" })]}
      onOpenOrder={() => {}}
      onDelegate={() => {}}
      onDelegateRest={() => {}}
      onSetup={() => {}}
    />,
  )
  assert.doesNotMatch(html, /role="alert"/)
})

// ---------------------------------------------------------------------------
// 绑定管理视图（表格部分）
// ---------------------------------------------------------------------------

const binding = (overrides: Partial<DelegateBinding>): DelegateBinding => ({
  active: true,
  assets: [
    {
      asset_id: "asset-1",
      binding_id: "binding-1",
      bytes: 1024,
      created_at_ms: 1_755_000_000_000,
      file_name: "原图.png",
      mime: "image/png",
      position: 0,
      sha256: "ab".repeat(32),
      verified: true,
      verified_at_ms: 1_755_000_001_000,
    },
  ],
  binding_id: "binding-1",
  created_at_ms: 1_755_000_000_000,
  note: "老客户优先发",
  offer_id: "ART-40X50-0001",
  revision: 3,
  source: { source_id: "src-1", name: "景德镇一厂", country: "中国", icon: "🏭" },
  store_id: "store-1",
  updated_at_ms: 1_755_000_000_000,
  warning: null,
  ...overrides,
})

test("绑定行：厂家名走 name 键、私注截断展示、素材数已核验/总数、启停与删除入口", () => {
  const html = renderToStaticMarkup(
    <Table>
      <DelegateBindingsTable
        bindings={[
          binding({}),
          binding({
            binding_id: "binding-2",
            offer_id: "ART-2",
            active: false,
            note: "",
            warning: "该厂家暂无可用账号，派发包会先排队等待",
            assets: [],
          }),
        ]}
        loading={false}
        onEdit={() => {}}
        onAssets={() => {}}
        onToggle={() => {}}
        onDelete={() => {}}
      />
    </Table>,
  )
  assert.match(html, /景德镇一厂/)
  assert.match(html, /老客户优先发/)
  assert.match(html, />启用</)
  assert.match(html, />停用</)
  assert.match(html, />1\/1</)
  assert.match(html, />0\/0</)
  assert.match(html, /该厂家暂无可用账号，派发包会先排队等待/)
  assert.match(html, /aria-label="改绑 ART-40X50-0001"/)
  assert.match(html, /aria-label="删除 ART-2"/)
  assert.match(html, /aria-label="素材 ART-2"/)
})
