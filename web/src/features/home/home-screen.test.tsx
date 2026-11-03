import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { overview } from "../../../tests/account-fixtures"
import { HomeScreen } from "./home-screen"

test("home does not turn unread metrics into zero or demo data", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={overview} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /正在读取上架概况/)
  assert.match(html, /正在读取上架方案/)
  assert.match(html, /近 7 日上架提交/)
  assert.match(html, />—</)
  assert.doesNotMatch(html, /Mountain Life|Good Vibes/)
})

test("home asks for a workspace before displaying data", () => {
  const html = renderToStaticMarkup(<HomeScreen overview={{ ...overview, active_workspace: undefined }} onNavigate={() => {}} onOpenListingCard={() => {}} />)
  assert.match(html, /选择工作空间后查看上架概况/)
  assert.match(html, /请先创建或选择工作空间/)
})
