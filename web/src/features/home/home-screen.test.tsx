import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { overview } from "../../../tests/account-fixtures"
import { HomeScreen } from "./home-screen"

test("home does not turn unread metrics into zero or demo data", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={overview} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /正在读取待核对结果/)
  assert.match(html, /正在读取上架方案/)
  assert.match(html, /近 7 日上架提交/)
  assert.match(html, /平台受理不代表商品已在售；/)
  assert.match(html, />—</)
  assert.doesNotMatch(html, /Mountain Life|Good Vibes/)
})

test("home keeps one flat status bar and paints no unread success", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={overview} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /aria-label="上架核对状态"/)
  assert.doesNotMatch(html, /#375ff2|#0f172a|#1e5ce0/)
  assert.doesNotMatch(html, /bg-st-good/)
  assert.doesNotMatch(html, /建议处理的任务|home-attention/)
})

test("home names the catalog action and does not submit an empty search", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={overview} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /从商品库添加/)
  assert.doesNotMatch(html, /aria-label="从平台商品库添加商品"/)
  assert.match(html, /aria-label="打开所选功能"[^>]*disabled/)
})

test("home asks for a workspace before displaying data", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={{ ...overview, active_workspace: undefined }} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /选择工作空间后查看上架概况/)
  assert.match(html, /请先创建或选择工作空间/)
})
