import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { WorkspaceQuotaFacts } from "../src/components/workspace-quota-facts"
import { formatRole } from "../src/components/workspace-display"
import { defaultAdminScreen } from "../src/lib/admin-surface"
import { resolveRoute, routeAudienceFor } from "../src/lib/app-route"
import { platformRoleLabel } from "../src/lib/platform-role"

test("WorkspaceQuotaFacts prints 成员 and Token as used/limit, matching the operator sidebar", () => {
  const html = renderToStaticMarkup(
    <WorkspaceQuotaFacts
      seatsUsed={0}
      seats={2}
      tokensUsed={0}
      tokensMonthly={50_000}
    />,
  )

  assert.match(html, /aria-label="工作空间用量"/)
  assert.match(html, /0\/2/)
  assert.match(html, /0\/50K/)
  assert.doesNotMatch(html, /0\/2 席/)
  assert.doesNotMatch(html, /0\/50K Token/)
})

test("UsersScreen lists SuperAdmin directory members with workspace as a column", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /adminListUsers/)
  assert.match(source, /flattenDirectoryMembers/)
  assert.match(source, /filterDirectoryMembers/)
  assert.match(source, /<TableHead>姓名</)
  assert.match(source, /<TableHead>邮箱</)
  assert.match(source, /<TableHead>工作空间</)
  assert.match(source, /<TableHead>角色</)
  assert.match(source, /<TableHead>状态</)
  assert.match(source, /<TableHead>最近登录时间</)
  assert.match(source, /未加入工作空间/)
  assert.match(source, /membership_role/)
  assert.doesNotMatch(source, /无自建工作空间/)
  assert.doesNotMatch(source, /aria-expanded=\{!collapsedWorkspace\}/)
  assert.doesNotMatch(source, /工作空间 \/ 账户/)
})

test("最近登录时间列读登录戳，缺省写从未登录而不是造一个时间", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  // 列读的是后端 last_login_at，展示口径与成员/订单列表一致。
  assert.match(source, /formatDateTimeShort\(person\.last_login_at\)/)
  assert.match(source, /从未登录/)
})

test("账号列表用勾选列驱动批量停用，逐条停用并把失败交给通知", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  // 表头全选（含半选）与行勾选；选集按账户 UUID 去重，同一个人在多行同勾。
  assert.match(source, /aria-label="选择当前筛选的全部账户"/)
  assert.match(source, /indeterminate=\{!allVisibleSelected && someVisibleSelected\}/)
  assert.ok(source.includes("const selectedPeople = useMemo(() => {"))
  assert.ok(source.includes("selected={selectedUuids.has(row.person.uuid)}"))
  assert.ok(source.includes('data-state={selected ? "selected" : undefined}'))
  // 批量条只在有勾选时出现；停用只作用于仍可停用的账户，超管与自停用被挡住。
  assert.ok(source.includes("已选 {selectedPeople.length} 个账户"))
  assert.ok(source.includes("其中 {disableSelectedPeople.length} 个可停用"))
  assert.ok(
    source.includes('(person) => person.manageable && asStatus(person) === "active",'),
  )
  // 没有批量端点：确认一次后逐条停用；失败走 notifyCommandError，不写进页面。
  assert.ok(source.includes("await adminHttp.adminDisableUser({ uuid: person.uuid })"))
  assert.ok(source.includes("个账户停用失败，请刷新后重试"))
  assert.ok(source.includes("对方将无法登录；可在编辑中逐个重新启用。"))
})

test("directory summary strip prints wallet available, not Token as a monthly allowance", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /PlatformAdminSummary/)
  assert.match(source, /成员 \{focusedWorkspace\.seats_used\}/)
  assert.match(source, /余额 \{formatYuan\(focusedWorkspace\.wallet_available_microfen\)\}/)
  assert.doesNotMatch(source, /label="Token"/)
})

