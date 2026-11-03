import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProfitQuoteFeedback } from "./profit-quote-panel"
import { renderLibrary, sampleCard } from "../card-library-test-support"

test("a failed application shows a matching currency fence exactly once", () => {
  const issue = "方案币种 RUB 与试算币种不一致"
  const html = renderToStaticMarkup(<ProfitQuoteFeedback error={issue} applyIssue={issue} />)
  assert.equal(html.split(issue).length - 1, 1)
  assert.match(html, /role="alert"/)
})

test("distinct save and application problems remain visible; no issue adds no copy", () => {
  const html = renderToStaticMarkup(<ProfitQuoteFeedback error="保存失败，输入已保留" applyIssue="当前仅可试算" />)
  assert.match(html, /保存失败，输入已保留/)
  assert.match(html, /当前仅可试算/)
  assert.equal(renderToStaticMarkup(<ProfitQuoteFeedback error="" />), "")
})

test("the host price lock disables both price cells and the trial trigger on the same row", () => {
  const html = renderLibrary([{ ...sampleCard, price: "5.00", old_price: "200.00" }], {}, { savingPriceId: sampleCard.draft_id })
  for (const label of ["销售价 夏季T恤", "划线价 夏季T恤", "利润试算 夏季T恤"]) {
    const element = html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0]
    assert.ok(element, label)
    assert.match(element, /\bdisabled=""/, label)
  }
})
