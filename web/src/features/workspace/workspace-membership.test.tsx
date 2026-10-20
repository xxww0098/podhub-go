import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  WorkspaceInvitationCreatedView,
  WorkspaceInvitationView,
  WorkspaceStandingView,
} from "@/bindings/commands"
import { createWorkspaceRefusal } from "@/components/workspace-switcher"
import { NoWorkspaceScreen } from "./no-workspace-screen"
import {
  DissolveWorkspaceAction,
  LeaveWorkspaceAction,
  SuspendedWorkspaceExits,
  InvitationsTable,
  MemberRoleAdjuster,
  MembersTable,
  invitationOutcome,
} from "./workspace-screen"

const created: WorkspaceInvitationCreatedView = {
  uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
  token: "a".repeat(42) + "A",
  email: "invitee@example.invalid",
  role: "member",
  expires_at_ms: 1_760_000_000_000,
  pending_used: 1,
  pending_limit: 5,
  notified: true,
}

const invitationRow: WorkspaceInvitationView = {
  id: 7,
  uuid: created.uuid,
  email: created.email,
  role: "member",
  invited_by_email: "owner@example.invalid",
  created_at_ms: 1_755_000_000_000,
  expires_at_ms: created.expires_at_ms,
}

const membershipRow = {
  id: 12,
  name: "已在册成员",
  email: "member@example.invalid",
  role: "manager" as const,
  status: "active" as const,
  joined_at_ms: 1_750_000_000_000,
  permissions: { remove: true },
}

const standing: WorkspaceStandingView = {
  workspaces: [],
  account_mode: "unaffiliated",
  owned_count: 0,
  owned_limit: 3,
}

test("invitation outcome does not depend on whether the address already has an account", () => {
  const held = invitationOutcome({ ...created, notified: false })
  const delivered = invitationOutcome(created)

  assert.deepEqual(held, delivered)
  assert.match(held.description, /invitee@example\.invalid/)
  assert.match(held.description, /浏览器登录/)
  assert.match(held.description, /通知列表/)
  assert.match(held.description, /注册后/)
  assert.doesNotMatch(held.description, /Desktop/)
  assert.match(held.description, /私密链接只发给/)
  assert.match(held.description, /确认工作空间与权限再接受/)
  assert.doesNotMatch(`${held.title} ${held.description}`, new RegExp(created.token))
})

test("成员表只移除成员，邀请的痕迹一点都不留", () => {
  const html = renderToStaticMarkup(
    <MembersTable
      members={[membershipRow]}
      loading={false}
      onOpen={() => {}}
      onExit={() => {}}
    />
  )

  assert.match(html, /aria-label="将 member@example\.invalid 移出工作空间"/)
  assert.doesNotMatch(html, /撤销|邀请|有效期/)
})

test("邀请表撤销邀请，并列出邀请人和有效期", () => {
  const html = renderToStaticMarkup(
    <InvitationsTable invitations={[invitationRow]} loading={false} onRevoke={() => {}} />
  )

  assert.match(html, /aria-label="撤销 invitee@example\.invalid 的邀请"/)
  assert.match(html, /owner@example\.invalid/)
  assert.doesNotMatch(html, /移出工作空间/)
})

test("两种停用读得出区别：人为停的，和名额不够被挤下去的", () => {
  const html = renderToStaticMarkup(
    <MembersTable
      members={[
        {
          ...membershipRow,
          id: 21,
          email: "manual@example.invalid",
          status: "manual_disabled" as const,
        },
        {
          ...membershipRow,
          id: 22,
          email: "quota@example.invalid",
          status: "quota_suspended" as const,
        },
      ]}
      loading={false}
      onOpen={() => {}}
    />
  )

  assert.match(html, /已停用 · 超出成员名额/)
  // 人为停用那行不能也说「超出成员名额」，否则运营分不清该恢复权限还是该加购名额。
  assert.equal(html.split("超出成员名额").length - 1, 1)
})

