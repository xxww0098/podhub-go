import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierAccountsGroup } from "@/bindings/http-supplier-portal"
import { filterSupplierGroups, isConfirmedResetRefusal, mergeSupplierGroups, SupplierAccountsReadNotice, SupplierAccountsScreen } from "./admin-supplier-accounts-screen"
import type { Factory } from "@/bindings/http-factories"

const factory = { factory_id: "factory-test", name: "测试厂家", country: "CN", icon: "" }
const groups: SupplierAccountsGroup[] = [{ factory, members: [{
  member_id: "member-test", account_uuid: "factory-account", factory, email: "factory@example.invalid", name: "厂家成员",
  status: "active", created_at_ms: 1,
}] }]

function notice(overrides: Partial<Parameters<typeof SupplierAccountsReadNotice>[0]> = {}) {
  return renderToStaticMarkup(<SupplierAccountsReadNotice failed={false} refreshing={false} onRetry={() => {}} {...overrides} />)
}

test("the initial screen offers a read retry while factory creation waits for both lists", () => {
  const html = renderToStaticMarkup(<SupplierAccountsScreen overview={{
    session: { authenticated: true, email: "admin@example.invalid", role: "super_admin" },
    owned_count: 0, owned_limit: 3, workspaces: [],
  }} />)
  assert.match(html, /aria-label="刷新工厂管理"/)
  const create = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes('aria-label="新增工厂"'))
  assert.ok(create, "the create button carries its name as aria-label")
  assert.match(create, / disabled=""/)
  assert.match(html, /正在读取工厂管理/)
  assert.doesNotMatch(html, /还没有工厂/)
})

test("ordinary administrators do not see the super-admin-only creation action", () => {
  const html = renderToStaticMarkup(<SupplierAccountsScreen overview={{
    session: { authenticated: true, email: "admin@example.invalid", role: "admin" },
    owned_count: 0, owned_limit: 3, workspaces: [],
  }} />)
  assert.doesNotMatch(html, /aria-label="开通厂家成员/)
  assert.doesNotMatch(html, /aria-label="新增工厂"/)
})

test("an unknown supplier-account list stays loading without claiming there are no members", () => {
  const html = notice()
  assert.match(html, /正在读取工厂管理/)
  assert.doesNotMatch(html, /还没有工厂|重新读取/)
})

test("a failed first read or failed refresh of an empty list asks for retry instead of creating members", () => {
  for (const previous of [undefined, []]) {
    const html = notice({ groups: previous, failed: true })
    assert.match(html, /工厂管理未能读取/)
    assert.match(html, /暂时无法确认工厂和成员/)
    assert.match(html, /重新读取/)
    assert.doesNotMatch(html, /还没有工厂|正在读取工厂管理/)
    assert.doesNotMatch(html, /disabled=/)
  }
})

test("a failed refresh identifies previous records and keeps the retry busy until it finishes", () => {
  const html = notice({ groups, failed: true, refreshing: true })
  assert.match(html, /工厂管理刷新失败/)
  assert.match(html, /以下为上次读取的记录/)
  assert.match(html, /aria-label="正在重新读取"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /disabled=/)
  assert.doesNotMatch(html, /还没有工厂|暂时无法确认/)
})

test("only successfully loaded empty lists show the invitation to create a factory", () => {
  const html = notice({ groups: [] })
  assert.match(html, /还没有工厂。新增工厂后可以开通成员账号/)
  for (const column of ["成员邮箱", "名称", "状态", "开通时间", "操作"]) assert.match(html, new RegExp(column))
  assert.equal(notice({ groups }), "")
})

test("factory groups include factories without accounts", () => {
  const makeFactory = (factory_id: string, name: string): Factory => ({ factory_id, name, country: "CN", icon: "", contact: "", internal_note: "", created_at_ms: 1, updated_at_ms: 1, libraries: [] })
  const factories = [makeFactory("factory-test", "新工厂名"), makeFactory("empty", "尚无成员")]
  const merged = mergeSupplierGroups(factories, groups)
  assert.deepEqual(merged.map((group) => [group.factory.factory_id, group.factory.name, group.members.length]), [
    ["factory-test", "新工厂名", 1], ["empty", "尚无成员", 0],
  ])
  assert.deepEqual(filterSupplierGroups(merged, "尚无成员").map((group) => group.factory.factory_id), ["empty"])
})

test("search matches the factory or individual member without altering the source list", () => {
  const other = { ...groups[0]!.members[0]!, member_id: "other", email: "other@example.invalid", name: "另一个成员" }
  const sourceGroups = [{ ...groups[0]!, members: [...groups[0]!.members, other] }]
  assert.equal(filterSupplierGroups(sourceGroups, "  测试厂家  ")[0]?.members.length, 2)
  assert.deepEqual(filterSupplierGroups(sourceGroups, "FACTORY@")[0]?.members.map((member) => member.member_id), ["member-test"])
  assert.deepEqual(filterSupplierGroups(sourceGroups, "另一个")[0]?.members.map((member) => member.member_id), ["other"])
  assert.deepEqual(filterSupplierGroups(sourceGroups, "没有匹配"), [])
  assert.equal(sourceGroups[0]?.members.length, 2)
})

test("only a matching, explicit pre-write refusal permits retrying a password reset", () => {
  assert.equal(isConfirmedResetRefusal({ code: "cloud_validation", serverCode: "validation", status: 400, message: "密码过长", remediation: null }), true)
  assert.equal(isConfirmedResetRefusal({ code: "cloud_writes_disabled", serverCode: "writes_disabled", status: 503, message: "写入已关闭", remediation: null }), true)
  for (const reason of [
    new TypeError("network lost"),
    { code: "cloud_unavailable" },
    { code: "cloud_bad_response", status: 400 },
    { code: "cloud_internal", serverCode: "internal", status: 500, message: "内部错误", remediation: null },
    { code: "cloud_validation", serverCode: "validation", status: 400, message: "云端未确认本次操作结果（HTTP 400）", remediation: "不要重复提交" },
    { code: "unauthenticated", serverCode: "auth_invalid", status: 401, message: "云端请求失败（HTTP 401）", remediation: null },
  ]) assert.equal(isConfirmedResetRefusal(reason), false)
})
