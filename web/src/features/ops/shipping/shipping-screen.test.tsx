import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { ShippingListView, ShippingPostingView } from "@/bindings/commands"
import { toneFor } from "@/lib/receipt-state"

import {
  deadlineLabel,
  shippingStatusLabel,
  shouldStartShippingRead,
} from "./shipping-model"
import { ShippingPostingsTable, ShippingResults } from "./shipping-screen"

const overdue: ShippingPostingView = {
  posting_number: "33920145-0032-1",
  in_process_at: "2026-08-16T08:11:04Z",
  shipment_date: "2026-08-17T10:00:00Z",
  status: "awaiting_packaging",
  substatus: "",
  products: [
    {
      sku: 5_296_027_915,
      offer_id: "ART-40X50-0001",
      name: "Картина на холсте 40×50 Абстрактный берег с очень длинным названием которое не должно ломать вёрстку",
      quantity: 12,
    },
  ],
  quantity: 12,
  deadline_state: "deadline_overdue",
  packing_state: "unpacked",
  label_state: "label_not_ready",
}

const approaching: ShippingPostingView = {
  posting_number: "51020488-0110-2",
  in_process_at: "2026-08-17T09:02:11Z",
  shipment_date: "2026-08-17T15:30:00Z",
  status: "awaiting_deliver",
  substatus: "posting_awaiting_passport_data",
  products: [
    {
      sku: 5_188_441_002,
      offer_id: "POSTER-A3-088",
      name: "数字油画 DIY 套装 40×50 抽象海岸",
      quantity: 1,
    },
  ],
  quantity: 1,
  deadline_state: "deadline_approaching",
  packing_state: "packed",
  label_state: "label_ready",
}

test("the table shows posting_number, store, cutoff, quantity and actions", () => {
  const html = renderToStaticMarkup(
    <ShippingPostingsTable
      postings={[overdue, approaching]}
      storeName="主店 · POD"
      onOpen={() => {}}
    />,
  )
  assert.match(html, /33920145-0032-1/)
  assert.match(html, /51020488-0110-2/)
  assert.match(html, />12</)
  assert.match(html, />1</)
  assert.match(html, /主店 · POD/)
  assert.match(html, new RegExp(shippingStatusLabel("awaiting_packaging")))
  assert.match(html, new RegExp(shippingStatusLabel("awaiting_deliver")))
  assert.doesNotMatch(html, /awaiting_packaging|awaiting_deliver/)
  assert.match(html, new RegExp(deadlineLabel("deadline_overdue")))
  assert.match(html, new RegExp(deadlineLabel("deadline_approaching")))
  assert.match(html, /aria-label="打单 33920145-0032-1"/)
  assert.match(html, /aria-label="打单 51020488-0110-2"/)
  assert.match(html, /aria-label="发货 51020488-0110-2"/)
  assert.match(html, /cursor-pointer/)
  assert.doesNotMatch(html, /title="posting_awaiting_passport_data"/)
  assert.match(html, /aria-label="子状态 posting_awaiting_passport_data"/)
  assert.match(html, /select-all/)
})

const readyView: ShippingListView = {
  store_id: "11111111-1111-4111-8111-111111111111",
  postings: [approaching],
  has_next: true,
  cursor: "next-page",
}

test("a refresh failure keeps the painted page and stays out of the DOM", () => {
  const html = renderToStaticMarkup(
    <ShippingResults
      view={readyView}
      load="error"
      page={2}
      onPrevious={() => {}}
      onNext={() => {}}
      onRetry={() => {}}
    />,
  )
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /Ozon 暂不可用/)
  assert.match(html, /51020488-0110-2/)
  assert.match(html, /aria-label="第 2 页"/)
})

test("an empty later page still exposes enabled previous navigation", () => {
  const html = renderToStaticMarkup(
    <ShippingResults
      view={{ ...readyView, postings: [], has_next: false, cursor: "" }}
      load="empty"
      page={2}
      onPrevious={() => {}}
      onNext={() => {}}
      onRetry={() => {}}
    />,
  )
  const previous = html.match(/<button[^>]*aria-label="上一页"[^>]*>/)?.[0] ?? ""
  assert.ok(previous)
  assert.doesNotMatch(previous, /\sdisabled(?:=|>)/)
  assert.doesNotMatch(html, /当前队列没有待发货单/)
})

test("a failed empty later page keeps its previous navigation", () => {
  const html = renderToStaticMarkup(
    <ShippingResults
      view={{ ...readyView, postings: [], has_next: false, cursor: "" }}
      load="error"
      page={2}
      onPrevious={() => {}}
      onNext={() => {}}
      onRetry={() => {}}
    />,
  )
  const previous = html.match(/<button[^>]*aria-label="上一页"[^>]*>/)?.[0] ?? ""
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /Ozon 暂不可用/)
  assert.ok(previous)
  assert.doesNotMatch(previous, /\sdisabled(?:=|>)/)
})

