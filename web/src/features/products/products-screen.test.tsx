import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { TableExpandedRow } from "@/components/ui/table"

import { ProductExpand, verdictCopy } from "./product-expand"
import { ProductRow } from "./product-row"
import { ACTION_LABEL, SelectionActions } from "./products-actions"
import { manualSyncNotice } from "./products-screen"
import { CoverageNote, FunnelNote, StatusTabs } from "./products-status"
import { nextScheduleUnlockAt, scheduleBlockedReason, StoreSyncActions } from "./store-sync-actions"
import type {
  StoreProductMetrics,
  StoreProductOverviewRow,
  StoreProductRow,
  StoreProductsOverviewData,
} from "./products-api"

const NOW = Date.now()

function storeRow(over: Partial<StoreProductOverviewRow> = {}): StoreProductOverviewRow {
  return {
    store_id: "11111111-2222-3333-4444-555555555555",
    name: "测试店",
    status: "active",
    freshness: "fresh",
    count_total: 12,
    count_on_sale: 10,
    count_hidden: 1,
    count_moderation_failed: 0,
    count_zero_stock: 1,
    count_archived: 0,
    last_full_sync_at_ms: NOW - 60_000,
    ...over,
  }
}

function actions(
  store: StoreProductOverviewRow,
  over: Partial<{ syncDisabled: boolean; scheduling: boolean }> = {},
) {
  return renderToStaticMarkup(
    <StoreSyncActions
      store={store}
      syncDisabled={over.syncDisabled ?? false}
      scheduling={over.scheduling ?? false}
      onSchedule={() => {}}
    />,
  )
}

test("a never-synced store shows no status tag and never a fabricated zero", () => {
  const markup = actions(
    storeRow({
      freshness: "never",
      count_total: null,
      count_on_sale: null,
      count_zero_stock: null,
      last_full_sync_at_ms: null,
    }),
  )
  // 从未同步不占工具栏位置——表格空状态负责说明。
  assert.doesNotMatch(markup, /暂无数据|更新于/)
  assert.match(markup, /立即更新/)
  assert.doesNotMatch(markup, />0</)

  const tabs = renderToStaticMarkup(
    <StatusTabs
      counts={{
        total: null, onSale: null, processing: null, hidden: null,
        moderationFailed: null, zeroStock: null, archived: null, delisted: null,
      }}
      freshness="never"
      status={undefined}
      onStatus={() => {}}
    />,
  )
  assert.match(tabs, /—/)
  assert.doesNotMatch(tabs, />0</)
})

test("status tabs render the Ozon-style buckets plus the coverage line", () => {
  const overview: StoreProductsOverviewData = {
    totals: {
      total: 40,
      on_sale: 30,
      processing: 6,
      hidden: 2,
      moderation_failed: 2,
      zero_stock: 3,
      archived: 1,
      delisted: 4,
    },
    coverage: { read: 2, total: 3 },
    newest_sync_at_ms: NOW - 60_000,
    sync_disabled: false,
    stores: [],
  }
  const markup = renderToStaticMarkup(
    <StatusTabs
      counts={{
        total: overview.totals.total,
        onSale: overview.totals.on_sale,
        processing: overview.totals.processing,
        hidden: overview.totals.hidden,
        moderationFailed: overview.totals.moderation_failed,
        zeroStock: overview.totals.zero_stock,
        archived: overview.totals.archived,
        delisted: overview.totals.delisted,
      }}
      freshness="totals"
      status={undefined}
      onStatus={() => {}}
    />,
  )
  assert.match(markup, />40</)
  assert.match(markup, />30</)
  assert.match(markup, />6</)
  assert.match(markup, />2</)
  assert.match(markup, />4</)
  assert.match(markup, />1</)
  // 页签文案对齐 Ozon 后台词汇。
  for (const label of ["全部商品", "在售", "处理中", "审核失败", "隐藏", "已下架", "已归档"]) {
    assert.match(markup, new RegExp(`>${label}<`))
  }
  const note = renderToStaticMarkup(<CoverageNote overview={overview} />)
  assert.match(note, /已统计 2\/3 家店铺/)
  // No store rows to name, but the gap between read and total still explains itself.
  assert.match(note, /未计入的店铺不在合计里/)
})

