import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { SellerRelayData } from "@/bindings/commands"
import { SellerRelayPanel } from "./seller-relay"

const base: SellerRelayData = {
  nodes: [],
  relay_route: "socks5h://seller-relay:1080",
  sidecar_managed: true,
}

test("with no node the pane asks for an import", () => {
  const html = renderToStaticMarkup(<SellerRelayPanel initialConfig={base} />)
  assert.match(html, /暂无代理节点/)
  assert.match(html, /未配置/)
  assert.match(html, /导入节点/)
  assert.match(html, /代理节点列表/)
  assert.ok(html.indexOf("导入节点") < html.indexOf("节点列表"))
  assert.doesNotMatch(html, /检测连通/)
  assert.match(html, /role="switch"[^>]*aria-disabled="true"[^>]*aria-checked="false"[^>]*aria-label="代理节点选择"/)
})

test("each node can be switched to; the one in use is marked and can be turned off", () => {
  const html = renderToStaticMarkup(
    <SellerRelayPanel
      initialConfig={{
        ...base,
        nodes: [
          { id: "a", name: "fra", address: "203.0.113.7:34567", active: true },
          { id: "b", name: "", address: "198.51.100.9:443", active: false },
        ],
      }}
    />,
  )
  assert.match(html, /使用中/)
  assert.match(html, /203\.0\.113\.7:34567/)
  assert.equal(html.match(/切换到此节点/g)?.length, 1)
  assert.match(html, /检测连通/)
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-label="代理节点选择"/)
})

test("nodes with none in use say Seller calls go direct", () => {
  const html = renderToStaticMarkup(
    <SellerRelayPanel initialConfig={{ ...base, nodes: [{ id: "b", name: "", address: "198.51.100.9:443", active: false }] }} />,
  )
  assert.match(html, /未使用代理/)
  assert.match(html, /请在下方选择节点启用/)
  assert.match(html, /role="switch"[^>]*aria-disabled="true"[^>]*aria-checked="false"/)
})

test("the pane says so when nothing it saves can take effect", () => {
  const html = renderToStaticMarkup(
    <SellerRelayPanel initialConfig={{ ...base, relay_route: null, sidecar_managed: false, nodes: [{ id: "a", name: "fra", address: "203.0.113.7:34567", active: true }] }} />,
  )
  assert.match(html, /没有列出中转/)
  assert.match(html, /没有中转容器/)
  assert.match(html, /已选择，未生效/)
  assert.doesNotMatch(html, /使用中/)
  assert.match(html, /id="seller-relay-links"[^>]*disabled/)
  assert.match(html, /role="switch"[^>]*aria-disabled="true"[^>]*aria-checked="true"/)
})
