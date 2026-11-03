import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PromotionChangeForm, type PromotionTarget } from "./promotion-change-dialog"

function target(type: string, freeze = ""): PromotionTarget {
  return {
    storeId: "00000000-0000-4000-8000-000000000001", storeName: "验收店铺",
    action: { action_id: 1, title: "活动", action_type: type, date_start: "", date_end: "", freeze_date: freeze, is_participating: true, eligible_selected: 1, participating_selected: 1, potential_products_total: 1, participating_products_total: 1 },
    offers: [],
  }
}
const noop = () => {}
test("unverified activity families expose no write controls", () => {
  for (const type of ["PROMOCODE", "STOCK_DISCOUNT", "UNKNOWN"]) {
    const html = renderToStaticMarkup(<PromotionChangeForm target={target(type)} onClose={noop} onApplied={noop} onBusy={noop} />)
    assert.ok(html.includes("Ozon 卖家后台"))
    assert.ok(!html.includes("确认加入") && !html.includes("目标活动价"))
  }
})
test("a reported freeze blocks confirmation even when its date is in the future", () => {
  const html = renderToStaticMarkup(<PromotionChangeForm target={target("ELASTIC_BOOSTING", "2099-01-01T00:00:00Z")} onClose={noop} onApplied={noop} onBusy={noop} />)
  assert.ok(html.includes("活动已冻结，暂不能在此修改"))
  assert.match(html, /disabled[^>]*>确认加入 \/ 改价/)
})
