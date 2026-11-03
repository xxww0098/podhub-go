import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicSite } from "./public-site"

test("product page keeps working access links without removed public pages", () => {
  const html = renderToStaticMarkup(<PublicSite />)
  assert.match(html, /把设计稿做成能上架的商品/)
  assert.match(html, /为 Ozon 按需印刷准备商品/)
  assert.match(html, /href="\/login"/)
  assert.match(html, /href="\/supplier"/)
  assert.match(html, />登录工作台</)
  assert.match(html, /aria-label="产品页导航"/)
  assert.doesNotMatch(html, /href="\/(?:catalog|pricing|help|privacy|terms)(?:\/|\?|#|")/)
  assert.doesNotMatch(html, />定价<|>帮助<|隐私声明|使用条款|发布前公布价格/)
})

test("page anchors target real sections and main content can receive focus", () => {
  const html = renderToStaticMarkup(<PublicSite />)
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1])
  assert.ok(anchors.includes("products"))
  assert.ok(anchors.includes("workflow"))
  assert.ok(anchors.includes("main-content"))
  for (const anchor of anchors) assert.ok(ids.has(anchor), `missing anchor: ${anchor}`)
  assert.match(html, /<main id="main-content" tabindex="-1">/)
})

test("product examples and submission copy do not imply confirmed sales", () => {
  const html = renderToStaticMarkup(<PublicSite />)
  assert.equal((html.match(/<figure>/g) ?? []).length, 3)
  assert.match(html, /商品效果示例/)
  assert.match(html, /先预览再提交/)
  assert.match(html, /店铺凭证不落在浏览器/)
  assert.match(html, /提交后核对平台处理结果/)
  assert.match(html, /不确定的状态会明确标记/)
  assert.doesNotMatch(html, /提交即写入线上店铺|即可上架|商品已在售|免费注册|购物车|Execution Plan|Result Unknown|Reconciliation/)
})