test("workspace roles and platform roles no longer share the word 管理员", () => {
  assert.equal(formatRole("manager"), "主管")
  assert.equal(formatRole("member"), "运营")
  assert.equal(platformRoleLabel("admin"), "平台管理员")
  // PlatformRole 的值不属于工作空间角色表，喂进去必须原样返回而不是借到标签
  for (const platformRole of ["admin", "super_admin", "user", "operator", "viewer"]) {
    assert.equal(formatRole(platformRole), platformRole)
  }
  assert.equal(formatRole(), undefined)
})

test("UsersScreen create account is a Dialog with Field labels and a toast-only failure", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<PlatformAdminDialog\b/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/sheet"/)
  assert.match(source, /<FieldLabel htmlFor="create-email">邮箱</)
  // Failure copy rides the toast host, never the create dialog DOM.
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /setCreateError/)
  assert.match(source, /notifyCommandError\(reason, "无法创建账户，请稍后重试。"\)/)
})

test("UsersScreen cannot assign super_admin from the create or edit picker", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /never `super_admin`/)
  assert.match(source, /return \["admin", "user"\]/)
  assert.doesNotMatch(source, /\["super_admin", "admin", "user"\]/)
  assert.match(source, /由服务器初始化创建/)
})

test("the unique system-created SuperAdmin is read-only, never a manageable member", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  // Row: 系统 chip + a 查看 affordance; 停用 is not rendered for the rank at all.
  assert.match(source, /admin init 一次性创建并保存在系统中/)
  assert.match(source, /isSuperAdmin \? "查看账号" : "编辑账号"/)
  assert.match(source, /isSuperAdmin \? null : \(/)
  // Dialog: nothing on an env-owned account can save; create spells the rule out.
  assert.match(source, /systemOwned \? null : \(/)
  assert.match(source, /systemOwned \? "关闭" : "取消"/)
  assert.match(source, /全局唯一，不在面板中创建/)
})

test("admin panel never grants plan seats or wallet credit — those move through 兑换码", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /EditWorkspaceQuotaDialog/)
  assert.doesNotMatch(source, /配置成员与档位/)
  assert.doesNotMatch(source, /权益与配额/)
  assert.doesNotMatch(source, /adminPreviewUserQuotas|adminApplyUserQuotas/)
  assert.doesNotMatch(source, /adminTopupWorkspaceWallet|adminRevokeWorkspaceWalletTopup|adminWorkspaceWallet/)
  assert.match(source, /assignableRoles/)
})

test("UsersScreen lets SuperAdmin delete a Workspace with exact-name confirmation", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /adminDissolveWorkspace/)
  assert.match(source, /aria-label=\{`删除工作空间 \$\{focusedWorkspace\.name\}`\}/)
  assert.match(source, /typed\.trim\(\) === workspace\?\.name/)
  assert.match(source, /confirmText="删除工作空间"/)
})

test("unaffiliated super admins still reach the users directory", () => {
  // The operator's standing is not held back by an empty Workspace roster…
  const operator = routeAudienceFor({
    authenticated: true,
    role: "super_admin",
    accountMode: "unaffiliated",
  })
  assert.equal(operator.hasWorkspace, true)
  // …and the admin surface is the URL's business, not the Workspace's, so the
  // 账号 directory stays reachable. The pane itself remains a super_admin
  // surface: the settings sheet refuses it by name for admin rank.
  assert.deepEqual(
    resolveRoute({ pathname: "/admin", search: "?settings=users" }, operator),
    { kind: "admin", screen: defaultAdminScreen(), settings: "users" },
  )
})

test("workspace table displays 档位配置, 成员配置, and 店铺配置 columns", () => {
  const source = readFileSync(
    new URL("../src/features/users/users-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<TableHead[^>]*>档位配置<\/TableHead>/)
  assert.match(source, /<TableHead[^>]*>成员配置<\/TableHead>/)
  assert.match(source, /<TableHead[^>]*>店铺配置<\/TableHead>/)
  assert.match(source, /\{storeLimit\} 家店铺/)
})