test("the owner row and the signed-in account itself are never removable", () => {
  const html = renderToStaticMarkup(
    <MembersTable
      members={[
        { ...membershipRow, id: 1, role: "owner" as const, email: "owner@example.invalid", permissions: { remove: false } },
        { ...membershipRow, permissions: { remove: false } },
      ]}
      loading={false}
      onOpen={() => {}}
      onExit={() => {}}
    />
  )

  assert.doesNotMatch(html, /移出工作空间/)
})

test("dissolve sits with the owner actions and names its cost in the confirm copy", () => {
  const html = renderToStaticMarkup(
    <DissolveWorkspaceAction workspaceName="星河工坊" onDissolved={() => {}} />
  )
  const source = readFileSync(new URL("./workspace-screen.tsx", import.meta.url), "utf8")

  assert.match(html, /解散工作空间/)
  assert.doesNotMatch(html, /注销/)
  // The dialog is closed in static markup, so the cost copy is asserted at its source.
  assert.match(source, /解散后无法恢复。[^"]*创建者的钱包余额保留/)
})

test("leaving names what the member loses and asks only once", () => {
  const html = renderToStaticMarkup(<LeaveWorkspaceAction workspaceName="星河工坊" onLeft={() => {}} />)
  const source = readFileSync(new URL("./workspace-screen.tsx", import.meta.url), "utf8")

  assert.match(html, /离开工作空间/)
  // The dialog is closed in static markup, so the copy is asserted at its source.
  assert.match(source, /离开后立即失去该工作空间的店铺和数据访问权限[^"]*仍归工作空间所有/)
  // A re-invitation undoes leaving, so it never asks for the typed Workspace name.
  const tail = source.slice(source.indexOf("function LeaveWorkspaceAction"))
  assert.doesNotMatch(tail.slice(0, tail.indexOf("\n/**")), /Field|Input/)
})

test("the degraded shell names each suspended Workspace instead of guessing one", () => {
  const single = renderToStaticMarkup(
    <SuspendedWorkspaceExits
      workspaces={[{ id: 7, name: "星河工坊" }]}
      onLeft={() => {}}
    />,
  )
  const several = renderToStaticMarkup(
    <SuspendedWorkspaceExits
      workspaces={[
        { id: 7, name: "星河工坊" },
        { id: 9, name: "北岸选品" },
      ]}
      onLeft={() => {}}
    />,
  )
  const fallback = renderToStaticMarkup(
    <SuspendedWorkspaceExits workspaces={[]} onLeft={() => {}} />,
  )

  // Static markup renders only the action row, so the named leave is pinned at
  // its source: one LeaveWorkspaceAction per unusable seat, each carrying the
  // seat's id.
  const source = readFileSync(new URL("./workspace-screen.tsx", import.meta.url), "utf8")
  const section = source.slice(
    source.indexOf("export function SuspendedWorkspaceExits"),
    source.indexOf("/**\n * Leaving asks once"),
  )
  assert.match(section, /workspaces\.map\(\(workspace\) =>/)
  assert.match(section, /workspaceId=\{workspace\.id\}/)
  assert.match(section, /请选择要离开哪一个/)
  assert.match(single + several, /离开工作空间/)
  // An empty list keeps the no-target fallback so a stale overview never
  // strands the member.
  assert.match(fallback, /离开工作空间/)
})

test("members table offers copy and view detail actions on all member rows", () => {
  const html = renderToStaticMarkup(
    <MembersTable members={[membershipRow]} loading={false} onOpen={() => {}} />
  )

  assert.match(html, /aria-label="复制 member@example\.invalid"/)
  assert.match(html, /aria-label="查看 已在册成员 的详情"/)
})

test("a role that may not manage the roster sees neither revoke nor remove", () => {
  const roster = renderToStaticMarkup(
    <MembersTable members={[membershipRow]} loading={false} onOpen={() => {}} />
  )
  const pending = renderToStaticMarkup(
    <InvitationsTable invitations={[invitationRow]} loading={false} />
  )

  assert.doesNotMatch(roster, /移出工作空间/)
  assert.doesNotMatch(pending, /撤销/)
})

test("the role adjuster sizes itself by changeRoles and hides save until the draft differs", () => {
  const html = renderToStaticMarkup(
    <MemberRoleAdjuster
      member={{ ...membershipRow, role: "member", permissions: { remove: true, change_roles: ["manager"] } }}
      onChangeRole={() => Promise.resolve(true)}
    />
  )

  assert.match(html, /调整角色/)
  assert.match(html, /仅所有者可调整/)
  // Both the current role and the assignable one render as options; static
  // markup cannot flip the radio, so the save button's hidden start state is
  // what this can pin.
  assert.match(html, /value="manager"/)
  assert.match(html, /value="member"/)
  assert.doesNotMatch(html, /保存角色/)
})

test("rows without changeRoles — no grant, the Owner row, a non-managing session — render no adjuster", () => {
  const plain = renderToStaticMarkup(
    <MemberRoleAdjuster
      member={{ ...membershipRow, permissions: { remove: true } }}
      onChangeRole={() => Promise.resolve(true)}
    />
  )
  const ownerRow = renderToStaticMarkup(
    <MemberRoleAdjuster
      member={{ ...membershipRow, role: "owner", permissions: { remove: false, change_roles: [] } }}
      onChangeRole={() => Promise.resolve(true)}
    />
  )
  const notManager = renderToStaticMarkup(
    <MemberRoleAdjuster
      member={{ ...membershipRow, permissions: { remove: false, change_roles: ["manager"] } }}
    />
  )

  assert.equal(plain, "")
  assert.equal(ownerRow, "")
  assert.equal(notManager, "")
})

test("a member holding someone else's seat may still self-create Workspaces", () => {
  assert.equal(
    createWorkspaceRefusal({ ...standing, account_mode: "member" }),
    undefined
  )
  // Only the owned-Workspace cap refuses, and it names the real way out —
  // dissolving an owned Workspace frees a slot.
  const refusal = createWorkspaceRefusal({
    ...standing,
    account_mode: "member",
    owned_count: 3,
    owned_limit: 3,
  })
  assert.ok(refusal)
  assert.match(refusal, /已达上限（3\/3）/)
  assert.match(refusal, /解散/)
})

test("the cap is three free Workspaces: paying never enters the refusal", () => {
  const refusal = createWorkspaceRefusal({
    ...standing,
    account_mode: "owner",
    owned_count: 3,
    owned_limit: 3,
  })

  assert.ok(refusal)
  assert.match(refusal, /已达上限（3\/3）/)
  // The menu item is disabled, so Cloud's own WORKSPACE_LIMIT_REACHED sentence is
  // never reached: this line is the only place the next step can be said —
  // dissolving an owned Workspace frees a slot, another email is the other way.
  assert.match(refusal, /解散/)
  assert.match(refusal, /另一个邮箱|换一个邮箱/)
  assert.doesNotMatch(refusal, /加购|升级/)
})

test("an owner below three and an unaffiliated account may create a Workspace", () => {
  assert.equal(createWorkspaceRefusal(standing), undefined)
  // A free Workspace under the cap creates another free one — no purchase asked.
  assert.equal(
    createWorkspaceRefusal({
      ...standing,
      account_mode: "owner",
      owned_count: 1,
      owned_limit: 3,
    }),
    undefined
  )
  assert.equal(
    createWorkspaceRefusal({
      ...standing,
      account_mode: "owner",
      owned_count: 2,
      owned_limit: 3,
    }),
    undefined
  )
})

test("the no-Workspace screen offers both a Workspace name field and the wait-for-invitation path", () => {
  const html = renderToStaticMarkup(
    <NoWorkspaceScreen email="new@example.invalid" onCreated={() => {}} />
  )

  assert.match(html, /工作空间名称/)
  assert.match(html, /maxlength="64"/i)
  assert.match(html, /创建工作空间/)
  assert.match(html, /等待邀请/)
  assert.match(html, /new@example\.invalid/)
  assert.match(html, /通知列表/)
  assert.doesNotMatch(html, /令牌|邀请码|失败/)
})
