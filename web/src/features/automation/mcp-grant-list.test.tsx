import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AutomationGrant } from "@/bindings/http-automation-grants"
import { McpGrantList } from "./mcp-grant-list"

test("令牌列表显示真实权限、创建时间和过期状态，隐藏已撤销记录", () => {
  const grant: AutomationGrant = {
    id: "active", name: "工作助手", token_prefix: "opa_test…", created_at_ms: 1700000000000,
    actions: ["supplier:read"], scopeKind: "supplier_catalog", sourceIds: null,
    expiresAtMs: 4102444800000, lastUsedAtMs: null,
  }
  const html = renderToStaticMarkup(<McpGrantList
    grants={[grant, { ...grant, id: "expired", name: "已过期令牌", expiresAtMs: 1 }, { ...grant, id: "revoked", name: "已撤销令牌", revokedAtMs: 1 }]}
    loading={false} failed={false} busy={false} onRefresh={() => {}} onRevoke={async () => {}}
  />)
  assert.match(html, /名称.*权限范围.*创建时间.*状态.*操作/)
  assert.match(html, /工作助手/)
  assert.match(html, /读取供应商资料/)
  assert.match(html, /所有源库/)
  assert.match(html, /有效/)
  assert.match(html, /已过期/)
  assert.match(html, /aria-label="删除令牌 工作助手"/)
  assert.doesNotMatch(html, /已撤销令牌/)
  assert.ok(html.includes(new Date(grant.created_at_ms).toLocaleString()))
})

test("令牌列表保留空表头，读取失败时不显示空数据结论", () => {
  const render = (failed: boolean) => renderToStaticMarkup(<McpGrantList
    grants={[]} loading={false} failed={failed} busy={false} onRefresh={() => {}} onRevoke={async () => {}}
  />)
  assert.match(render(false), /名称.*权限范围.*创建时间.*状态.*操作/)
  assert.match(render(false), /暂无令牌/)
  assert.match(render(true), /重新读取令牌/)
  assert.doesNotMatch(render(true), /暂无令牌|当前还没有申请/)
})