test("an expired store keeps its place but its numbers stay out of the totals copy", () => {
  const markup = actions(
    storeRow({
      freshness: "expired",
      count_total: 9,
      count_on_sale: 7,
      count_zero_stock: 4,
    }),
  )
  assert.match(markup, /数据已失效，数字未知/)
  // Expired numbers read 未知 — the stale figure must not pose as current.
  assert.doesNotMatch(markup, />9</)
  assert.match(actions(storeRow()), /更新于 /)

  const tabs = renderToStaticMarkup(
    <StatusTabs
      counts={{
        total: 8, onSale: 7, processing: 0, hidden: 1,
        moderationFailed: 0, zeroStock: 4, archived: 1, delisted: 0,
      }}
      freshness="expired"
      status={undefined}
      onStatus={() => {}}
    />,
  )
  assert.match(tabs, /未知/)
  assert.doesNotMatch(tabs, />9</)
})

test("the kill switch disables scheduling and says why", () => {
  const markup = actions(storeRow(), { syncDisabled: true })
  assert.match(markup, /自动更新已停用/)
  assert.match(markup, /disabled/)
})

test("a press inside the manual interval shows the unlock clock", () => {
  const nextAllowed = Date.now() + 9 * 60 * 1000
  const markup = actions(
    storeRow({
      manual_requested_at_ms: Date.now(),
      manual_next_allowed_at_ms: nextAllowed,
    }),
  )
  assert.match(markup, /\d{2}:\d{2} 可再次更新/)
  assert.doesNotMatch(markup, /今晚|夜间|加入同步窗口/)
})

test("sync buttons wake at each hold and cooldown deadline, then become available", () => {
  const stores = [
    storeRow({ manual_next_allowed_at_ms: NOW + 600_000 }),
    storeRow({ hold: "cooldown", hold_until_ms: NOW + 30_000, manual_next_allowed_at_ms: NOW + 90_000 }),
  ]
  assert.equal(nextScheduleUnlockAt(stores, NOW), NOW + 30_000)
  assert.equal(nextScheduleUnlockAt(stores, NOW + 30_000), NOW + 90_000)
  assert.equal(nextScheduleUnlockAt(stores, NOW + 90_000), NOW + 600_000)
  assert.equal(nextScheduleUnlockAt(stores, NOW + 600_000), null)
  assert.deepEqual(stores.map((store) => scheduleBlockedReason(store, false, NOW + 600_000)), [null, null])
})

test("立即更新 says whether the press started a walk or joined one", () => {
  assert.equal(manualSyncNotice(1, 0), "立即更新已开始")
  assert.equal(manualSyncNotice(2, 0), "已开始更新 2 家店铺")
  assert.equal(manualSyncNotice(0, 1), "已接入正在进行的同步")
  assert.equal(manualSyncNotice(0, 3), "已接入 3 家店铺正在进行的同步")
  assert.equal(manualSyncNotice(1, 1), "已开始更新 1 家店铺，1 家已接入正在进行的同步")
})

test("a clear store offers 立即更新 — the press runs now, not a nightly slot", () => {
  const markup = actions(storeRow())
  assert.match(markup, /立即更新/)
  assert.doesNotMatch(markup, /加入同步窗口|今晚|夜间/)
})