test("loading keeps status semantics and an initial error keeps only retry", () => {
  const loading = renderToStaticMarkup(
    <ShippingResults
      view={{ ...readyView, postings: [] }}
      load="loading"
      page={1}
      onPrevious={() => {}}
      onNext={() => {}}
      onRetry={() => {}}
    />,
  )
  const failed = renderToStaticMarkup(
    <ShippingResults
      view={{ ...readyView, postings: [] }}
      load="error"
      page={1}
      onPrevious={() => {}}
      onNext={() => {}}
      onRetry={() => {}}
    />,
  )
  assert.match(loading, /role="status"/)
  assert.match(loading, /aria-live="polite"/)
  assert.doesNotMatch(failed, /role="alert"/)
  assert.doesNotMatch(failed, /登录已过期/)
  assert.match(failed, />重试<\/button>/)
  assert.doesNotMatch(failed, /Client ID|API Key/)
})

test("the posting quantity is authoritative", () => {
  const html = renderToStaticMarkup(
    <ShippingPostingsTable
      postings={[
        {
          ...approaching,
          quantity: 9,
          products: [{ ...approaching.products[0]!, quantity: 1 }],
        },
      ]}
    />,
  )
  assert.match(html, /共 9 件/)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("quiet reads never steal a manual page and manual reads supersede quiet", async () => {
  let generation = 0
  let inFlight: number | null = null
  let painted = ""
  async function read(pending: Promise<string>, quiet: boolean) {
    if (!shouldStartShippingRead(quiet, inFlight !== null)) return false
    const sequence = ++generation
    inFlight = sequence
    try {
      const next = await pending
      if (sequence !== generation) return false
      painted = next
      return true
    } finally {
      if (inFlight === sequence) inFlight = null
    }
  }

  const page = deferred<string>()
  const manualPage = read(page.promise, false)
  assert.equal(await read(Promise.resolve("quiet"), true), false)
  page.resolve("page-2")
  assert.equal(await manualPage, true)
  assert.equal(painted, "page-2")

  const background = deferred<string>()
  const quietPage = read(background.promise, true)
  const refresh = deferred<string>()
  const manualRefresh = read(refresh.promise, false)
  background.resolve("old")
  refresh.resolve("fresh")
  assert.equal(await quietPage, false)
  assert.equal(await manualRefresh, true)
  assert.equal(painted, "fresh")
})

test("Shipping fences stale reads and reuses visible polling", () => {
  const source = readFileSync(
    new URL("./shipping-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /sequence !== requestSequence\.current/)
  assert.match(source, /shouldStartShippingRead\(/)
  assert.match(source, /cancelled = true[\s\S]*requestSequence\.current \+= 1/)
  assert.match(source, /useVisiblePolling\(\{/)
  assert.match(source, /quiet: trigger !== "mount"/)
  assert.doesNotMatch(source, /catch \(reason\)[\s\S]{0,300}setView\(emptyView/)
  assert.match(source, /SHIPPING_READ_LIVE = "shipping-read"/)
  assert.match(source, /notifyLive\(\{/)
  assert.doesNotMatch(source, /role="alert"/)
})

test("deadline and packing chips resolve through the six-tone table", () => {
  assert.equal(toneFor("deadline_overdue"), "bad")
  assert.equal(toneFor("deadline_approaching"), "attest")
  assert.equal(toneFor("deadline_ok"), "idle")
  assert.equal(toneFor("awaiting_packaging"), "flight")
  assert.equal(toneFor("unpacked"), "idle")
  assert.equal(toneFor("packed"), "good")
  assert.equal(toneFor("label_ready"), "flight")
  assert.equal(toneFor("label_unknown"), "unknown")
})

test("ShippingScreen mounts and keeps the primary 打单 in the tab order", () => {
  const source = readFileSync(
    new URL("./shipping-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /export function ShippingScreen/)
  assert.match(source, /aria-label={`\$\{action\.label\} \$\{posting\.posting_number\}`}/)
  assert.doesNotMatch(source, /tabIndex=\{-1\}/)
  assert.match(source, /from "@\/components\/ui\/dialog"/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/sheet"/)
  assert.match(source, /from "@\/components\/ui\/tabs"/)
  assert.doesNotMatch(source, /space-y-/)
})

test("a long posting_number stays selectable and does not invent a seventh tone", () => {
  const html = renderToStaticMarkup(
    <ShippingPostingsTable postings={[overdue]} />,
  )
  assert.match(html, /data-tone="bad"/)
  assert.doesNotMatch(html, /urgent|emergency|overdue-red/)
})

// ---------------------------------------------------------------------------
// 发货屏行内「已委托」只读徽标（posting-states coveredOfferIds → N/M）
// ---------------------------------------------------------------------------

test("delegate badges paint read-only chips: 已委托 / 已委托 N/M 行, never a button", () => {
  const html = renderToStaticMarkup(
    <ShippingPostingsTable
      postings={[overdue, approaching]}
      delegateBadges={{
        "33920145-0032-1": { kind: "delegated", label: "已委托" },
        "51020488-0110-2": { kind: "partial", label: "已委托 1/2 行" },
      }}
    />,
  )
  assert.match(html, />已委托</)
  assert.match(html, />已委托 1\/2 行</)
  // 纯只读：发货屏不出现任何委托动作按钮。
  assert.doesNotMatch(html, /aria-label="委托 /)
  assert.doesNotMatch(html, /aria-label="委托剩余行 /)
  assert.doesNotMatch(html, /role="alert"/)
})

test("rows without a delegate badge stay bare", () => {
  const html = renderToStaticMarkup(
    <ShippingPostingsTable postings={[overdue]} delegateBadges={{}} />,
  )
  assert.doesNotMatch(html, /已委托/)
})
