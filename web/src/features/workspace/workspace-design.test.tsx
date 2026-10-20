import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MembersTable } from "./workspace-screen"

const member = {
  id: 1,
  name: "成员",
  email: "member@example.invalid",
  role: "member" as const,
  status: "active" as const,
  joined_at_ms: 1,
}

test("MembersTable follows Cloud member removal projection", () => {
  const legacyMember = { ...member } as Parameters<typeof MembersTable>[0]["members"][number]
  const allowed = renderToStaticMarkup(
    <MembersTable
      members={[{ ...member, permissions: { remove: true } }]}
      loading={false}
      onOpen={() => {}}
      onExit={() => {}}
    />,
  )
  const denied = renderToStaticMarkup(
    <MembersTable
      members={[{ ...member, permissions: { remove: false } }]}
      loading={false}
      onOpen={() => {}}
      onExit={() => {}}
    />,
  )
  const noRosterPermission = renderToStaticMarkup(
    <MembersTable
      members={[{ ...member, permissions: { remove: true } }]}
      loading={false}
      onOpen={() => {}}
    />,
  )
  const missingPermissions = renderToStaticMarkup(
    <MembersTable
      members={[legacyMember]}
      loading={false}
      onOpen={() => {}}
      onExit={() => {}}
    />,
  )

  assert.match(allowed, /将 member@example\.invalid 移出工作空间/)
  assert.doesNotMatch(denied, /移出工作空间/)
  assert.doesNotMatch(noRosterPermission, /移出工作空间/)
  assert.doesNotMatch(missingPermissions, /移出工作空间/)
})