test("holds read as operator facts — scheduler jargon never reaches the page", () => {
  // 预算耗尽/冷却/退避/让路 是调度器内部词；操作员只看到「为什么」与「何时恢复」。
  const budget = actions(
    storeRow({
      hold: "budget",
      hold_reason: "budget_exhausted",
      hold_until_ms: NOW + 8 * 60 * 60 * 1000,
    }),
  )
  assert.match(budget, /今日更新次数已用完/)
  assert.doesNotMatch(budget, /预算耗尽|冷却|退避|让路|代次|熔断|同步/)

  const cooldown = actions(
    storeRow({ hold: "cooldown", hold_reason: "rate_limited", hold_until_ms: NOW + 5 * 60_000 }),
  )
  assert.match(cooldown, /更新暂停，\d{2}\/\d{2} \d{2}:\d{2} 恢复/)
  assert.doesNotMatch(cooldown, /预算耗尽|冷却至/)

  const credential = actions(storeRow({ hold: "credential", hold_reason: "credential_revoked" }))
  assert.match(credential, /密钥待复查/)
  // 非行动型 hold 不产生徽标——原因只出现在被停掉的按钮旁。
  assert.doesNotMatch(budget + cooldown, /已达上限 ·|更新暂停 ·/)
})

test("a running pass reads 更新中, not the pass machine's name", () => {
  const markup = actions(storeRow({ pass: "detail" }))
  assert.match(markup, /更新中…/)
  assert.doesNotMatch(markup, /同步中|清单同步|详情同步|对账|正在提交/)
})
test("coverage names the stores whose numbers are outside the total", () => {
  const overview: StoreProductsOverviewData = {
    totals: { total: 1, on_sale: 1, processing: 0, hidden: 0, moderation_failed: 0, zero_stock: 0, archived: 0, delisted: 0 },
    coverage: { read: 1, total: 3 },
    sync_disabled: false,
    stores: [
      storeRow({ name: "可读店", freshness: "fresh" }),
      storeRow({ name: "新店", freshness: "never", store_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      storeRow({ name: "旧店", freshness: "expired", store_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ],
  }
  const note = renderToStaticMarkup(<CoverageNote overview={overview} />)
  assert.match(note, /未计入：新店 暂无数据、旧店 失效/)
  assert.doesNotMatch(note, /可读店/)
})

function productRow(over: Partial<StoreProductRow> = {}): StoreProductRow {
  return {
    store_id: "11111111-2222-3333-4444-555555555555",
    store_name: "测试店",
    product_id: 101,
    offer_id: "A-1",
    name: "杯垫",
    sku: "7",
    state: "on_sale",
    status_name: "продается",
    price: "199.0000",
    stock_present: 3,
    stock_reserved: 1,
    gone: false,
    ...over,
  }
}

function rowMarkup(
  row: StoreProductRow,
  currency?: string | null,
  onOpen?: (row: StoreProductRow) => void,
  onToggle?: () => void,
  showStore = false,
) {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <ProductRow
          row={row}
          showStore={showStore}
          currency={currency}
          verifying={false}
          verifyDisabled={false}
          onAction={() => {}}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      </tbody>
    </table>,
  )
}

test("the compact row renders identity, store and price while the detail preserves funnel metrics", () => {
  const item = productRow({
    image_url: "https://cdn.ozon.test/p.jpg",
    metrics: {
      hits_view: 12340,
      session_view: 5678,
      hits_tocart: 42,
      conv_tocart: 7.5,
      ordered_units: 3,
      revenue: 5400,
      revenue_currency: "RUB",
      period_days: 14,
      through_day: "2026-09-25",
      fetched_at_ms: NOW,
    },
  })
  const markup = rowMarkup(item, "RUB", undefined, undefined, true)
  assert.match(markup, /src="https:\/\/cdn\.ozon\.test\/p.jpg"/)
  assert.match(markup, /A-1/)
  assert.match(markup, /https:\/\/www\.ozon\.ru\/product\/7\//)
  assert.match(markup, /测试店/)
  assert.match(markup, /199/)
  assert.doesNotMatch(markup, /12,340/)
  const detail = renderToStaticMarkup(<ProductExpand row={item} currency="RUB" />)
  assert.match(detail, /12,340/)
  assert.match(detail, /5[\s ]*400/)
  assert.match(detail, /₽/)
})

test("the row thumbnail is a focusable hover-preview trigger", () => {
  const markup = rowMarkup(productRow({ image_url: "https://cdn.ozon.test/p.jpg" }))
  assert.match(markup, /aria-label="杯垫 大图预览"/)
  const unnamed = rowMarkup(
    productRow({ name: undefined, image_url: "https://cdn.ozon.test/p.jpg" }),
  )
  assert.match(unnamed, /aria-label="商品大图预览"/)
})

test("商品名只在接上详情时变成促销入口", () => {
  assert.doesNotMatch(rowMarkup(productRow()), /打开 杯垫 的促销活动/)
  assert.match(rowMarkup(productRow(), undefined, () => {}), /aria-label="打开 杯垫 的促销活动"/)
})

test("每一行单独展开详情，不接回调时仍是单行", () => {
  assert.doesNotMatch(rowMarkup(productRow()), /展开 A-1 的详情/)
  assert.match(rowMarkup(productRow(), undefined, undefined, () => {}), /aria-expanded="false"/)
  const detail = renderToStaticMarkup(
    <ProductExpand
      row={productRow({
        metrics: {
          hits_view: 100,
          session_view: 80,
          hits_tocart: 10,
          conv_tocart: 10,
          ordered_units: 2,
          revenue: 50,
          revenue_currency: "RUB",
          period_days: 14,
          through_day: "2026-10-01",
          fetched_at_ms: NOW,
        },
      })}
      currency="RUB"
    />
  )
  assert.match(detail, /销售漏斗/)
  assert.match(detail, /近 14 天/)
  // 漏斗条形：值写在条上，口径跟在条尾。
  assert.match(detail, /aria-label="浏览 100"/)
  assert.match(detail, /aria-label="加购 10"/)
  assert.match(detail, /aria-label="出单 2"/)
  assert.match(detail, /成交/)
  assert.match(detail, /件单价比标价低 87%/)
  // 步间损耗写在两条之间；每一级只留自己独有的口径，三处不重复。
  assert.match(detail, /留下 10%，掉 90%：加购 10 次/)
  assert.match(detail, /留下 20%，掉 80%：出单 2 次/)
  assert.match(detail, /人均 1\.3 次/)
  assert.match(detail, /Ozon 口径 10%/)
  assert.match(detail, /浏览→出单 2%/)
  assert.match(detail, /出单 2 件/)
  // 步间损耗的两端不写「留下 0%，掉 100%」这种同义反复。
  const stalled = renderToStaticMarkup(
    <ProductExpand
      row={productRow({
        metrics: {
          hits_view: 58,
          session_view: 41,
          hits_tocart: 0,
          conv_tocart: 0,
          ordered_units: 0,
          revenue: 0,
          revenue_currency: "RUB",
          period_days: 14,
          through_day: "2026-10-01",
          fetched_at_ms: NOW,
        },
      })}
      currency={null}
    />,
  )
  assert.match(stalled, /一步没留下：加购 0 次/)
  assert.doesNotMatch(stalled, /留下 0%/)
  assert.doesNotMatch(detail, /促销|保存库存/)
  assert.match(rowMarkup(productRow(), undefined, () => {}), /aria-label="打开 杯垫 的促销活动"/)
  assert.match(rowMarkup(productRow()), /aria-label="修改 A-1 的库存"/)
  const empty = renderToStaticMarkup(
    <ProductExpand row={productRow({ metrics: null })} currency={null} />,
  )
  assert.match(empty, /还没有销售窗口/)
  assert.doesNotMatch(empty, />0</)
})

test("CNY 店的件单价用换算后的销售额，悬停保留卢布原文", () => {
  const detail = renderToStaticMarkup(
    <ProductExpand
      row={productRow({
        price: "90.00",
        metrics: {
          hits_view: 100,
          session_view: 80,
          hits_tocart: 10,
          conv_tocart: 10,
          ordered_units: 1,
          revenue: 500,
          revenue_currency: "RUB",
          fx_quote: "CNY",
          fx_rate: 10,
          fx_as_of: "2026-10-12",
          period_days: 14,
          through_day: "2026-10-12",
          fetched_at_ms: NOW,
        },
      })}
      currency="CNY"
    />,
  )
  assert.match(detail, /90 CNY/)
  assert.match(detail, /50 CNY/)
  assert.match(detail, /件单价比标价低 44%/)
  assert.match(detail, /1 CNY = 10 RUB/)
  assert.doesNotMatch(detail, /500 CNY/)
  const unrated = renderToStaticMarkup(
    <ProductExpand
      row={productRow({
        price: "90.00",
        metrics: {
          hits_view: 100,
          session_view: 80,
          hits_tocart: 10,
          conv_tocart: 10,
          ordered_units: 1,
          revenue: 500,
          revenue_currency: "RUB",
          period_days: 14,
          through_day: "2026-10-12",
          fetched_at_ms: NOW,
        },
      })}
      currency="CNY"
    />,
  )
  assert.match(unrated, /90 CNY/)
  assert.doesNotMatch(unrated, /500 CNY/)
  assert.doesNotMatch(unrated, /件单价比标价/)
})

function metrics(over: Partial<StoreProductMetrics> = {}): StoreProductMetrics {
  return {
    period_days: 14,
    through_day: "2026-10-01",
    fetched_at_ms: NOW,
    revenue_currency: "RUB",
    session_view: 0,
    hits_view: 0,
    hits_tocart: 0,
    conv_tocart: 0,
    ordered_units: 0,
    revenue: 0,
    ...over,
  }
}

test("判定句先认出单再认加购，不与旁边的数字自相矛盾", () => {
  assert.equal(verdictCopy(metrics()), "这个窗口没有浏览")
  // 加购 0 却出了 1 件：买家直接下单（或加购没被计入这个窗口）是真实存在的一类行，
  // 旧的顺序会在这里说「有浏览，没有加购」，和同一屏的出单数打架。
  assert.equal(
    verdictCopy(metrics({ hits_view: 49, session_view: 31, hits_tocart: 0, ordered_units: 1 })),
    "没有加购记录，却出了 1 件",
  )
  assert.equal(
    verdictCopy(metrics({ hits_view: 58, hits_tocart: 0, ordered_units: 0 })),
    "有浏览，没有加购，也没有出单",
  )
  assert.equal(verdictCopy(metrics({ hits_view: 10, hits_tocart: 3, ordered_units: 0 })), "有加购，没有出单")
  // 三步都有数时不另下结论，数字自己说明。
  assert.equal(verdictCopy(metrics({ hits_view: 10, hits_tocart: 3, ordered_units: 1 })), null)
})

test("漏斗页的拉取时间与这一行的单行读是两个时间，分开写", () => {
  const read = renderToStaticMarkup(
    <ProductExpand
      row={productRow({ refreshed_at_ms: NOW - 3_600_000, metrics: metrics({ hits_view: 5, hits_tocart: 1, ordered_units: 1, revenue: 10 }) })}
      currency={null}
    />,
  )
  assert.match(read, /漏斗拉取于/)
  assert.match(read, /本行最近一次单行读/)
  const never = renderToStaticMarkup(
    <ProductExpand
      row={productRow({ metrics: metrics({ hits_view: 5, hits_tocart: 1, ordered_units: 1, revenue: 10 }) })}
      currency={null}
    />,
  )
  assert.match(never, /本行未单独读过/)
})

test("展开行是滚动抽屉：轨道包裹内容，收起态打 data-closing", () => {
  const open = renderToStaticMarkup(
    <TableExpandedRow colSpan={10}>
      <div>详情</div>
    </TableExpandedRow>,
  )
  assert.match(open, /data-slot="table-expanded-row"/)
  assert.match(open, /colSpan="10"/)
  assert.match(open, /table-expanded-track/)
  assert.match(open, /table-expanded-clip/)
  assert.match(open, /table-expanded-inner/)
  assert.doesNotMatch(open, /data-closing/)
  const closing = renderToStaticMarkup(
    <TableExpandedRow colSpan={10} closing>
      <div>详情</div>
    </TableExpandedRow>,
  )
  assert.match(closing, /data-closing/)
})

test("行内 SKU 是指向 Ozon 商品页的外链 — 没有 SKU 就没有链接", () => {
  const markup = rowMarkup(productRow({ sku: "4467036608" }))
  assert.match(markup, /href="https:\/\/www\.ozon\.ru\/product\/4467036608\/"/)
  assert.match(markup, /target="_blank"/)
  assert.match(markup, /rel="noreferrer"/)
  assert.match(markup, /SKU：4467036608<\/a>/)
  assert.doesNotMatch(rowMarkup(productRow({ sku: null })), /ozon\.ru/)
  const long = rowMarkup(productRow({ sku: "1234567890123456789" }))
  assert.match(long, /href="https:\/\/www\.ozon\.ru\/product\/1234567890123456789\/"/)
  assert.match(long, /SKU：1234567890123456789<\/a>/)
  assert.doesNotMatch(long, /aria-label="修改 A-1 的库存"/)
})

test("a row without a funnel page reads as missing — never as zero", () => {
  const markup = rowMarkup(productRow({ image_url: null, metrics: null }))
  // No image cell invents one; no metric cell claims a zero.
  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, />0</)
  assert.match(markup, /—/)
})

test("状态芯片说中文 — Ozon 的俄文 status_name 不进页面", () => {
  const processing = rowMarkup(productRow({ state: "processing", status_name: "Готов к продаже" }))
  assert.match(processing, /处理中/)
  assert.doesNotMatch(processing, /Готов/)
  const onSale = rowMarkup(productRow())
  assert.match(onSale, /在售/)
  assert.doesNotMatch(onSale, /продается/)
})

test("价格与库存格可直接点开编辑；写不进去的行只读并说明原因", () => {
  const markup = rowMarkup(productRow({ old_price: "299.00" }))
  assert.match(markup, /aria-label="修改 A-1 的价格"/)
  assert.match(markup, /aria-label="修改 A-1 的库存"/)
  assert.match(markup, /-33%/)
  const gone = rowMarkup(productRow({ gone: true }))
  assert.doesNotMatch(gone, /修改 A-1 的价格/)
  assert.match(gone, /title="已下架的商品不能改价"/)
  assert.match(rowMarkup(productRow({ stock_present: 0 })), /售罄/)
})

test("每行只有一个「⋯」操作入口，不再平铺核实/归档按钮", () => {
  const markup = rowMarkup(productRow())
  assert.match(markup, /aria-label="A-1 的操作"/)
  assert.doesNotMatch(markup, />核实</)
  assert.doesNotMatch(markup, />归档</)
})

test("批量栏露出改价格/改库存/促销活动，其余收进「更多」", () => {
  const markup = renderToStaticMarkup(
    <SelectionActions count={3} verifyDisabled={false} onAction={() => {}} />,
  )
  assert.match(markup, /已选 3 件/)
  assert.match(markup, />改价格</)
  assert.match(markup, />改库存</)
  assert.match(markup, />促销活动</)
  assert.match(markup, />更多</)
  assert.doesNotMatch(markup, /清除选择/)
})

test("商品动作词表不包含未经验证的同款分组写入", () => {
  assert.deepEqual(Object.keys(ACTION_LABEL).sort(), [
    "archive", "delete", "price", "promotion", "stock", "unarchive", "verify",
  ])
})

test("the funnel note names the window, or the refusal when there is one", () => {
  const landed = renderToStaticMarkup(
    <FunnelNote
      metrics={{
        hits_view: 1,
        session_view: 1,
        hits_tocart: 0,
        conv_tocart: 0,
        ordered_units: 0,
        revenue: 0,
        revenue_currency: "RUB",
        period_days: 14,
        through_day: "2026-09-25",
        fetched_at_ms: NOW,
      }}
      metricsError={null}
    />,
  )
  assert.match(landed, /近 14 天 · 至 09\/25/)

  const restricted = renderToStaticMarkup(
    <FunnelNote metrics={null} metricsError="restricted" />,
  )
  assert.match(restricted, /套餐不含/)

  assert.equal(
    renderToStaticMarkup(<FunnelNote metrics={null} metricsError={null} />),
    "",
  )
})
