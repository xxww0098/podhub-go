import assert from "node:assert/strict"
import test from "node:test"
import { canRemoveWorkspaceMember } from "./workspace-screen"

const member = {
  id: 1,
  name: "成员",
  email: "member@example.invalid",
  role: "member" as const,
  status: "active" as const,
  joined_at_ms: 1,
}

test("MembersTable follows Cloud member removal projection", () => {
  assert.equal(canRemoveWorkspaceMember({ ...member, permissions: { remove: true } }, true), true)
  assert.equal(canRemoveWorkspaceMember({ ...member, permissions: { remove: false } }, true), false)
  assert.equal(canRemoveWorkspaceMember({ ...member, permissions: { remove: true } }, false), false)
  assert.equal(canRemoveWorkspaceMember(member as Parameters<typeof canRemoveWorkspaceMember>[0], true), false)
})
